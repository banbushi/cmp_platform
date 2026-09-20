'use strict';

const https  = require('https');
const http   = require('http');
const crypto = require('crypto');

/**
 * HTTP Signatures (RFC draft-cavage-http-signatures)
 * WWW-Authenticate: Signature realm="api",headers="(request-target) date"
 *
 * 签名字符串：
 *   "(request-target): {method} {path}\ndate: {date}"
 * Authorization:
 *   Signature keyId="{keyId}",algorithm="hmac-sha256",headers="(request-target) date",signature="{base64}"
 */
function buildAuthHeader(keyId, keySecret, method, reqPath) {
  const date = new Date().toUTCString();
  const requestTarget = `${method.toLowerCase()} ${reqPath}`;
  const signingString = `(request-target): ${requestTarget}\ndate: ${date}`;
  const signature = crypto
    .createHmac('sha256', keySecret)
    .update(signingString)
    .digest('base64');
  const authorization =
    `Signature keyId="${keyId}",algorithm="hmac-sha256",` +
    `headers="(request-target) date",signature="${signature}"`;
  return { 'Date': date, 'Authorization': authorization };
}

/**
 * JumpServer API 请求封装
 * @param {string} baseUrl   JumpServer 实例地址，如 https://jumpserver.example.com
 * @param {string} keyId     Access Key ID
 * @param {string} keySecret Access Key Secret
 * @param {string} method    GET / POST / DELETE / PATCH
 * @param {string} path      API 路径，如 /api/v1/users/users/
 * @param {object} [body]    请求体（POST/PATCH 时传）
 */
// 单次请求（带超时）。ECONNRESET / socket hang up / 超时 等瞬时网络错误由外层重试处理。
function _jumpserverRequestOnce(baseUrl, keyId, keySecret, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      const base = baseUrl.endsWith('/') ? baseUrl : baseUrl + '/';
      const rel  = path.startsWith('/') ? path.slice(1) : path;
      url = new URL(rel, base);
    } catch (e) {
      return reject(new Error(`Invalid JumpServer URL: baseUrl="${baseUrl}", path="${path}"`));
    }
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        ...buildAuthHeader(keyId, keySecret, method, url.pathname + url.search),
        'Content-Type': 'application/json',
        'Accept':       'application/json',
        'Connection':   'close',   // 避免 keep-alive 连接被服务端回收后复用导致 ECONNRESET
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, data: parsed });
          } else {
            const wwwAuth = res.headers['www-authenticate'] || '';
            const hint = wwwAuth ? ` | WWW-Authenticate: ${wwwAuth}` : '';
            reject(new Error(`JumpServer API ${res.statusCode} [${method} ${url.href}]: ${JSON.stringify(parsed)}${hint}`));
          }
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`JumpServer 请求超时（${timeoutMs}ms）[${method} ${url.href}]`));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// 判断是否为可重试的瞬时网络错误
function _isTransientNetErr(err) {
  const code = err && err.code;
  if (code && ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'EPIPE'].includes(code)) return true;
  const msg = (err && err.message) || '';
  return /socket hang up|请求超时|network|ECONNRESET/i.test(msg);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 对外的请求封装：带超时 + 瞬时网络错误自动重试（指数退避）
async function jumpserverRequest(baseUrl, keyId, keySecret, method, path, body, opts = {}) {
  const timeoutMs = opts.timeoutMs || 15000;
  const maxRetries = opts.maxRetries != null ? opts.maxRetries : 2;  // 共 3 次尝试
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await _jumpserverRequestOnce(baseUrl, keyId, keySecret, method, path, body, timeoutMs);
    } catch (e) {
      lastErr = e;
      // 仅对瞬时网络错误重试；HTTP 4xx/5xx 业务错误直接抛出
      if (attempt < maxRetries && _isTransientNetErr(e)) {
        const backoff = 500 * Math.pow(2, attempt);  // 500ms, 1s
        console.warn(`[jumpserver] 请求失败(${e.code || e.message})，${backoff}ms 后重试 (第 ${attempt + 1}/${maxRetries} 次)`);
        await sleep(backoff);
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * 创建 JumpServer 用户
 * @param {object} cred  { region: baseUrl, access_key: keyId, secret_key: keySecret }
 */
async function createJumpServerUser(cred, username, email, name, password) {
  try {
    const { region: baseUrl, access_key: keyId, secret_key: keySecret } = cred;
    if (!baseUrl || !keyId || !keySecret) {
      return { success: false, message: 'JumpServer 配置不完整（URL、Access Key ID 或 Secret 为空）' };
    }

    // 1. 检查用户是否已存在
    try {
      const existing = await jumpserverRequest(baseUrl, keyId, keySecret, 'GET', `/api/v1/users/users/?username=${encodeURIComponent(username)}`);
      const results = existing.data?.results || (Array.isArray(existing.data) ? existing.data : []);
      if (results.some(u => u.username === username)) {
        return { success: false, message: `JumpServer 用户 ${username} 已存在，跳过创建` };
      }
    } catch (e) {
      console.warn('[jumpserver] 查询用户列表失败:', e.message);
    }

    // 2. 创建用户
    console.log(`[jumpserver] 创建用户 ${username}，密码长度: ${password?.length || 0}`);
    const res = await jumpserverRequest(baseUrl, keyId, keySecret, 'POST', '/api/v1/users/users/', {
      username,
      name:      name || username,
      email,
      password,
      password_strategy: 'custom',  // 明确指定使用自定义密码策略
      source:    'local',
      is_active: true,
    });

    const user = res.data || {};
    console.log(`[jumpserver] 用户 ${username} 创建成功，返回 userId: ${user.id || 'N/A'}`);
    return {
      success: true,
      message: `JumpServer 用户 ${username} 创建成功`,
      userId:  user.id || '',
    };
  } catch (err) {
    if (err.message && err.message.includes('409')) {
      return { success: false, message: `JumpServer 用户 ${username} 已存在` };
    }
    return { success: false, message: `JumpServer 错误: ${err.message}` };
  }
}

/**
 * 删除 JumpServer 用户
 * @param {object} cred  { region: baseUrl, access_key: keyId, secret_key: keySecret }
 */
async function deleteJumpServerUser(cred, username) {
  try {
    const { region: baseUrl, access_key: keyId, secret_key: keySecret } = cred;
    if (!baseUrl || !keyId || !keySecret) {
      return { success: false, message: 'JumpServer 配置不完整，跳过删除' };
    }

    const listRes = await jumpserverRequest(baseUrl, keyId, keySecret, 'GET', `/api/v1/users/users/?username=${encodeURIComponent(username)}`);
    const results = listRes.data?.results || (Array.isArray(listRes.data) ? listRes.data : []);
    const user = results.find(u => u.username === username);

    if (!user) {
      return { success: true, message: `JumpServer 用户 ${username} 不存在，无需删除` };
    }

    await jumpserverRequest(baseUrl, keyId, keySecret, 'DELETE', `/api/v1/users/users/${user.id}/`);
    return { success: true, message: `JumpServer 用户 ${username} 已删除` };
  } catch (err) {
    if (err.message && err.message.includes('404')) {
      return { success: true, message: `JumpServer 用户 ${username} 不存在，无需删除` };
    }
    return { success: false, message: `JumpServer 删除失败: ${err.message}` };
  }
}

/**
 * 重置 JumpServer 用户密码
 * @param {object} cred      { region: baseUrl, access_key: keyId, secret_key: keySecret }
 * @param {string} username  用户名
 * @param {string} newPassword 新密码
 */
async function resetJumpServerPassword(cred, username, newPassword) {
  try {
    const { region: baseUrl, access_key: keyId, secret_key: keySecret } = cred;
    if (!baseUrl || !keyId || !keySecret) {
      return { success: false, message: 'JumpServer 配置不完整' };
    }

    // 1. 查找用户 ID
    const listRes = await jumpserverRequest(baseUrl, keyId, keySecret, 'GET', `/api/v1/users/users/?username=${encodeURIComponent(username)}`);
    const results = listRes.data?.results || (Array.isArray(listRes.data) ? listRes.data : []);
    const user = results.find(u => u.username === username);

    if (!user) {
      return { success: false, message: `JumpServer 用户 ${username} 不存在，无法重置密码` };
    }

    // 2. PATCH 更新密码
    await jumpserverRequest(baseUrl, keyId, keySecret, 'PATCH', `/api/v1/users/users/${user.id}/`, {
      password: newPassword,
      password_strategy: 'custom',
    });

    return { success: true, message: `JumpServer 用户 ${username} 密码已重置` };
  } catch (err) {
    return { success: false, message: `JumpServer 密码重置失败: ${err.message}` };
  }
}

module.exports = { jumpserverRequest, createJumpServerUser, deleteJumpServerUser, resetJumpServerPassword, listJumpServerResource, createJumpServerAsset, createAssetPermission };

async function listJumpServerResource(cred, apiPath, page, pageSize, search) {
  const { region: baseUrl, access_key: keyId, secret_key: keySecret } = cred;
  if (!baseUrl || !keyId || !keySecret) throw new Error('JumpServer 配置不完整');
  const offset = (page - 1) * pageSize;
  let qs = `?limit=${pageSize}&offset=${offset}`;
  if (search) qs += `&search=${encodeURIComponent(search)}`;
  const res = await jumpserverRequest(baseUrl, keyId, keySecret, 'GET', apiPath + qs);
  const data = res.data || {};
  return { items: data.results || [], total: data.count || 0 };
}

async function createJumpServerAsset(cred, { hostname, ip, port, platform, nodeId, accountTemplates }) {
  const { region: baseUrl, access_key: keyId, secret_key: keySecret } = cred;
  if (!baseUrl || !keyId || !keySecret) return { success: false, message: 'JumpServer 配置不完整' };

  try {
    // JumpServer 建资产的 platform 需传数字 ID（新版本传名字会 500）；Linux=1
    const PLATFORM_LINUX_ID = 1;
    const body = {
      name: hostname,
      address: ip,
      platform: PLATFORM_LINUX_ID,
      protocols: [{ name: 'ssh', port: port || 22 }],
      is_active: true,
    };
    // 指定资产树节点(组)：归入该节点，不传则落默认位置
    if (nodeId) body.nodes = [nodeId];
    // 套用账号模版：JumpServer 建资产时自动在主机上创建对应账号（用户名+密钥）
    if (Array.isArray(accountTemplates) && accountTemplates.length) {
      body.accounts = accountTemplates.map(tid => ({ template: tid }));
    }
    const res = await jumpserverRequest(baseUrl, keyId, keySecret, 'POST', '/api/v1/assets/hosts/', body);
    return { success: true, assetId: res.data?.id || '', message: `资产 ${hostname} 已添加到 JumpServer` };
  } catch (e) {
    // 资产可能已存在（重复审批/重试）：JumpServer 对同名或同 IP 会报 400 唯一性冲突。
    // 幂等处理：按 IP 反查已有资产，取其 id 继续后续授权，避免因“已存在”而整体跳过授权。
    if (/already exists|唯一|unique|invalid|400/i.test(e.message)) {
      try {
        const found = await listJumpServerResource(cred, '/api/v1/assets/hosts/', 1, 20, ip);
        const hit = (found.items || []).find(a => a.address === ip || a.name === hostname);
        if (hit) return { success: true, assetId: hit.id, message: `资产 ${hostname} 已存在，复用现有资产` };
      } catch (lookupErr) {
        return { success: false, message: `JumpServer 资产创建失败且反查失败: ${e.message} / ${lookupErr.message}` };
      }
    }
    return { success: false, message: `JumpServer 资产创建失败: ${e.message}` };
  }
}

async function createAssetPermission(cred, { name, userIds, assets, accounts }) {
  const { region: baseUrl, access_key: keyId, secret_key: keySecret } = cred;
  if (!baseUrl || !keyId || !keySecret) return { success: false, message: 'JumpServer 配置不完整' };

  try {
    const body = {
      name,
      users: userIds,
      assets,
      // accounts 必填，否则规则里"账号"为空、用户无可登录账号；默认授权资产下所有账号
      accounts: (accounts && accounts.length) ? accounts : ['@ALL'],
      actions: ['all'],
      is_active: true,
    };
    const res = await jumpserverRequest(baseUrl, keyId, keySecret, 'POST', '/api/v1/perms/asset-permissions/', body);
    return { success: true, permId: res.data?.id || '', message: '授权规则已创建' };
  } catch (e) {
    return { success: false, message: `JumpServer 授权创建失败: ${e.message}` };
  }
}
