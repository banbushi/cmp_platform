'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../utils/database');
const { authenticate } = require('../middleware/auth');
const { bytebaseRequest, bytebaseLogin } = require('../utils/bytebase');

const router = express.Router();

// 归一化 Bytebase 地址：只保留协议+域名(+端口)，去掉误填的 /v1/... API 路径和尾部斜杠
function normalizeBaseUrl(raw) {
  let s = (raw || '').trim();
  if (!s) return s;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    return `${u.protocol}//${u.host}`;
  } catch {
    return s.replace(/\/+$/, '');
  }
}

// 把实例行转成 token 掩码后的安全对象（列表/详情返回，不泄露 token 和 CF secret）
function maskInstance(row) {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    service_account_email: row.service_account_email || '',
    cf_client_id: row.cf_client_id || '',
    has_token: !!row.token,
    has_cf_secret: !!row.cf_client_secret,
    enabled: !!row.enabled,
    updated_at: row.updated_at,
  };
}

/** GET /api/bytebase/instances — 列出所有实例（管理员）。?enabledOnly=1 只返回启用的（供申请页用，任何登录用户） */
router.get('/instances', authenticate, async (req, res) => {
  const enabledOnly = req.query.enabledOnly === '1';
  if (!enabledOnly && req.user.role !== 'admin') {
    return res.status(403).json({ error: '无权限' });
  }
  const rows = enabledOnly
    ? await db.all('SELECT * FROM bytebase_instances WHERE enabled = 1 ORDER BY name')
    : await db.all('SELECT * FROM bytebase_instances ORDER BY name');
  res.json({ instances: rows.map(maskInstance) });
});

/** POST /api/bytebase/instances — 创建实例（管理员） */
router.post('/instances', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { name, base_url, service_account_email, token, cf_client_id, cf_client_secret, enabled } = req.body || {};
  if (!name?.trim())     return res.status(400).json({ error: '请填写实例名称' });
  if (!base_url?.trim()) return res.status(400).json({ error: '请填写 Bytebase 地址' });
  if (!token?.trim())    return res.status(400).json({ error: '请填写 Service Account Key' });

  const dup = await db.get('SELECT id FROM bytebase_instances WHERE name = ?', [name.trim()]);
  if (dup) return res.status(400).json({ error: '实例名称已存在' });

  const id = uuidv4();
  await db.run(
    `INSERT INTO bytebase_instances (id, name, base_url, service_account_email, token, cf_client_id, cf_client_secret, enabled)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, name.trim(), normalizeBaseUrl(base_url), (service_account_email || '').trim(), token.trim(), (cf_client_id || '').trim(), (cf_client_secret || '').trim(), enabled === false ? 0 : 1]
  );
  res.json({ ok: true, id });
});

/** PUT /api/bytebase/instances/:id — 更新实例（管理员）。token/cf_client_secret 留空表示不修改 */
router.put('/instances/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const cur = await db.get('SELECT * FROM bytebase_instances WHERE id = ?', [req.params.id]);
  if (!cur) return res.status(404).json({ error: '实例不存在' });

  const { name, base_url, service_account_email, token, cf_client_id, cf_client_secret, enabled } = req.body || {};
  if (name !== undefined && !name.trim())     return res.status(400).json({ error: '实例名称不能为空' });
  if (base_url !== undefined && !base_url.trim()) return res.status(400).json({ error: 'Bytebase 地址不能为空' });

  if (name && name.trim() !== cur.name) {
    const dup = await db.get('SELECT id FROM bytebase_instances WHERE name = ? AND id <> ?', [name.trim(), req.params.id]);
    if (dup) return res.status(400).json({ error: '实例名称已存在' });
  }

  const next = {
    name:             name !== undefined ? name.trim() : cur.name,
    base_url:         base_url !== undefined ? normalizeBaseUrl(base_url) : cur.base_url,
    service_account_email: service_account_email !== undefined ? (service_account_email || '').trim() : cur.service_account_email,
    // token / cf_secret 留空 = 保留原值（前端不回显敏感值）
    token:            (token && token.trim()) ? token.trim() : cur.token,
    cf_client_id:     cf_client_id !== undefined ? (cf_client_id || '').trim() : cur.cf_client_id,
    cf_client_secret: (cf_client_secret && cf_client_secret.trim()) ? cf_client_secret.trim() : cur.cf_client_secret,
    enabled:          enabled !== undefined ? (enabled ? 1 : 0) : cur.enabled,
  };
  await db.run(
    `UPDATE bytebase_instances SET name=?, base_url=?, service_account_email=?, token=?, cf_client_id=?, cf_client_secret=?, enabled=? WHERE id=?`,
    [next.name, next.base_url, next.service_account_email, next.token, next.cf_client_id, next.cf_client_secret, next.enabled, req.params.id]
  );
  res.json({ ok: true });
});

/** DELETE /api/bytebase/instances/:id — 删除实例（管理员） */
router.delete('/instances/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  await db.run('DELETE FROM bytebase_instances WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

/** POST /api/bytebase/instances/test — 测试连接（管理员）。传 id 用已存库凭据，或直接传 base_url/token/cf_* 试连 */
router.post('/instances/test', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  let { id, base_url, service_account_email, token, cf_client_id, cf_client_secret } = req.body || {};

  if (id) {
    const row = await db.get('SELECT * FROM bytebase_instances WHERE id = ?', [id]);
    if (!row) return res.status(404).json({ error: '实例不存在' });
    base_url = row.base_url; token = row.token; service_account_email = row.service_account_email;
    cf_client_id = row.cf_client_id; cf_client_secret = row.cf_client_secret;
  }
  base_url = normalizeBaseUrl(base_url);
  if (!base_url || !token) return res.status(400).json({ error: '缺少地址或 Service Account Key' });
  if (!service_account_email) return res.status(400).json({ error: '缺少服务账号邮箱（Bytebase v3 登录换令牌需要）' });

  try {
    // 整形成 util 期望的 cred 结构，走 v3 登录换令牌 → 查 /v1/users 验证
    const cred = { access_key: base_url, secret_key: token, service_account_email, cf_client_id, cf_client_secret };
    const cf = { clientId: cf_client_id || '', clientSecret: cf_client_secret || '' };
    const accessToken = await bytebaseLogin(cred);
    const r = await bytebaseRequest(base_url, accessToken, 'GET', '/v1/users', null, cf);
    const count = (r.data?.users || []).length;
    res.json({ ok: true, message: `连接成功，读取到 ${count} 个用户` });
  } catch (e) {
    res.status(400).json({ error: `连接失败: ${e.message}` });
  }
});

module.exports = router;
