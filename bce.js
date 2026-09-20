/**
 * 百度智能云 BCE v1 签名请求工具
 * 文档：https://cloud.baidu.com/doc/Reference/s/njwvz1yfu
 */
const https = require('https');
const crypto = require('crypto');

/**
 * 发起百度云 BCE v1 签名的 HTTPS 请求
 * @param {object} cred   - { access_key, secret_key }
 * @param {string} method - HTTP 方法 (GET/POST/PUT/DELETE)
 * @param {string} path   - 请求路径，如 /v1/user
 * @param {object} queryParams - 查询参数对象，可为 null
 * @param {object} body   - 请求体对象（POST/PUT），可为 null
 */
async function bceRequest(cred, method, path, queryParams, body, host = 'iam.bj.baidubce.com', rawText = false, opts = {}) {
  const signContent = !!opts.signContentHeaders;  // 是否把 content-type/content-length 纳入签名（对齐官方 SDK 默认）
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const expirationSeconds = 1800;
  const authStringPrefix = `bce-auth-v1/${cred.access_key}/${timestamp}/${expirationSeconds}`;

  // 派生签名 key
  const signingKey = crypto.createHmac('sha256', cred.secret_key).update(authStringPrefix).digest('hex');

  // 规范 URI：对每个路径段分别 percent-encode
  const canonicalUri = path.split('/').map(s => encodeURIComponent(decodeURIComponent(s))).join('/');

  // 规范查询字符串：按 key 字典序排列
  const canonicalQueryString = Object.keys(queryParams || {}).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(String(queryParams[k]))}`)
    .join('&');

  // body 需在签名前算好，以便把 content-length 纳入签名
  const bodyStr = body ? JSON.stringify(body) : '';
  // 与真实成功请求一致带上 charset；Spring 端读不到 charset 可能导致 body 解析失败
  const contentType = opts.contentType || 'application/json';

  // 规范头部：host 和 x-bce-date（必签）；可选把 content-type/content-length 一并签入（官方 SDK 默认行为）
  // BCE v1 要求对头部名称和值分别做 encodeURIComponent，时间戳中的 : 需编码为 %3A
  const headerPairs = [['host', host], ['x-bce-date', timestamp]];
  if (signContent) {
    headerPairs.push(['content-type', contentType]);
    if (bodyStr) headerPairs.push(['content-length', String(Buffer.byteLength(bodyStr))]);
  }
  // 规范头部需按 header 名字典序排列
  headerPairs.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const signedHeaderNames = headerPairs.map(([k]) => k).join(';');
  const canonicalHeaders = headerPairs
    .map(([k, v]) => `${encodeURIComponent(k)}:${encodeURIComponent(v)}`)
    .join('\n');

  const stringToSign = `${method.toUpperCase()}\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}`;
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const authorization = `${authStringPrefix}/${signedHeaderNames}/${signature}`;

  const urlPath = path + (canonicalQueryString ? `?${canonicalQueryString}` : '');

  return new Promise((resolve, reject) => {
    const headers = {
      'Host': host,
      'x-bce-date': timestamp,
      'Content-Type': contentType,
      'Authorization': authorization
    };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

    const req = https.request({ hostname: host, path: urlPath, method: method.toUpperCase(), headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 204 || !data) {
          return res.statusCode < 300 ? resolve({}) : reject(new Error(`HTTP ${res.statusCode}`));
        }
        if (rawText) {
          return res.statusCode < 300 ? resolve(data) : reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const err = new Error(parsed.message || parsed.code || `HTTP ${res.statusCode}`);
            err.raw = data;              // 保留完整原始响应体，便于定位
            err.code = parsed.code;
            err.status = res.statusCode;
            reject(err);
          }
        } catch {
          res.statusCode < 300 ? resolve({}) : reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    });

    req.setTimeout(60000, () => {
      req.destroy(new Error(`请求超时(60s): ${method.toUpperCase()} ${host}${path}`));
    });

    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

module.exports = bceRequest;
