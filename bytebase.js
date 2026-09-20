'use strict';

const https = require('https');
const http  = require('http');

/**
 * Bytebase API 请求封装
 * @param {string} baseUrl  Bytebase 实例地址，如 https://bytebase.example.com
 * @param {string} token    Bearer Token
 * @param {string} method   GET / POST / DELETE / PATCH
 * @param {string} path     API 路径，如 /v1/members
 * @param {object} body     请求体（POST/PATCH 时传）
 * @param {object} [cfHeaders] Cloudflare Access 凭据 { clientId, clientSecret }，用于绕过 CF 保护
 */
function bytebaseRequest(baseUrl, token, method, path, body, cfHeaders) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const headers = {
      'Content-Type':   'application/json',
    };
    // 仅在有 token 时带 Authorization；登录换令牌接口不应携带（否则报 header 格式错）
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // Cloudflare Access Service Token：带上后可绕过 CF 登录拦截
    if (cfHeaders && cfHeaders.clientId && cfHeaders.clientSecret) {
      headers['CF-Access-Client-Id']     = cfHeaders.clientId;
      headers['CF-Access-Client-Secret'] = cfHeaders.clientSecret;
    }

    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers,
    };

    const req = lib.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const status = res.statusCode;
        // 3xx 重定向：通常是 Cloudflare Access 登录跳转，说明 CF 凭据未通过或地址错误
        if (status >= 300 && status < 400) {
          const loc = res.headers.location || '';
          return reject(new Error(`收到 ${status} 重定向${loc ? `（→ ${loc}）` : ''}，通常是 Cloudflare Access 未通过或地址错误；请确认地址只填到域名、CF 凭据正确`));
        }
        let parsed;
        try {
          parsed = data ? JSON.parse(data) : {};
        } catch {
          // 非 JSON（多为 CF/网关的 HTML 页面）：明确报错，不能当成功
          const snippet = String(data).replace(/\s+/g, ' ').slice(0, 120);
          return reject(new Error(`Bytebase 返回非 JSON 响应(${status})：${snippet || '(空)'}`));
        }
        if (status >= 200 && status < 300) {
          resolve({ status, data: parsed });
        } else {
          reject(new Error(`Bytebase API ${status}: ${JSON.stringify(parsed)}`));
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * 创建 Bytebase 成员账号
 * @param {object} cred    { access_key: baseUrl, secret_key: token }
 * @param {string} email    邮箱（Bytebase 用 email 做唯一标识）
 * @param {string} name     显示名称
 * @param {string} password 明文密码（Bytebase 会自动哈希存储）
 * @returns {{ success: boolean, message: string }}
 */
async function createBytebaseMember(cred, email, name, password) {
  try {
    const { access_key: baseUrl } = cred;
    const cfHeaders = { clientId: cred.cf_client_id || '', clientSecret: cred.cf_client_secret || '' };
    if (!baseUrl || !cred.secret_key) {
      return { success: false, message: 'Bytebase 配置不完整（URL 或 Token 为空）' };
    }

    // Bytebase v3：先用服务账号邮箱+key 登录换取访问令牌
    const token = await bytebaseLogin(cred);

    // 1. 先查询用户是否已存在（v3 端点为 /v1/users）
    try {
      const existing = await bytebaseRequest(baseUrl, token, 'GET', '/v1/users', null, cfHeaders);
      const users = existing.data?.users || [];
      const found = users.find(u => u.email === email);
      if (found) {
        return { success: false, message: `Bytebase 用户 ${email} 已存在，跳过创建` };
      }
    } catch (e) {
      console.warn('[bytebase] 查询用户列表失败:', e.message);
    }

    // 2. 创建用户（v3：POST /v1/users，user_type=END_USER）
    const res = await bytebaseRequest(baseUrl, token, 'POST', '/v1/users', {
      email,
      title:    name,
      password,
      userType: 'USER',
    }, cfHeaders);

    const user = res.data || {};
    return {
      success: true,
      message: `Bytebase 用户 ${name}（${email}）创建成功`,
      memberId: user.name || '', // v3 资源名如 users/123
    };
  } catch (err) {
    if (err.message && err.message.includes('409')) {
      return { success: false, message: `Bytebase 用户 ${email} 已存在` };
    }
    return { success: false, message: `Bytebase 错误: ${err.message}` };
  }
}

/**
 * 删除 Bytebase 成员
 * @param {object} cred    { access_key: baseUrl, secret_key: token }
 * @param {string} email   要删除的成员邮箱
 */
async function deleteBytebaseMember(cred, email) {
  try {
    const { access_key: baseUrl } = cred;
    const cfHeaders = { clientId: cred.cf_client_id || '', clientSecret: cred.cf_client_secret || '' };
    if (!baseUrl || !cred.secret_key) {
      return { success: false, message: 'Bytebase 配置不完整，跳过删除' };
    }

    const token = await bytebaseLogin(cred);

    // v3：先按 email 查出用户资源名(users/{id})，再 DELETE
    const existing = await bytebaseRequest(baseUrl, token, 'GET', '/v1/users', null, cfHeaders);
    const user = (existing.data?.users || []).find(u => u.email === email);
    if (!user) {
      return { success: true, message: `Bytebase 用户 ${email} 不存在，无需删除` };
    }
    // 资源名形如 "users/123"
    await bytebaseRequest(baseUrl, token, 'DELETE', `/v1/${user.name}`, null, cfHeaders);
    return { success: true, message: `Bytebase 用户 ${email} 已删除` };
  } catch (err) {
    if (err.message && err.message.includes('404')) {
      return { success: true, message: `Bytebase 用户 ${email} 不存在，无需删除` };
    }
    return { success: false, message: `Bytebase 删除失败: ${err.message}` };
  }
}

/**
 * Bytebase v3 登录换取访问令牌
 * 服务账号(bbs_ key)不能直接当 Bearer，需用「服务账号邮箱 + key」调 /v1/auth/login 换 token
 * @param {object} cred { access_key: baseUrl, secret_key: bbs_key, service_account_email, cf_client_id, cf_client_secret }
 * @returns {string} 访问令牌
 */
const _tokenCache = new Map(); // key: baseUrl+email -> { token, exp }
async function bytebaseLogin(cred) {
  const baseUrl = cred.access_key;
  const email   = cred.service_account_email;
  const key     = cred.secret_key;
  const cf = { clientId: cred.cf_client_id || '', clientSecret: cred.cf_client_secret || '' };
  if (!email) throw new Error('缺少服务账号邮箱（Bytebase v3 需用「邮箱 + Service Key」登录换取令牌）');

  const cacheKey = `${baseUrl}::${email}`;
  const cached = _tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.exp) return cached.token;

  const r = await bytebaseRequest(baseUrl, '', 'POST', '/v1/auth/login', {
    email, password: key, web: false,
  }, cf);
  const token = r.data?.token;
  if (!token) throw new Error(`登录未返回令牌：${JSON.stringify(r.data).slice(0, 150)}`);
  // 令牌有效期未知，保守缓存 50 分钟
  _tokenCache.set(cacheKey, { token, exp: Date.now() + 50 * 60 * 1000 });
  return token;
}

/**
 * 重置 Bytebase 成员密码（v3：按 email 查出 users/{id} 再 PATCH，update_mask=password）
 * @param {object} cred     { access_key: baseUrl, secret_key: token, service_account_email, cf_* }
 * @param {string} email    成员邮箱
 * @param {string} password 新明文密码
 */
async function resetBytebaseMemberPassword(cred, email, password) {
  try {
    const { access_key: baseUrl } = cred;
    const cfHeaders = { clientId: cred.cf_client_id || '', clientSecret: cred.cf_client_secret || '' };
    if (!baseUrl || !cred.secret_key) {
      return { success: false, message: 'Bytebase 配置不完整' };
    }
    const token = await bytebaseLogin(cred);

    // 按 email 查出用户资源名 users/{id}
    const existing = await bytebaseRequest(baseUrl, token, 'GET', '/v1/users', null, cfHeaders);
    const user = (existing.data?.users || []).find(u => u.email === email);
    if (!user) return { success: false, message: `Bytebase 用户 ${email} 不存在` };

    // v3：PATCH /v1/users/{id}?update_mask=password
    await bytebaseRequest(
      baseUrl, token, 'PATCH',
      `/v1/${user.name}?update_mask=password`,
      { password },
      cfHeaders
    );
    return { success: true, message: `Bytebase 用户 ${email} 密码已重置` };
  } catch (err) {
    return { success: false, message: `Bytebase 密码重置失败: ${err.message}` };
  }
}

module.exports = { bytebaseRequest, bytebaseLogin, createBytebaseMember, deleteBytebaseMember, resetBytebaseMemberPassword };
