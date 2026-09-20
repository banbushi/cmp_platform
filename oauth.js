'use strict';

const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const db = require('../utils/database');
const { authenticate, JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

// ── GET /oauth/authorize ────────────────────────────────
// OAuth2 Authorization Code 授权端点
// 用户已登录时自动批准，生成 code 并重定向
router.get('/authorize', async (req, res) => {
  const { client_id, redirect_uri, response_type, state } = req.query;

  if (response_type !== 'code') {
    return res.status(400).json({ error: 'unsupported_response_type' });
  }
  if (!client_id || !redirect_uri) {
    return res.status(400).json({ error: 'invalid_request', error_description: 'client_id and redirect_uri required' });
  }

  // 验证 client
  const client = await db.get('SELECT * FROM oauth_clients WHERE client_id = ?', [client_id]);
  if (!client) {
    return res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
  }

  // 验证 redirect_uri（允许前缀匹配）
  if (!redirect_uri.startsWith(client.redirect_uri.split('?')[0].replace(/\/$/, ''))) {
    return res.status(400).json({ error: 'invalid_redirect_uri' });
  }

  // 验证用户已登录（从 Authorization header 或 cookie 中读取 JWT）
  const token = req.headers['authorization']?.split(' ')[1]
    || req.query.token
    || req.cookies?.cmp_token;

  if (!token) {
    // 未登录 → 重定向到登录页，登录后回来
    const returnUrl = encodeURIComponent(req.originalUrl);
    return res.redirect(`/#login?return=${returnUrl}`);
  }

  let user;
  try {
    user = jwt.verify(token, JWT_SECRET);
  } catch {
    const returnUrl = encodeURIComponent(req.originalUrl);
    return res.redirect(`/#login?return=${returnUrl}`);
  }

  // 生成授权码
  const code = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 分钟有效

  await db.run(
    'INSERT INTO oauth_codes (code, client_id, user_id, redirect_uri, expires_at) VALUES (?, ?, ?, ?, ?)',
    [code, client_id, user.id, redirect_uri, expiresAt]
  );

  // 自动批准，重定向回客户端
  const separator = redirect_uri.includes('?') ? '&' : '?';
  const redirectUrl = `${redirect_uri}${separator}code=${code}${state ? `&state=${encodeURIComponent(state)}` : ''}`;
  res.redirect(redirectUrl);
});

// ── POST /oauth/token ───────────────────────────────────
// 用授权码换 access_token
router.post('/token', async (req, res) => {
  const { grant_type, code, client_id, client_secret, redirect_uri } = req.body;

  if (grant_type !== 'authorization_code') {
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }

  // 验证 client 凭证
  const client = await db.get('SELECT * FROM oauth_clients WHERE client_id = ?', [client_id]);
  if (!client || client.client_secret !== client_secret) {
    return res.status(401).json({ error: 'invalid_client' });
  }

  // 验证授权码
  const authCode = await db.get(
    'SELECT * FROM oauth_codes WHERE code = ? AND client_id = ? AND used = 0',
    [code, client_id]
  );
  if (!authCode) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid or expired code' });
  }
  if (new Date(authCode.expires_at) < new Date()) {
    return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired' });
  }

  // 标记 code 已使用
  await db.run('UPDATE oauth_codes SET used = 1 WHERE code = ?', [code]);

  // 生成 access_token
  const accessToken = crypto.randomBytes(32).toString('hex');
  const tokenExpiresAt = new Date(Date.now() + 8 * 60 * 60 * 1000); // 8 小时有效

  await db.run(
    'INSERT INTO oauth_tokens (token, client_id, user_id, expires_at) VALUES (?, ?, ?, ?)',
    [accessToken, client_id, authCode.user_id, tokenExpiresAt]
  );

  res.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 28800,
  });
});

// ── GET /oauth/userinfo ─────────────────────────────────
// 用 access_token 获取用户信息
router.get('/userinfo', async (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'invalid_token' });
  }

  const token = authHeader.slice(7);
  const tokenRow = await db.get(
    'SELECT * FROM oauth_tokens WHERE token = ? AND expires_at > NOW()',
    [token]
  );
  if (!tokenRow) {
    return res.status(401).json({ error: 'invalid_token', error_description: 'Token expired or invalid' });
  }

  const user = await db.get(
    'SELECT id, name, email, role, real_name, cloud_username FROM users WHERE id = ?',
    [tokenRow.user_id]
  );
  if (!user) {
    return res.status(404).json({ error: 'user_not_found' });
  }

  // 返回标准 OIDC userinfo 格式
  res.json({
    sub: user.id,
    name: user.real_name || user.name,
    email: user.email,
    preferred_username: user.cloud_username || user.name,
    role: user.role,
  });
});

// ── 管理接口（需要管理员权限）────────────────────────────

// 获取所有 OAuth Client 列表
router.get('/clients', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const clients = await db.all(
    'SELECT id, client_id, platform, redirect_uri, name, created_at FROM oauth_clients ORDER BY created_at DESC'
  );
  res.json({ clients });
});

// 创建 OAuth Client
router.post('/clients', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { name, platform, redirect_uri } = req.body;
  if (!name || !redirect_uri) {
    return res.status(400).json({ error: '请填写名称和回调地址' });
  }

  const id = uuidv4();
  const clientId = `cmp_${crypto.randomBytes(12).toString('hex')}`;
  const clientSecret = crypto.randomBytes(32).toString('hex');

  await db.run(
    'INSERT INTO oauth_clients (id, client_id, client_secret, platform, redirect_uri, name) VALUES (?, ?, ?, ?, ?, ?)',
    [id, clientId, clientSecret, platform || '', redirect_uri, name]
  );

  res.status(201).json({
    id,
    client_id: clientId,
    client_secret: clientSecret,
    platform,
    redirect_uri,
    name,
  });
});

// 删除 OAuth Client
router.delete('/clients/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  await db.run('DELETE FROM oauth_clients WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
