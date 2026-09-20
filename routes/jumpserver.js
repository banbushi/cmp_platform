const express = require('express');
const router = express.Router();
const db = require('../utils/database');
const { authenticate } = require('../middleware/auth');
const { listJumpServerResource, createJumpServerAsset, jumpserverRequest, createAssetPermission } = require('../utils/jumpserver');

// 获取 JumpServer 用户列表
router.get('/users', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, search = '' } = req.query;
    const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', ['jumpserver']);
    if (!cred) return res.json({ items: [], total: 0, error: '未配置 JumpServer 凭据' });

    const result = await listJumpServerResource(cred, '/api/v1/users/users/', +page, +pageSize, search);
    res.json(result);
  } catch (err) {
    console.error('[jumpserver] 获取用户列表失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 获取 JumpServer 资产列表
router.get('/assets', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, search = '' } = req.query;
    const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', ['jumpserver']);
    if (!cred) return res.json({ items: [], total: 0, error: '未配置 JumpServer 凭据' });

    const result = await listJumpServerResource(cred, '/api/v1/assets/hosts/', +page, +pageSize, search);
    res.json(result);
  } catch (err) {
    console.error('[jumpserver] 获取资产列表失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 创建 JumpServer 资产（admin）
router.post('/assets', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { hostname, ip, port, nodeId } = req.body || {};
  if (!hostname || !ip) return res.status(400).json({ error: '请填写主机名和 IP' });
  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', ['jumpserver']);
  if (!cred) return res.status(400).json({ error: '未配置 JumpServer 凭据' });
  const r = await createJumpServerAsset(cred, { hostname, ip, port: parseInt(port) || 22, platform: 'aliyun', nodeId });
  if (!r.success) return res.status(500).json({ error: r.message });
  res.status(201).json({ ok: true, assetId: r.assetId });
});

// 删除 JumpServer 资产（admin）
router.delete('/assets/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', ['jumpserver']);
  if (!cred) return res.status(400).json({ error: '未配置 JumpServer 凭据' });
  try {
    await jumpserverRequest(cred.region, cred.access_key, cred.secret_key, 'DELETE', `/api/v1/assets/hosts/${encodeURIComponent(req.params.id)}/`);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: '删除资产失败: ' + err.message });
  }
});

// 获取 JumpServer 资产节点（分组）列表
router.get('/nodes', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, search = '' } = req.query;
    const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', ['jumpserver']);
    if (!cred) return res.json({ items: [], total: 0, error: '未配置 JumpServer 凭据' });

    const result = await listJumpServerResource(cred, '/api/v1/assets/nodes/', +page, +pageSize, search);
    res.json(result);
  } catch (err) {
    console.error('[jumpserver] 获取节点列表失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 获取 JumpServer 账号模版列表（建资产时套用，自动在主机上创建账号）
router.get('/account-templates', authenticate, async (req, res) => {
  try {
    const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', ['jumpserver']);
    if (!cred) return res.json({ items: [], error: '未配置 JumpServer 凭据' });
    const r = await jumpserverRequest(cred.region, cred.access_key, cred.secret_key, 'GET',
      '/api/v1/accounts/account-templates/?limit=100');
    const rows = r.data?.results || (Array.isArray(r.data) ? r.data : []);
    res.json({ items: rows.map(t => ({ id: t.id, name: t.name, username: t.username })) });
  } catch (err) {
    console.error('[jumpserver] 获取账号模版失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 获取某用户组的成员列表
router.get('/user-groups/:id/users', authenticate, async (req, res) => {
  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', ['jumpserver']);
  if (!cred) return res.status(400).json({ error: '未配置 JumpServer 凭据' });
  try {
    const r = await jumpserverRequest(cred.region, cred.access_key, cred.secret_key, 'GET',
      `/api/v1/users/users/?group_id=${encodeURIComponent(req.params.id)}&limit=200`);
    const arr = r.data?.results || r.data || [];
    const items = arr.map(u => ({ id: u.id, username: u.username, name: u.name, is_active: u.is_active }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: '查询用户组成员失败: ' + err.message });
  }
});

// 获取某资产的授权明细（授权到的用户 + 用户组）
router.get('/assets/:id/perms', authenticate, async (req, res) => {
  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', ['jumpserver']);
  if (!cred) return res.status(400).json({ error: '未配置 JumpServer 凭据' });
  const { region: baseUrl, access_key: keyId, secret_key: keySecret } = cred;
  try {
    // 按资产精确过滤授权规则
    const listR = await jumpserverRequest(baseUrl, keyId, keySecret, 'GET',
      `/api/v1/perms/asset-permissions/?asset_id=${encodeURIComponent(req.params.id)}&limit=100`);
    const perms = listR.data?.results || [];
    const users = new Map(), groups = new Map();
    // 列表规则不含 users/user_groups 明细，逐条取详情聚合
    for (const p of perms) {
      try {
        const d = await jumpserverRequest(baseUrl, keyId, keySecret, 'GET', `/api/v1/perms/asset-permissions/${p.id}/`);
        (d.data?.users || []).forEach(u => users.set(u.id, u.name || u.username || u.id));
        (d.data?.user_groups || []).forEach(g => groups.set(g.id, g.name || g.id));
      } catch (_) { /* 单条失败跳过 */ }
    }
    res.json({
      permissions: perms.map(p => p.name),
      users: [...users.values()],
      groups: [...groups.values()],
    });
  } catch (err) {
    res.status(500).json({ error: '查询资产授权失败: ' + err.message });
  }
});

// 获取某资产上已有的系统账号（供授权时选择）
router.get('/assets/:id/accounts', authenticate, async (req, res) => {
  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', ['jumpserver']);
  if (!cred) return res.status(400).json({ error: '未配置 JumpServer 凭据' });
  const { region: baseUrl, access_key: keyId, secret_key: keySecret } = cred;
  try {
    const r = await jumpserverRequest(baseUrl, keyId, keySecret, 'GET',
      `/api/v1/accounts/accounts/?asset=${encodeURIComponent(req.params.id)}&limit=100`);
    const rows = r.data?.results || (Array.isArray(r.data) ? r.data : []);
    const accounts = rows.map(a => ({ id: a.id, name: a.name || a.username, username: a.username }));
    res.json({ accounts });
  } catch (err) {
    res.status(500).json({ error: '查询资产系统账号失败: ' + err.message });
  }
});

// 给资产创建授权规则：把指定用户授权到某系统账号（admin）
router.post('/assets/:id/grant', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { userIds, accounts, name } = req.body || {};
  if (!Array.isArray(userIds) || !userIds.length) return res.status(400).json({ error: '请选择要授权的用户' });
  if (!Array.isArray(accounts) || !accounts.length) return res.status(400).json({ error: '请选择系统账号' });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', ['jumpserver']);
  if (!cred) return res.status(400).json({ error: '未配置 JumpServer 凭据' });

  const permName = name || `CMP-grant-${req.params.id.slice(0, 8)}-${Date.now().toString().slice(-6)}`;
  const r = await createAssetPermission(cred, {
    name: permName,
    userIds,
    assets: [req.params.id],
    accounts,
  });
  if (!r.success) return res.status(500).json({ error: r.message });
  res.status(201).json({ ok: true, permId: r.permId, message: r.message });
});

// 获取 JumpServer 用户组列表
router.get('/user-groups', authenticate, async (req, res) => {
  try {
    const { page = 1, pageSize = 20, search = '' } = req.query;
    const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', ['jumpserver']);
    if (!cred) return res.json({ items: [], total: 0, error: '未配置 JumpServer 凭据' });

    const result = await listJumpServerResource(cred, '/api/v1/users/groups/', +page, +pageSize, search);
    res.json(result);
  } catch (err) {
    console.error('[jumpserver] 获取用户组列表失败:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
