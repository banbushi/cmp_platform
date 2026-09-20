const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../utils/database');
const { authenticate, requireAdmin, JWT_SECRET } = require('../middleware/auth');
const bceRequest = require('../utils/bce');
const { createBytebaseMember, deleteBytebaseMember } = require('../utils/bytebase');
const { createJumpServerUser, deleteJumpServerUser, listJumpServerResource } = require('../utils/jumpserver');

/** 生成强随机密码：16位，含大小写+数字+特殊字符 */
function genRandomPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ', lower = 'abcdefghjkmnpqrstuvwxyz', digits = '23456789', special = '!@#-_';
  const all = upper + lower + digits + special;
  let pw = upper[crypto.randomInt(upper.length)] + upper[crypto.randomInt(upper.length)]
         + lower[crypto.randomInt(lower.length)] + lower[crypto.randomInt(lower.length)]
         + digits[crypto.randomInt(digits.length)] + digits[crypto.randomInt(digits.length)]
         + special[crypto.randomInt(special.length)] + special[crypto.randomInt(special.length)];
  for (let i = 8; i < 16; i++) pw += all[crypto.randomInt(all.length)];
  return pw.split('').sort(() => crypto.randomInt(3) - 1).join('');
}

const router = express.Router();

/** 校验密码复杂度：至少8位，含大写字母、小写字母、数字 */
function checkPassword(pw) {
  if (!pw || pw.length < 8)      return '密码至少8位';
  if (!/[A-Z]/.test(pw))         return '密码须包含大写字母';
  if (!/[a-z]/.test(pw))         return '密码须包含小写字母';
  if (!/[0-9]/.test(pw))         return '密码须包含数字';
  return null;
}

// 登录（首次使用自动注册管理员）
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: '请填写邮箱和密码' });

  const user = await db.get('SELECT * FROM users WHERE email = ?', [email]);
  if (!user) return res.status(401).json({ error: '邮箱或密码错误' });

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: '邮箱或密码错误' });

  if (user.status === 'disabled') return res.status(403).json({ error: '该账号已被禁用，请联系管理员' });

  const token = jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role, feishu_open_id: user.feishu_open_id },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, real_name: user.real_name || null, cloud_username: user.cloud_username || null } });
});

// 获取当前用户
router.get('/me', authenticate, async (req, res) => {
  const user = await db.get('SELECT id, name, email, role, real_name, cloud_username, feishu_open_id FROM users WHERE id = ?', [req.user.id]);
  res.json({ user });
});

// 保存个人资料（姓名 + 账号名称），无需密码验证
router.post('/me/profile', authenticate, async (req, res) => {
  const { real_name, cloud_username } = req.body;
  if (!real_name?.trim())      return res.status(400).json({ error: '请填写姓名' });
  if (!cloud_username?.trim()) return res.status(400).json({ error: '请填写账号名称' });
  if (!/^[a-zA-Z0-9_+=,.@-]+$/.test(cloud_username.trim()))
    return res.status(400).json({ error: '账号名称只能包含字母、数字及 _ + = , . @ - 字符' });
  await db.run('UPDATE users SET real_name = ?, cloud_username = ? WHERE id = ?',
    [real_name.trim(), cloud_username.trim(), req.user.id]);
  res.json({ ok: true });
});

// 修改当前管理员的邮箱 / 密码
router.put('/me', authenticate, async (req, res) => {
  const { current_password, new_email, new_password } = req.body;
  if (!current_password) return res.status(400).json({ error: '请填写当前密码' });

  const user = await db.get('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  const valid = await bcrypt.compare(current_password, user.password);
  if (!valid) return res.status(401).json({ error: '当前密码错误' });

  if (!new_email && !new_password) return res.status(400).json({ error: '请至少填写新邮箱或新密码之一' });

  let updatedEmail = user.email;
  let updatedPassword = user.password;

  if (new_email && new_email !== user.email) {
    const conflict = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [new_email, user.id]);
    if (conflict) return res.status(409).json({ error: '该邮箱已被其他账号使用' });
    updatedEmail = new_email;
  }

  if (new_password) {
    const pwErr = checkPassword(new_password);
    if (pwErr) return res.status(400).json({ error: pwErr });
    updatedPassword = await bcrypt.hash(new_password, 10);
  }

  await db.run('UPDATE users SET email = ?, password = ? WHERE id = ?', [updatedEmail, updatedPassword, user.id]);

  const token = jwt.sign(
    { id: user.id, name: user.name, email: updatedEmail, role: user.role, feishu_open_id: user.feishu_open_id },
    JWT_SECRET,
    { expiresIn: '24h' }
  );
  res.json({ message: '账号信息已更新', token, email: updatedEmail });
});

// 获取所有平台账号列表（不含 admin 账号）
// 批量个人云账号画像（管理后台用）：一次性返回所有用户合并后的准确画像
// 合并 managed(cloud_users) + synced(cloud_synced_users)，策略取同步最新值，组从 cloud_groups 反查
router.get('/cloud-overview', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const IAM = ['aws', 'aliyun', 'baidu'];

  const [users, cloudUsers, syncedUsers, groups] = await Promise.all([
    db.all("SELECT id, name, cloud_username FROM users WHERE feishu_open_id IS NOT NULL OR role NOT IN ('admin','viewer','operator','billing')"),
    db.all("SELECT * FROM cloud_users WHERE status != 'failed' ORDER BY created_at DESC"),
    db.all('SELECT * FROM cloud_synced_users ORDER BY synced_at DESC'),
    db.all('SELECT platform, group_name, members FROM cloud_groups')
  ]);

  // managed：按 user_id + platform 去重取最新
  const managedByUser = new Map(); // userId -> Map(platform -> acc)
  for (const c of cloudUsers) {
    if (!IAM.includes(c.platform)) continue;
    if (!managedByUser.has(c.user_id)) managedByUser.set(c.user_id, new Map());
    const m = managedByUser.get(c.user_id);
    if (!m.has(c.platform)) {
      m.set(c.platform, {
        platform: c.platform, cloud_username: c.cloud_username, status: c.status,
        policies: JSON.parse(c.policies || '[]'), groups: JSON.parse(c.groups || '[]'),
        created_at: c.created_at, source: 'managed'
      });
    }
  }

  // synced：按 local_user_id 和 cloud_username 两个维度建索引
  const syncedByLocalId = new Map();   // userId -> [rows]
  const syncedByUsername = new Map();  // username -> [rows]
  for (const s of syncedUsers) {
    if (!IAM.includes(s.platform)) continue;
    if (s.local_user_id) {
      if (!syncedByLocalId.has(s.local_user_id)) syncedByLocalId.set(s.local_user_id, []);
      syncedByLocalId.get(s.local_user_id).push(s);
    }
    if (s.cloud_username) {
      if (!syncedByUsername.has(s.cloud_username)) syncedByUsername.set(s.cloud_username, []);
      syncedByUsername.get(s.cloud_username).push(s);
    }
  }

  // 组成员反查：platform -> (username -> [groupName])
  const groupIndex = new Map();
  for (const g of groups) {
    if (!IAM.includes(g.platform)) continue;
    const members = JSON.parse(g.members || '[]');
    for (const mName of members) {
      const key = `${g.platform}::${mName}`;
      if (!groupIndex.has(key)) groupIndex.set(key, []);
      groupIndex.get(key).push(g.group_name);
    }
  }

  const result = users.map(u => {
    const accMap = new Map();
    // 1) managed
    const managed = managedByUser.get(u.id);
    if (managed) for (const [p, acc] of managed) accMap.set(p, { ...acc });
    // 2) synced（按 local_user_id 或 cloud_username 匹配）
    const syncedRows = [
      ...(syncedByLocalId.get(u.id) || []),
      ...(u.cloud_username ? (syncedByUsername.get(u.cloud_username) || []) : [])
    ];
    const seenSynced = new Set();
    for (const s of syncedRows) {
      if (seenSynced.has(s.id)) continue;
      seenSynced.add(s.id);
      const syncedPolicies = JSON.parse(s.policies || '[]');
      if (accMap.has(s.platform)) {
        const ex = accMap.get(s.platform);
        if (syncedPolicies.length > 0) ex.policies = syncedPolicies;  // 同步策略更权威
        ex.synced_at = s.synced_at;
      } else {
        accMap.set(s.platform, {
          platform: s.platform, cloud_username: s.cloud_username, status: 'active',
          policies: syncedPolicies, groups: [],
          created_at: s.created_at_cloud || s.synced_at, synced_at: s.synced_at, source: 'synced'
        });
      }
    }
    // 3) 组反查（按各账号自己的 cloud_username）
    for (const acc of accMap.values()) {
      const gs = groupIndex.get(`${acc.platform}::${acc.cloud_username}`) || [];
      for (const gn of gs) if (!acc.groups.includes(gn)) acc.groups.push(gn);
    }
    return { id: u.id, cloud_accounts: Array.from(accMap.values()) };
  });

  res.json({ users: result });
});

router.get('/list', authenticate, async (req, res) => {
  const users = await db.all(`
    SELECT u.id, u.name, u.email, u.department, u.role, u.notes, u.created_at,
      (SELECT COUNT(*) FROM cloud_users cu WHERE cu.user_id = u.id) as cloud_count
    FROM users u WHERE u.feishu_open_id IS NOT NULL OR u.role NOT IN ('admin', 'viewer', 'operator', 'billing') ORDER BY u.created_at DESC
  `);
  res.json({ users });
});

// ── 登录用户（飞书 OAuth 登录的申请人）管理 ─────────────────────────────
// 列出所有通过飞书登录的用户（role=applicant），含状态和关联的云账号数
router.get('/login-users', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  // 关联口径与「云账号/平台工具账号」页一致：
  //  - 云账号 & jumpserver 来自 cloud_synced_users（同步表），按 local_user_id 或 cloud_username 关联
  //  - bytebase/kuboard/grafana 只有托管账号，来自 cloud_users
  const users = await db.all(`
    SELECT u.id, u.name, u.email, u.real_name, u.role, u.status, u.feishu_open_id, u.created_at,
      (SELECT COUNT(*) FROM cloud_synced_users s
         WHERE s.platform IN ('aws','aliyun','baidu')
           AND (s.local_user_id = u.id OR (COALESCE(u.cloud_username,'') <> '' AND s.cloud_username = u.cloud_username))
      ) AS cloud_count,
      (
        (SELECT COUNT(*) FROM cloud_synced_users s
           WHERE s.platform = 'jumpserver'
             AND (s.local_user_id = u.id OR (COALESCE(u.cloud_username,'') <> '' AND s.cloud_username = u.cloud_username)))
        +
        (SELECT COUNT(*) FROM cloud_users cu
           WHERE cu.user_id = u.id AND cu.status <> 'failed'
             AND cu.platform IN ('bytebase','kuboard','grafana-aws','grafana-wuwen','grafana-baidu'))
      ) AS tool_count
    FROM users u
    WHERE u.feishu_open_id IS NOT NULL
    ORDER BY u.created_at DESC
  `);
  res.json({ users });
});

// 查看某登录用户的关联账号明细（category=cloud → aws/aliyun/baidu；category=tool → jumpserver + bytebase/kuboard/grafana）
// 口径与 login-users 列表的 cloud_count/tool_count 完全一致
router.get('/login-users/:id/accounts', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const category = req.query.category === 'tool' ? 'tool' : 'cloud';

  const user = await db.get('SELECT id, cloud_username FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  const cname = user.cloud_username || null;

  const accounts = [];

  if (category === 'cloud') {
    // 云账号来自同步表，按 local_user_id 或 cloud_username 关联
    const rows = await db.all(
      `SELECT platform, cloud_username, synced_at AS created_at FROM cloud_synced_users
       WHERE platform IN ('aws','aliyun','baidu')
         AND (local_user_id = ? OR (? IS NOT NULL AND cloud_username = ?))
       ORDER BY platform, synced_at DESC`,
      [req.params.id, cname, cname]
    );
    accounts.push(...rows.map(r => ({ ...r, status: 'synced' })));
  } else {
    // jumpserver 来自同步表
    const jsRows = await db.all(
      `SELECT platform, cloud_username, synced_at AS created_at FROM cloud_synced_users
       WHERE platform = 'jumpserver'
         AND (local_user_id = ? OR (? IS NOT NULL AND cloud_username = ?))
       ORDER BY synced_at DESC`,
      [req.params.id, cname, cname]
    );
    accounts.push(...jsRows.map(r => ({ ...r, status: 'synced' })));
    // bytebase/kuboard/grafana 来自托管表
    const managed = await db.all(
      `SELECT platform, cloud_username, status, created_at FROM cloud_users
       WHERE user_id = ? AND status <> 'failed'
         AND platform IN ('bytebase','kuboard','grafana-aws','grafana-wuwen','grafana-baidu')
       ORDER BY platform, created_at DESC`,
      [req.params.id]
    );
    accounts.push(...managed);
  }

  res.json({ accounts });
});

// 启用/禁用登录用户（禁用后拒绝登录）
router.put('/login-users/:id/status', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { status } = req.body || {};
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: 'status 只能是 active 或 disabled' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: '不能禁用自己' });

  const user = await db.get('SELECT id, role FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  await db.run('UPDATE users SET status = ? WHERE id = ?', [status, req.params.id]);
  res.json({ message: status === 'disabled' ? '已禁用' : '已启用' });
});

// 指定飞书登录用户的系统角色（角色以库为准，authenticate 每次请求读取，改完即时生效）
router.put('/login-users/:id/role', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { role } = req.body || {};
  if (!role) return res.status(400).json({ error: '请选择角色' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: '不能修改自己的角色' });

  const user = await db.get('SELECT id, feishu_open_id FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  if (!user.feishu_open_id) {
    return res.status(400).json({ error: '系统账号请在「系统账号」中修改角色' });
  }

  // 创建时间最早的 admin 为默认账号，不可修改
  const defaultAdmin = await db.get(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1"
  );
  if (defaultAdmin && defaultAdmin.id === req.params.id) {
    return res.status(403).json({ error: '默认管理员账号不可修改' });
  }

  // 角色取自 system_roles 表，动态支持自定义角色
  const roleRow = await db.get('SELECT name FROM system_roles WHERE name = ?', [role]);
  if (!roleRow) return res.status(400).json({ error: `角色「${role}」不存在` });

  await db.run('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
  res.json({ message: '角色已更新' });
});

// 删除登录用户：仅解绑本地关联（cloud_users / cloud_synced_users），不删除云端子账号
router.delete('/login-users/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  if (req.params.id === req.user.id) return res.status(400).json({ error: '不能删除自己' });

  const user = await db.get('SELECT id, feishu_open_id FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: '用户不存在' });
  // 仅允许删除飞书登录用户，避免误删系统账号（系统账号走 /admins/:id）
  if (!user.feishu_open_id) {
    return res.status(400).json({ error: '系统账号请在「系统账号」中删除' });
  }

  // 先清理引用 users(id) 的本地关联记录（外键约束），云端子账号不动
  await db.run('DELETE FROM cloud_synced_users WHERE local_user_id = ?', [req.params.id]);
  await db.run('DELETE FROM cloud_users WHERE user_id = ?', [req.params.id]);
  await db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
  res.json({ message: '登录用户已删除（云账号已解绑，云端子账号保留）' });
});

// 以账号为中心，返回同步/托管到本地的全部云端账号（含孤儿账号），关联本地用户做画像
// category=cloud → aws/aliyun/baidu；category=tool → jumpserver(同步) + bytebase/kuboard/grafana(托管)
router.get('/synced-accounts', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const category = req.query.category === 'tool' ? 'tool' : 'cloud';
  const CLOUD = ['aws', 'aliyun', 'baidu'];
  const TOOL_SYNCED = ['jumpserver', 'kuboard'];
  const TOOL_MANAGED = ['bytebase', 'grafana-aws', 'grafana-wuwen', 'grafana-baidu'];

  const [users, cloudUsers, groups] = await Promise.all([
    db.all("SELECT id, name, email, department, cloud_username FROM users"),
    db.all("SELECT * FROM cloud_users WHERE status != 'failed'"),
    db.all('SELECT platform, group_name, members FROM cloud_groups')
  ]);

  // 本地用户索引：按 id、按 cloud_username
  const userById = new Map(users.map(u => [u.id, u]));
  const userByCloudName = new Map();
  for (const u of users) if (u.cloud_username) userByCloudName.set(u.cloud_username, u);

  // 托管账号索引：platform::username -> cloud_users 行（取状态/策略）
  const managedIdx = new Map();
  for (const c of cloudUsers) managedIdx.set(`${c.platform}::${c.cloud_username}`, c);

  // 组反查索引：platform::username -> [groupName]
  const groupIndex = new Map();
  for (const g of groups) {
    const members = JSON.parse(g.members || '[]');
    for (const m of members) {
      const key = `${g.platform}::${m}`;
      if (!groupIndex.has(key)) groupIndex.set(key, []);
      groupIndex.get(key).push(g.group_name);
    }
  }

  const linkUser = (localUserId, cloudUsername) => {
    const u = (localUserId && userById.get(localUserId)) || userByCloudName.get(cloudUsername) || null;
    return u ? { id: u.id, name: u.name, email: u.email, department: u.department } : null;
  };

  const accounts = [];
  const seen = new Set();

  if (category === 'cloud') {
    const rows = await db.all(
      `SELECT * FROM cloud_synced_users WHERE platform IN ('aws','aliyun','baidu') ORDER BY synced_at DESC`
    );
    for (const r of rows) {
      const key = `${r.platform}::${r.cloud_username}`;
      seen.add(key);
      const managed = managedIdx.get(key);
      accounts.push({
        platform: r.platform,
        cloud_username: r.cloud_username,
        display_name: r.display_name || '',
        email: r.email || '',
        policies: JSON.parse(r.policies || '[]'),
        groups: groupIndex.get(key) || [],
        is_managed: !!r.is_managed || !!managed,
        status: managed ? managed.status : null,
        synced_at: r.synced_at,
        linked_user: linkUser(r.local_user_id, r.cloud_username),
      });
    }
  } else {
    // jumpserver 从同步表
    const syncedRows = await db.all(
      `SELECT * FROM cloud_synced_users WHERE platform IN (${TOOL_SYNCED.map(() => '?').join(',')}) ORDER BY synced_at DESC`,
      TOOL_SYNCED
    );
    for (const r of syncedRows) {
      const key = `${r.platform}::${r.cloud_username}`;
      seen.add(key);
      const managed = managedIdx.get(key);
      accounts.push({
        platform: r.platform,
        cloud_username: r.cloud_username,
        display_name: r.display_name || '',
        email: r.email || '',
        policies: JSON.parse(r.policies || '[]'),
        groups: groupIndex.get(key) || [],
        is_managed: !!r.is_managed || !!managed,
        status: managed ? managed.status : null,
        synced_at: r.synced_at,
        linked_user: linkUser(r.local_user_id, r.cloud_username),
      });
    }
    // bytebase/kuboard/grafana 只有托管账号
    for (const c of cloudUsers) {
      if (!TOOL_MANAGED.includes(c.platform)) continue;
      const key = `${c.platform}::${c.cloud_username}`;
      if (seen.has(key)) continue;
      seen.add(key);
      accounts.push({
        platform: c.platform,
        cloud_username: c.cloud_username,
        display_name: '',
        email: '',
        policies: JSON.parse(c.policies || '[]'),
        groups: JSON.parse(c.groups || '[]'),
        is_managed: true,
        status: c.status,
        synced_at: c.sync_time || c.created_at,
        linked_user: linkUser(c.user_id, c.cloud_username),
      });
    }
  }

  res.json({ accounts });
});

// 绑定/解绑同步账号到本地用户（孤儿账号手动关联）
router.post('/synced/bind', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { platform, cloud_username, user_id } = req.body || {};
  if (!platform || !cloud_username) return res.status(400).json({ error: '缺少 platform 或 cloud_username' });
  if (user_id) {
    const u = await db.get('SELECT id FROM users WHERE id = ?', [user_id]);
    if (!u) return res.status(404).json({ error: '目标用户不存在' });
  }
  const r = await db.run(
    'UPDATE cloud_synced_users SET local_user_id = ? WHERE platform = ? AND cloud_username = ?',
    [user_id || null, platform, cloud_username]
  );
  if (!r.affectedRows) return res.status(404).json({ error: '未找到该同步账号' });
  res.json({ ok: true });
});

// 创建 JumpServer 用户（远端创建 + 自动生成密码 + 可选绑定本地用户 + 落库到同步表）
router.post('/jumpserver-user', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { username, name, email, local_user_id } = req.body || {};
  if (!username?.trim()) return res.status(400).json({ error: '请填写用户名' });
  if (!email?.trim())    return res.status(400).json({ error: '请填写邮箱' });

  const cred = await db.get("SELECT * FROM platform_credentials WHERE platform = 'jumpserver' AND enabled = 1");
  if (!cred) return res.status(400).json({ error: '未配置 JumpServer 凭据' });

  if (local_user_id) {
    const u = await db.get('SELECT id FROM users WHERE id = ?', [local_user_id]);
    if (!u) return res.status(404).json({ error: '绑定的本地用户不存在' });
  }

  const password = genRandomPassword();
  const displayName = name?.trim() || username.trim();
  const result = await createJumpServerUser(cred, username.trim(), email.trim(), displayName, password);
  if (!result.success) return res.status(500).json({ error: result.message });

  // 落库到 cloud_synced_users，使其出现在「平台工具账号」列表
  let cloudUserId = result.userId || '';
  if (!cloudUserId) {
    try {
      const { items } = await listJumpServerResource(cred, '/api/v1/users/users/', 1, 10, username.trim());
      const hit = (items || []).find(u => u.username === username.trim());
      if (hit) cloudUserId = hit.id;
    } catch { /* 反查失败不阻断 */ }
  }
  try {
    await db.run(
      `INSERT INTO cloud_synced_users (id, platform, cloud_username, cloud_user_id, display_name, email, policies, is_managed, local_user_id, synced_at)
       VALUES (?, 'jumpserver', ?, ?, ?, ?, '[]', 1, ?, NOW())
       ON DUPLICATE KEY UPDATE cloud_user_id=VALUES(cloud_user_id), display_name=VALUES(display_name), email=VALUES(email), is_managed=1, local_user_id=VALUES(local_user_id), synced_at=NOW()`,
      [uuidv4(), username.trim(), cloudUserId, displayName, email.trim(), local_user_id || null]
    );
  } catch (e) {
    console.warn('[jumpserver-user] 落库失败（远端已创建）:', e.message);
  }

  res.status(201).json({ ok: true, message: result.message, username: username.trim(), password });
});

// 创建 Bytebase 用户（选实例 + 邮箱 + 可选绑定本地用户；远端创建 + 自动生成密码）
router.post('/bytebase-user', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { instance_id, email, name, local_user_id } = req.body || {};
  if (!instance_id)   return res.status(400).json({ error: '请选择 Bytebase 实例' });
  if (!email?.trim()) return res.status(400).json({ error: '请填写邮箱' });

  const inst = await db.get('SELECT * FROM bytebase_instances WHERE id = ? AND enabled = 1', [instance_id]);
  if (!inst) return res.status(404).json({ error: '实例不存在或已停用' });

  if (local_user_id) {
    const u = await db.get('SELECT id FROM users WHERE id = ?', [local_user_id]);
    if (!u) return res.status(404).json({ error: '绑定的本地用户不存在' });
  }

  // 整形成 createBytebaseMember 期望的 cred 结构（access_key=地址, secret_key=token, 附 email/CF）
  const cred = {
    access_key: inst.base_url,
    secret_key: inst.token,
    service_account_email: inst.service_account_email,
    cf_client_id: inst.cf_client_id,
    cf_client_secret: inst.cf_client_secret,
  };
  const password = genRandomPassword();
  const displayName = name?.trim() || email.trim().split('@')[0];
  const result = await createBytebaseMember(cred, email.trim(), displayName, password);
  if (!result.success) return res.status(500).json({ error: result.message });

  // 落库到 cloud_users（托管表），记录来源实例，出现在「平台工具账号」列表
  try {
    await db.run(
      "INSERT INTO cloud_users (id, user_id, platform, bytebase_instance_id, cloud_username, cloud_access_key, cloud_secret_key, policies, `groups`, status, sync_time, console_password) VALUES (?, ?, 'bytebase', ?, ?, ?, '', '[]', '[]', 'active', NOW(), ?)",
      [uuidv4(), local_user_id || req.user.id, inst.id, email.trim(), result.memberId || '', null]
    );
  } catch (e) {
    console.warn('[bytebase-user] 落库失败（远端已创建）:', e.message);
  }

  res.status(201).json({ ok: true, message: result.message, email: email.trim(), password });
});

// 创建 Kuboard 用户（远端创建 + 自动生成密码 + 可选绑定本地用户）
router.post('/kuboard-user', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { username, name, email, local_user_id } = req.body || {};
  if (!username?.trim()) return res.status(400).json({ error: '请填写用户名' });

  const cred = await db.get("SELECT * FROM platform_credentials WHERE platform = 'kuboard' AND enabled = 1");
  if (!cred) return res.status(400).json({ error: '未配置 Kuboard 凭据' });

  if (local_user_id) {
    const u = await db.get('SELECT id FROM users WHERE id = ?', [local_user_id]);
    if (!u) return res.status(404).json({ error: '绑定的本地用户不存在' });
  }

  const password = genRandomPassword();
  const result = await createKuboardUser(cred, username.trim(), password, email?.trim() || '');
  if (!result.success) return res.status(500).json({ error: result.message });

  // 落库到 cloud_synced_users，使其出现在「平台工具账号」列表
  try {
    await db.run(
      `INSERT INTO cloud_synced_users (id, platform, cloud_username, cloud_user_id, display_name, email, policies, is_managed, local_user_id, synced_at)
       VALUES (?, 'kuboard', ?, '', ?, ?, '[]', 1, ?, NOW())
       ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), email=VALUES(email), is_managed=1, local_user_id=VALUES(local_user_id), synced_at=NOW()`,
      [uuidv4(), username.trim(), name?.trim() || username.trim(), email?.trim() || '', local_user_id || null]
    );
  } catch (e) {
    console.warn('[kuboard-user] 落库失败（远端已创建）:', e.message);
  }

  res.status(201).json({ ok: true, message: result.message, username: username.trim(), password });
});

// 获取所有 admin 账号列表
router.get('/admins', authenticate, async (req, res) => {
  // 系统账号 = 邮箱密码登录的账号（无 feishu_open_id）。
  // 按登录方式而非角色划分：飞书用户可被指定任意角色，仍归「飞书登录用户」
  const users = await db.all(`
    SELECT id, name, email, role, created_at FROM users
    WHERE feishu_open_id IS NULL ORDER BY created_at ASC
  `);
  res.json({ users });
});

// 创建 admin 账号
router.post('/admins', authenticate, requireAdmin, async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: '请填写姓名、邮箱和密码' });
  const pwErr0 = checkPassword(password);
  if (pwErr0) return res.status(400).json({ error: pwErr0 });
  // 角色校验取自 system_roles 表（含自定义角色），applicant 不作为系统账号角色；非法/缺省回退 admin
  let finalRole = 'admin';
  if (role && role !== 'applicant') {
    const roleRow = await db.get('SELECT name FROM system_roles WHERE name = ?', [role]);
    if (roleRow) finalRole = role;
  }

  const existing = await db.get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return res.status(409).json({ error: '该邮箱已被使用' });

  const hashed = await bcrypt.hash(password, 10);
  const userId = uuidv4();
  await db.run(
    'INSERT INTO users (id, name, email, password, department, role, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, name, email, hashed, '', finalRole, '']
  );
  res.status(201).json({ message: '平台账号创建成功', user: { id: userId, name, email, role: finalRole } });
});

// 修改 admin 账号邮箱/角色（默认 admin 不可修改）
router.put('/admins/:id', authenticate, requireAdmin, async (req, res) => {
  const { email, role } = req.body;
  if (!email && !role) return res.status(400).json({ error: '请提供要修改的字段' });

  const user = await db.get('SELECT id, role, feishu_open_id FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: '账号不存在' });
  // 飞书用户的邮箱是登录回调匹配身份的键，不允许在此手改；改角色走 /login-users/:id/role
  if (user.feishu_open_id) {
    return res.status(400).json({ error: '飞书登录用户请在「飞书登录用户」中指定角色' });
  }

  // 创建时间最早的 admin 为默认账号，不可修改
  const defaultAdmin = await db.get(
    "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1"
  );
  if (defaultAdmin && defaultAdmin.id === req.params.id) {
    return res.status(403).json({ error: '默认管理员账号不可修改' });
  }

  if (email) {
    const existing = await db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, req.params.id]);
    if (existing) return res.status(409).json({ error: '该邮箱已被使用' });
  }

  // 可用角色动态取自 system_roles 表（含自定义角色），不再硬编码
  const updates = [];
  const params = [];
  if (email) { updates.push('email = ?'); params.push(email); }
  if (role) {
    const roleRow = await db.get('SELECT name FROM system_roles WHERE name = ?', [role]);
    if (!roleRow) return res.status(400).json({ error: `角色「${role}」不存在` });
    updates.push('role = ?'); params.push(role);
  }
  if (!updates.length) return res.status(400).json({ error: '没有可更新的字段' });
  params.push(req.params.id);

  await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
  res.json({ message: '账号信息已更新' });
});

// 修改 admin 账号密码
router.put('/admins/:id/password', authenticate, requireAdmin, async (req, res) => {
  const { new_password } = req.body;
  if (!new_password) return res.status(400).json({ error: '请填写新密码' });
  const pwErr1 = checkPassword(new_password);
  if (pwErr1) return res.status(400).json({ error: pwErr1 });

  // 仅系统账号（邮箱密码登录）有可用密码；飞书用户存的是随机不可用占位串
  const user = await db.get('SELECT id FROM users WHERE id = ? AND feishu_open_id IS NULL', [req.params.id]);
  if (!user) return res.status(404).json({ error: '账号不存在' });

  const hashed = await bcrypt.hash(new_password, 10);
  await db.run('UPDATE users SET password = ? WHERE id = ?', [hashed, req.params.id]);
  res.json({ message: '密码修改成功' });
});

// 删除系统账号（默认 admin 不可删除）
router.delete('/admins/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const user = await db.get(
      'SELECT id, name, role FROM users WHERE id = ? AND feishu_open_id IS NULL',
      [req.params.id]
    );
    if (!user) return res.status(404).json({ error: '账号不存在' });

    // 创建时间最早的 admin 为默认账号，不可删除
    const defaultAdmin = await db.get(
      "SELECT id FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1"
    );
    if (defaultAdmin && defaultAdmin.id === req.params.id) {
      return res.status(403).json({ error: '默认管理员账号不可删除' });
    }

    // 先清理引用 users(id) 的本地关联记录，否则外键约束 fk_cloud_users_user 会阻止删除
    await db.run('DELETE FROM cloud_synced_users WHERE local_user_id = ?', [req.params.id]);
    await db.run('DELETE FROM cloud_users WHERE user_id = ?', [req.params.id]);
    await db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
    res.json({ message: '账号已删除' });
  } catch (err) {
    res.status(500).json({ error: err.message || '删除失败' });
  }
});

// 创建账号（含云平台关联，云平台并行开通，Bytebase 单独串行同步）
router.post('/create', authenticate, requireAdmin, async (req, res) => {
  const { name, email, password, department, role, notes, cloud_accounts } = req.body;

  if (!name || !email || !password) return res.status(400).json({ error: '请填写姓名、邮箱和密码' });
  const pwErr2 = checkPassword(password);
  if (pwErr2) return res.status(400).json({ error: pwErr2 });

  const existing = await db.get('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) return res.status(409).json({ error: '该邮箱已被使用' });

  const hashed = await bcrypt.hash(password, 10);
  const userId = uuidv4();

  // 1. 先写入本地用户
  await db.run(
    'INSERT INTO users (id, name, email, password, department, role, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [userId, name, email, hashed, department || '', role || 'user', notes || '']
  );

  const cloudResults = [];

  if (Array.isArray(cloud_accounts) && cloud_accounts.length > 0) {
    const cloudUsername = name.replace(/\s+/g, '-').toLowerCase();

    // 2. 分离 Bytebase 与其他云平台
    const iamAccounts = cloud_accounts.filter(ca => ca.platform !== 'bytebase');
    const bbAccount   = cloud_accounts.find(ca => ca.platform === 'bytebase');

    // 3. 云平台（AWS/阿里/百度）并行开通
    const iamResults = await Promise.all(iamAccounts.map(async ca => {
      const { platform, policies, groups, enable_console } = ca;
      const masterCred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
      const cloudUserId = uuidv4();
      let cloudAccessKey = '', cloudSecretKey = '', status = 'pending', message = '';

      if (masterCred || platform === 'kuboard') {
        const result = await provisionCloudUser(platform, masterCred, cloudUsername, policies || [], groups || [], notes || '', password, !!enable_console, email);
        cloudAccessKey = result.accessKey || '';
        cloudSecretKey = result.secretKey || '';
        status = result.success ? 'active' : 'failed';
        message = result.message;
      } else {
        status = 'no_credential';
        message = `${PLATFORM_NAMES[platform] || platform} 未配置主账号凭据，请前往设置页面配置`;
      }

      return { cloudUserId, platform, cloudUsername, cloudAccessKey, cloudSecretKey, status, message, policies: policies || [], groups: groups || [], enableConsole: !!enable_console };
    }));

    // 4. 写入云平台 cloud_users
    for (const r of iamResults) {
      await db.run(
        'INSERT INTO cloud_users (id, user_id, platform, cloud_username, cloud_access_key, cloud_secret_key, policies, `groups`, status, sync_time, console_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)',
        [r.cloudUserId, userId, r.platform, r.cloudUsername, r.cloudAccessKey, r.cloudSecretKey, JSON.stringify(r.policies), JSON.stringify(r.groups), r.status, r.enableConsole ? password : null]
      );
    }
    cloudResults.push(...iamResults.map(r => ({
      platform: r.platform, cloud_username: r.cloudUsername, status: r.status, message: r.message, policies: r.policies, groups: r.groups
    })));

    // 5. Bytebase 单独串行同步（数据库平台，不与云平台并行）
    if (bbAccount) {
      // 凭据来自 bytebase_instances（按选中实例，未选则取第一个启用的），整形成 createBytebaseMember 期望结构
      const inst = bbAccount.bytebaseInstanceId
        ? await db.get('SELECT * FROM bytebase_instances WHERE id = ? AND enabled = 1', [bbAccount.bytebaseInstanceId])
        : await db.get('SELECT * FROM bytebase_instances WHERE enabled = 1 ORDER BY name LIMIT 1');
      const bbCred = inst ? {
        access_key: inst.base_url,
        secret_key: inst.token,
        service_account_email: inst.service_account_email, // v3 登录换令牌必需
        cf_client_id: inst.cf_client_id,
        cf_client_secret: inst.cf_client_secret,
      } : null;
      const bbId = uuidv4();
      let bbStatus = 'pending', bbMessage = '', bbMemberId = '';

      if (bbCred) {
        const result = await provisionCloudUser('bytebase', bbCred, cloudUsername, [], [], notes || '', password, false, email);
        bbStatus = result.success ? 'active' : 'failed';
        bbMessage = result.message;
        bbMemberId = result.memberId || '';
      } else {
        bbStatus = 'no_credential';
        bbMessage = 'Bytebase 未配置凭据，请前往设置页面配置';
      }

      await db.run(
        'INSERT INTO cloud_users (id, user_id, platform, bytebase_instance_id, cloud_username, cloud_access_key, cloud_secret_key, policies, `groups`, status, sync_time, console_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?)',
        [bbId, userId, 'bytebase', inst ? inst.id : null, cloudUsername, bbMemberId, '', '[]', '[]', bbStatus, null]
      );
      cloudResults.push({ platform: 'bytebase', cloud_username: cloudUsername, status: bbStatus, message: bbMessage, policies: [], groups: [] });
    }
  }

  res.status(201).json({
    message: '账号创建成功',
    user: { id: userId, name, email, department, role, notes },
    cloud_results: cloudResults
  });
});

// 删除账号（同步删除云平台 IAM/RAM 子账号）
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  const user = await db.get('SELECT id, name, email FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: '账号不存在' });

  const cloudUsers = await db.all(
    "SELECT * FROM cloud_users WHERE user_id = ? AND status IN ('active', 'failed', 'pending')",
    [req.params.id]
  );

  const cloudResults = [];

  for (const cu of cloudUsers) {
    const cred = await resolveDeleteCred(cu.platform, cu.bytebase_instance_id);
    if (!cred) {
      cloudResults.push({ platform: cu.platform, cloud_username: cu.cloud_username, success: false, message: '未配置主账号凭据，跳过云端删除' });
      continue;
    }
    const result = await deleteCloudUser(cu.platform, cred, cu.cloud_username, cu.cloud_access_key, user.email);
    cloudResults.push({ platform: cu.platform, cloud_username: cu.cloud_username, ...result });
  }

  await db.run('DELETE FROM cloud_synced_users WHERE local_user_id = ?', [req.params.id]);
  await db.run('DELETE FROM cloud_users WHERE user_id = ?', [req.params.id]);
  await db.run('DELETE FROM users WHERE id = ?', [req.params.id]);

  res.json({ message: '账号已删除', cloud_results: cloudResults });
});

// 解析删除时用的主账号凭据：bytebase 走 bytebase_instances（优先按账号记录的来源实例，
// 无记录/实例已删则回退第一个启用实例），其余平台走 platform_credentials
async function resolveDeleteCred(platform, bytebaseInstanceId) {
  if (platform === 'bytebase') {
    const inst = (bytebaseInstanceId && await db.get('SELECT * FROM bytebase_instances WHERE id = ?', [bytebaseInstanceId]))
              || await db.get('SELECT * FROM bytebase_instances WHERE enabled = 1 ORDER BY name LIMIT 1');
    return inst ? { access_key: inst.base_url, secret_key: inst.token, service_account_email: inst.service_account_email, cf_client_id: inst.cf_client_id, cf_client_secret: inst.cf_client_secret } : null;
  }
  return await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
}

// 删除某账号在指定云平台的子账号
router.delete('/:id/cloud/:platform', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const user = await db.get('SELECT id, name, email FROM users WHERE id = ?', [req.params.id]);
  if (!user) return res.status(404).json({ error: '账号不存在' });

  const cu = await db.get(
    "SELECT * FROM cloud_users WHERE user_id = ? AND platform = ? AND status IN ('active', 'failed', 'pending') ORDER BY created_at DESC LIMIT 1",
    [req.params.id, req.params.platform]
  );
  if (!cu) return res.status(404).json({ error: '该平台账号不存在' });

  let result = { success: true, message: '本地记录已删除' };
  // 只有 active 状态（云端确实创建了）才去调云端删除
  if (cu.status === 'active') {
    const cred = await resolveDeleteCred(req.params.platform, cu.bytebase_instance_id);
    if (cred) {
      result = await deleteCloudUser(cu.platform, cred, cu.cloud_username, cu.cloud_access_key, user.email);
    } else {
      result = { success: true, message: '未配置凭据，仅删除本地记录' };
    }
  }

  await db.run('DELETE FROM cloud_users WHERE id = ?', [cu.id]);
  const cloudWarning = (!result.success) ? result.message : undefined;
  res.json({ ok: true, message: result.success ? result.message : '本地记录已删除', cloud_warning: cloudWarning });
});

// 按 平台 + 云账号名 删除平台工具账号（用于「平台工具账号」列表，账号不一定关联本地用户）
// jumpserver/bytebase/kuboard 走真实云端删除，grafana 返回手动提示；同时清理本地同步/托管记录
router.delete('/tool-account/:platform/:username', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const platform = req.params.platform;
  const username = decodeURIComponent(req.params.username);

  const TOOL_PLATFORMS = ['jumpserver', 'bytebase', 'kuboard', 'grafana-aws', 'grafana-wuwen', 'grafana-baidu'];
  if (!TOOL_PLATFORMS.includes(platform)) return res.status(400).json({ error: '非平台工具账号' });

  // 取同步/托管记录（用于拿 email、access_key，以及后续清理）
  const synced = await db.get(
    'SELECT * FROM cloud_synced_users WHERE platform = ? AND cloud_username = ? ORDER BY synced_at DESC LIMIT 1',
    [platform, username]
  );
  const managed = await db.get(
    "SELECT * FROM cloud_users WHERE platform = ? AND cloud_username = ? AND status IN ('active','failed','pending') ORDER BY created_at DESC LIMIT 1",
    [platform, username]
  );
  if (!synced && !managed) return res.status(404).json({ error: '该平台工具账号不存在' });

  const email = synced?.email || null;
  const accessKey = managed?.cloud_access_key || null;

  let result = { success: true, message: '本地记录已删除' };
  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (cred) {
    result = await deleteCloudUser(platform, cred, username, accessKey, email);
  } else {
    result = { success: true, message: '未配置主账号凭据，仅删除本地记录' };
  }

  // 清理本地记录（同步表 + 托管表）
  await db.run('DELETE FROM cloud_synced_users WHERE platform = ? AND cloud_username = ?', [platform, username]);
  await db.run('DELETE FROM cloud_users WHERE platform = ? AND cloud_username = ?', [platform, username]);

  const cloudWarning = (!result.success) ? result.message : undefined;
  res.json({ ok: true, message: result.message, cloud_warning: cloudWarning });
});

// 禁用/启用某账号在指定云平台的子账号
router.patch('/:id/cloud/:platform/status', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { status } = req.body;
  if (!['active', 'disabled'].includes(status)) return res.status(400).json({ error: '无效状态' });

  const cu = await db.get(
    "SELECT * FROM cloud_users WHERE user_id = ? AND platform = ? ORDER BY created_at DESC LIMIT 1",
    [req.params.id, req.params.platform]
  );
  if (!cu) return res.status(404).json({ error: '该平台账号不存在' });

  const user = await db.get('SELECT id, email FROM users WHERE id = ?', [req.params.id]);
  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [req.params.platform]);

  let newAk = cu.cloud_access_key, newSk = cu.cloud_secret_key;
  let cloudError = null;

  if (cred) {
    try {
      if (status === 'disabled') {
        await disableCloudUser(cu.platform, cred, cu.cloud_username, cu.cloud_access_key);
      } else {
        const r = await enableCloudUser(cu.platform, cred, cu.cloud_username, user?.email, cu.cloud_access_key, cu.console_password);
        if (r.accessKey) { newAk = r.accessKey; newSk = r.secretKey; }
      }
    } catch (e) {
      cloudError = e.message;
      console.warn(`[accounts] 云端${status === 'disabled' ? '禁用' : '启用'}失败: ${e.message}`);
    }
  }

  await db.run(
    'UPDATE cloud_users SET status = ?, cloud_access_key = ?, cloud_secret_key = ? WHERE id = ?',
    [status, newAk, newSk, cu.id]
  );
  res.json({ ok: true, status, accessKey: newAk, cloud_warning: cloudError });
});

// 禁用/启用控制台登录（独立于 AK/SK）
router.patch('/:id/cloud/:platform/console', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { enabled, password } = req.body;
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: '参数错误' });

  const cu = await db.get(
    "SELECT * FROM cloud_users WHERE user_id = ? AND platform = ? ORDER BY created_at DESC LIMIT 1",
    [req.params.id, req.params.platform]
  );
  if (!cu) return res.status(404).json({ error: '该平台账号不存在' });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [req.params.platform]);
  let cloudError = null;

  if (cred) {
    try {
      if (enabled) {
        // 启用控制台：使用传入密码或已存密码
        const pwd = password || cu.console_password;
        if (!pwd) return res.status(400).json({ error: '请提供控制台密码' });
        await enableConsoleLogin(cu.platform, cred, cu.cloud_username, pwd);
        // 更新存储的密码
        if (password) {
          await db.run('UPDATE cloud_users SET console_password = ?, console_disabled = 0 WHERE id = ?', [password, cu.id]);
        } else {
          await db.run('UPDATE cloud_users SET console_disabled = 0 WHERE id = ?', [cu.id]);
        }
      } else {
        // 禁用控制台：删除 loginProfile
        await disableConsoleLogin(cu.platform, cred, cu.cloud_username);
        await db.run('UPDATE cloud_users SET console_disabled = 1 WHERE id = ?', [cu.id]);
      }
    } catch (e) {
      cloudError = e.message;
      console.warn(`[accounts] 云端控制台${enabled ? '启用' : '禁用'}失败: ${e.message}`);
    }
  }

  res.json({ ok: true, enabled, cloud_warning: cloudError });
});

// 获取某账号的云平台详情
router.get('/:id/cloud', authenticate, async (req, res) => {
  // 包含 disabled，使禁用 AK/SK 的账号仍可展示并可再启用；仅排除 failed 等无效记录
  const cloud = await db.all(
    "SELECT * FROM cloud_users WHERE user_id = ? AND status IN ('active','disabled') ORDER BY created_at DESC",
    [req.params.id]
  );
  // 同一平台只保留最新一条
  const seen = new Set();
  const deduped = cloud.filter(c => {
    if (seen.has(c.platform)) return false;
    seen.add(c.platform);
    return true;
  });
  res.json({ cloud_accounts: deduped.map(c => ({ ...c, policies: JSON.parse(c.policies || '[]'), groups: JSON.parse(c.groups || '[]') })) });
});

// 获取某账号的资源画像（云账号 + VPN + 存储桶 + RDS + 工单历史）
router.get('/:id/profile', authenticate, async (req, res) => {
  const targetId = req.params.id;
  // 非管理员只能查自己
  if (req.user.role !== 'admin' && req.user.id !== targetId) {
    return res.status(403).json({ error: '无权限' });
  }

  const user = await db.get('SELECT id, name, email, department, role, real_name, cloud_username FROM users WHERE id = ?', [targetId]);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 1. 通过工单创建的 managed 账号（去重取最新，排除失败记录）
  const cloudRaw = await db.all("SELECT * FROM cloud_users WHERE user_id = ? AND status != 'failed' ORDER BY created_at DESC", [targetId]);
  const seenManaged = new Set();
  const managedAccounts = cloudRaw
    .filter(c => { if (seenManaged.has(c.platform)) return false; seenManaged.add(c.platform); return true; })
    .map(c => ({ platform: c.platform, cloud_username: c.cloud_username, policies: JSON.parse(c.policies || '[]'), groups: JSON.parse(c.groups || '[]'), created_at: c.created_at, source: 'managed' }));

  // 2. 从 cloud_synced_users 获取实时同步账号
  //    条件: local_user_id 已关联 OR cloud_username 与用户资料一致（历史存量账号）
  let syncedRows = [];
  if (user.cloud_username) {
    syncedRows = await db.all(
      'SELECT * FROM cloud_synced_users WHERE local_user_id = ? OR cloud_username = ? ORDER BY synced_at DESC',
      [targetId, user.cloud_username]
    );
    // 自动关联: 将 cloud_username 匹配但 local_user_id 为空的记录绑定到当前用户
    for (const s of syncedRows) {
      if (!s.local_user_id && s.cloud_username === user.cloud_username) {
        await db.run('UPDATE cloud_synced_users SET local_user_id = ? WHERE id = ?', [targetId, s.id]);
      }
    }
  } else {
    syncedRows = await db.all(
      'SELECT * FROM cloud_synced_users WHERE local_user_id = ? ORDER BY synced_at DESC',
      [targetId]
    );
  }

  // 3. 合并 managed + synced（platform 唯一，managed 优先；policies 取同步最新值）
  const accountMap = new Map();
  for (const m of managedAccounts) {
    accountMap.set(m.platform, { ...m });
  }
  for (const s of syncedRows) {
    const syncedPolicies = JSON.parse(s.policies || '[]');
    if (accountMap.has(s.platform)) {
      // 已有 managed 记录，用同步数据更新 policies
      const existing = accountMap.get(s.platform);
      if (syncedPolicies.length > 0) existing.policies = syncedPolicies;
      existing.synced_at = s.synced_at;
    } else {
      // 纯同步账号（历史存量或未通过本平台创建的账号）
      accountMap.set(s.platform, {
        platform: s.platform,
        cloud_username: s.cloud_username,
        policies: syncedPolicies,
        groups: [],
        created_at: s.created_at_cloud || s.synced_at,
        synced_at: s.synced_at,
        source: 'synced',
      });
    }
  }

  // 4. 从 cloud_groups 反查用户所属的组（补充 groups 信息）
  const username = user.cloud_username;
  if (username) {
    const allGroups = await db.all('SELECT platform, group_name, members FROM cloud_groups');
    for (const g of allGroups) {
      const members = JSON.parse(g.members || '[]');
      if (members.includes(username)) {
        const acc = accountMap.get(g.platform);
        if (acc && !acc.groups.includes(g.group_name)) {
          acc.groups.push(g.group_name);
        }
      }
    }
  }

  const cloud_accounts = Array.from(accountMap.values());

  // 存储桶（cloud_buckets 有 user_id）
  const buckets = await db.all(
    'SELECT platform, name, region FROM cloud_buckets WHERE user_id = ? ORDER BY created_at DESC', [targetId]
  ).catch(() => []);

  // 工单历史（从 approval_tickets 聚合 VPN、RDS 资源）
  const tickets = await db.all(
    "SELECT id, status, cloud_result, vpn_result, storage_result, rds_result, created_at FROM approval_tickets WHERE submitter_id = ? AND status IN ('approved','completed') ORDER BY created_at DESC",
    [targetId]
  );

  // 从工单结果中提取 VPN 和 RDS 账号
  // VPN 账号：优先从 vpn_clients 表按 client_name 匹配
  let vpn_accounts = [];
  if (user.cloud_username) {
    vpn_accounts = await db.all(
      'SELECT platform, client_name, client_id, server_name, region, created_at FROM vpn_clients WHERE client_name LIKE ? ORDER BY created_at DESC',
      [`${user.cloud_username}%`]
    ).catch(() => []);
  }

  const rds_accounts = [];
  const seenRds = new Set();
  for (const t of tickets) {
    try {
      const rdsRes = t.rds_result ? JSON.parse(t.rds_result) : [];
      for (const r of rdsRes) {
        if (r.success) {
          const key = `${r.platform}:${r.instanceId}:${r.accountName}`;
          if (!seenRds.has(key)) { seenRds.add(key); rds_accounts.push(r); }
        }
      }
    } catch {}
  }

  // RDS 账号也从 cloud_db_accounts 补充（通过 ticket_id 关联）
  const ticketIds = tickets.map(t => t.id);
  let db_accounts = [];
  if (ticketIds.length > 0) {
    const placeholders = ticketIds.map(() => '?').join(',');
    db_accounts = await db.all(
      `SELECT platform, instance_id, instance_name, account_name, privilege, \`databases\`, status FROM cloud_db_accounts WHERE ticket_id IN (${placeholders}) AND status = 'active'`,
      ticketIds
    ).catch(() => []);
  }

  // 工单统计
  const allTickets = await db.all(
    "SELECT status FROM approval_tickets WHERE submitter_id = ?", [targetId]
  );
  const ticket_count = {
    total: allTickets.length,
    approved: allTickets.filter(t => t.status === 'completed' || t.status === 'approved').length,
    pending: allTickets.filter(t => t.status === 'pending').length,
    rejected: allTickets.filter(t => t.status === 'rejected').length,
  };

  res.json({ user, cloud_accounts, vpn_accounts, buckets, db_accounts, ticket_count });
});

const { PLATFORM_NAMES } = require('../utils/constants');

async function provisionCloudUser(platform, cred, username, policies, groups, notes, password, enable_console, email) {
  try {
    if (platform === 'aws')      return await createAwsIamUser(cred, username, policies, groups, notes, password, enable_console);
    if (platform === 'aliyun')   return await createAliyunRamUser(cred, username, policies, groups, notes, password, enable_console);
    if (platform === 'baidu')    return await createBaiduIamUser(cred, username, policies, groups, notes, password, enable_console);
    if (platform === 'bytebase')    return await createBytebaseUser(cred, username, email, password);
    if (platform === 'jumpserver')  return await createJumpServerUserAccount(cred, username, email, password);
    if (platform === 'kuboard')        return await createKuboardUser(cred, username, password, email);
    if (platform === 'grafana-aws')    return { success: true, message: '需手动在 Grafana (AWS) 控制台创建用户' };
    if (platform === 'grafana-wuwen')  return { success: true, message: '需手动在 Grafana (无问) 控制台创建用户' };
    if (platform === 'grafana-baidu')  return { success: true, message: '需手动在 Grafana (百度) 控制台创建用户' };
    return { success: false, message: '不支持的云平台' };
  } catch (err) {
    return { success: false, message: '云平台接口调用失败: ' + err.message };
  }
}

// Kuboard 访问密钥鉴权：Cookie 需 KuboardUsername=<密钥所属登录名> + KuboardAccessKey=<keyId.secret>。
// account_name 存登录名、secret_key 存完整密钥（keyId.secret）、access_key 存 URL。CF 头用于穿透 Cloudflare Access。
function kuboardHeaders(cred) {
  const loginUser = cred.account_name || 'admin';
  const headers = {
    'Content-Type': 'application/json',
    'Cookie': `KuboardUsername=${loginUser}; KuboardAccessKey=${cred.secret_key}`,
  };
  if (cred.cf_client_id && cred.cf_client_secret) {
    headers['CF-Access-Client-Id'] = cred.cf_client_id;
    headers['CF-Access-Client-Secret'] = cred.cf_client_secret;
  }
  return headers;
}

async function createKuboardUser(cred, username, password, email) {
  try {
    const base = (cred.access_key || '').replace(/\/$/, '');
    const url = `${base}/kuboard-api/cluster/GLOBAL/kind/KuboardAuthUser`;
    // 密码传明文，Kuboard 服务端自行 MD5 存储
    const resp = await fetch(url, {
      method: 'POST',
      headers: kuboardHeaders(cred),
      body: JSON.stringify({
        kind: 'KuboardAuthUser',
        apiVersion: 'v3',
        metadata: { name: username, cluster: 'GLOBAL' },
        spec: { password: password || '', fullName: username, email: email || '' },
        status: { enabled: true, passwordChangeRequired: false },
      }),
    });
    const text = await resp.text();
    if (resp.status === 200) {
      return { success: true, message: 'Kuboard 用户创建成功', loginUsername: username };
    }
    if (resp.status === 403) {
      return { success: false, message: 'Kuboard 鉴权失败：请检查设置页的登录用户名是否为密钥所属账号、访问密钥是否为完整格式（密钥ID.密钥）' };
    }
    let detail = '';
    try { detail = JSON.parse(text)?.message || ''; } catch { detail = text.slice(0, 200); }
    return { success: false, message: `Kuboard 创建失败 (HTTP ${resp.status}) ${detail}` };
  } catch (err) {
    return { success: false, message: 'Kuboard 接口调用失败: ' + err.message };
  }
}

async function deleteKuboardUser(cred, username) {
  try {
    const base = (cred.access_key || '').replace(/\/$/, '');
    const url = `${base}/kuboard-api/cluster/GLOBAL/kind/KuboardAuthUser/${encodeURIComponent(username)}`;
    const resp = await fetch(url, { method: 'DELETE', headers: kuboardHeaders(cred) });
    if (resp.status === 200 || resp.status === 404) {
      return { success: true, message: 'Kuboard 用户已删除' };
    }
    const text = await resp.text();
    return { success: false, message: `Kuboard 删除失败 (HTTP ${resp.status}) ${text.slice(0, 200)}` };
  } catch (err) {
    return { success: false, message: 'Kuboard 接口调用失败: ' + err.message };
  }
}

async function resetKuboardUserPassword(cred, username, newPassword) {
  try {
    const base = (cred.access_key || '').replace(/\/$/, '');
    // KuboardAuthUser 是幂等资源：用 PUT 更新同名用户的 spec.password（密码传明文，服务端 MD5 存储）
    const url = `${base}/kuboard-api/cluster/GLOBAL/kind/KuboardAuthUser/${encodeURIComponent(username)}`;
    const resp = await fetch(url, {
      method: 'PUT',
      headers: kuboardHeaders(cred),
      body: JSON.stringify({
        kind: 'KuboardAuthUser',
        apiVersion: 'v3',
        metadata: { name: username, cluster: 'GLOBAL' },
        spec: { password: newPassword || '', fullName: username },
        status: { enabled: true, passwordChangeRequired: false },
      }),
    });
    const text = await resp.text();
    if (resp.status === 200) {
      return { success: true, message: 'Kuboard 密码已重置' };
    }
    if (resp.status === 403) {
      return { success: false, message: 'Kuboard 鉴权失败：请检查设置页的登录用户名是否为密钥所属账号、访问密钥是否为完整格式（密钥ID.密钥）' };
    }
    if (resp.status === 404) {
      return { success: false, message: `Kuboard 用户 ${username} 不存在` };
    }
    let detail = '';
    try { detail = JSON.parse(text)?.message || ''; } catch { detail = text.slice(0, 200); }
    return { success: false, message: `Kuboard 密码重置失败 (HTTP ${resp.status}) ${detail}` };
  } catch (err) {
    return { success: false, message: 'Kuboard 接口调用失败: ' + err.message };
  }
}

async function createAwsIamUser(cred, username, policies, groups, notes, password, enable_console) {
  try {
    const { IAMClient, CreateUserCommand, CreateAccessKeyCommand, AttachUserPolicyCommand, AddUserToGroupCommand, CreateLoginProfileCommand } = require('@aws-sdk/client-iam');
    const client = new IAMClient({
      region: cred.region || 'us-east-1',
      credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
    });
    const createParams = { UserName: username };
    if (notes) createParams.Tags = [{ Key: 'Description', Value: notes.slice(0, 256) }];
    await client.send(new CreateUserCommand(createParams));
    if (enable_console && password) {
      try {
        await client.send(new CreateLoginProfileCommand({ UserName: username, Password: password, PasswordResetRequired: false }));
      } catch (e) {
        console.warn(`[accounts] AWS 创建控制台登录失败: ${e.message}`);
      }
    }
    const keyRes = await client.send(new CreateAccessKeyCommand({ UserName: username }));
    for (const policy of policies) {
      await client.send(new AttachUserPolicyCommand({ UserName: username, PolicyArn: `arn:aws:iam::aws:policy/${policy}` }));
    }
    for (const group of (groups || [])) {
      try {
        await client.send(new AddUserToGroupCommand({ GroupName: group, UserName: username }));
      } catch (err) {
        console.warn(`[accounts] AWS 加入组 ${group} 失败: ${err.message}`);
      }
    }
    return { success: true, accessKey: keyRes.AccessKey.AccessKeyId, secretKey: keyRes.AccessKey.SecretAccessKey, message: 'AWS IAM 用户创建成功' };
  } catch (err) {
    if (err.name === 'EntityAlreadyExistsException') {
      return { success: false, message: `用户名 ${username} 已存在，请更换用户名后重新申请` };
    }
    return { success: false, message: 'AWS 错误: ' + (err.message || err.Code) };
  }
}

async function createAliyunRamUser(cred, username, policies, groups, notes, password, enable_console) {
  try {
    const Core = require('@alicloud/pop-core');
    const client = new Core({
      accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
      endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01'
    });
    await client.request('CreateUser', { UserName: username, Comments: notes || '' }, { method: 'POST' });
    if (enable_console && password) {
      try {
        await client.request('CreateLoginProfile', { UserName: username, Password: password, PasswordResetRequired: 'False', MFABindRequired: 'False' }, { method: 'POST' });
      } catch (e) {
        console.warn(`[accounts] 阿里云创建控制台登录失败: ${e.message}`);
      }
    }
    const keyRes = await client.request('CreateAccessKey', { UserName: username }, { method: 'POST' });
    for (const policy of policies) {
      await client.request('AttachPolicyToUser', { PolicyType: 'System', PolicyName: policy, UserName: username }, { method: 'POST' });
    }
    for (const group of (groups || [])) {
      try {
        await client.request('AddUserToGroup', { GroupName: group, UserName: username }, { method: 'POST' });
      } catch (err) {
        console.warn(`[accounts] 阿里云加入组 ${group} 失败: ${err.message}`);
      }
    }

    // 获取主账号 alias/ID，用于构造登录用户名（zhangsan@accountAlias）
    let loginUsername = username;
    try {
      const aliasRes = await client.request('GetAccountAlias', {}, { method: 'GET' });
      const alias = aliasRes.AccountAlias;
      if (alias) loginUsername = `${username}@${alias}`;
    } catch (e) {
      console.warn(`[accounts] 阿里云获取主账号 alias 失败: ${e.message}`);
    }

    return {
      success: true,
      accessKey: keyRes.AccessKey?.AccessKeyId || '',
      secretKey: keyRes.AccessKey?.AccessKeySecret || '',
      loginUsername,
      message: '阿里云 RAM 用户创建成功'
    };
  } catch (err) {
    if (err.code === 'EntityAlreadyExists.User' || err.message?.includes('EntityAlreadyExists')) {
      return { success: false, message: `用户名 ${username} 已存在，请更换用户名后重新申请` };
    }
    return { success: false, message: '阿里云错误: ' + (err.message || err.Code) };
  }
}

async function createBaiduIamUser(cred, username, policies, groups, notes, password, enable_console) {
  try {
    // 1. 先查用户是否真实存在
    let userAlreadyExists = false;
    try {
      await bceRequest(cred, 'GET', `/v1/user/${encodeURIComponent(username)}`, {}, null);
      userAlreadyExists = true;
      console.log(`[accounts] 百度云用户 ${username} 已存在，跳过创建直接配置`);
    } catch (e) {
      // 用户不存在，正常创建
    }

    // 2. 如果用户不存在则创建
    if (!userAlreadyExists) {
      try {
        await bceRequest(cred, 'POST', '/v1/user', {}, { name: username, description: notes || '' });
      } catch (createErr) {
        if (createErr.message?.includes('already exist') || createErr.message?.includes('AlreadyExist')) {
          // API 说存在但 GET 查不到 → 百度云脏数据，尝试等一下重试
          console.warn(`[accounts] 百度云用户 ${username} 存在脏数据（创建报已存在但查不到），等待 3 秒后重试`);
          await new Promise(r => setTimeout(r, 3000));
          try {
            await bceRequest(cred, 'POST', '/v1/user', {}, { name: username, description: notes || '' });
          } catch (retryErr) {
            return { success: false, message: `百度云用户 ${username} 创建冲突（百度云侧残留数据），请联系百度云客服清理后重试` };
          }
        } else {
          throw createErr;
        }
      }
    }

    // 3. 设置控制台登录
    if (enable_console && password) {
      try {
        await bceRequest(cred, 'PUT', `/v1/user/${encodeURIComponent(username)}/loginProfile`, {}, { enabledLogin: true, password });
      } catch (e) {
        console.warn(`[accounts] 百度云创建控制台登录失败: ${e.message}`);
      }
    }

    // 4. 创建 AccessKey
    const keyRes = await bceRequest(cred, 'POST', `/v1/user/${encodeURIComponent(username)}/accesskey`, {}, {});
    const accessKey = keyRes.id || keyRes.accessKeyId || '';
    const secretKey = keyRes.secret || keyRes.secretKey || '';

    // 5. 附加策略
    for (const policy of policies) {
      try {
        await bceRequest(cred, 'PUT', `/v1/user/${encodeURIComponent(username)}/policy/${encodeURIComponent(policy)}`, {}, {});
      } catch {}
    }

    // 6. 加入用户组
    for (const group of (groups || [])) {
      try {
        await bceRequest(cred, 'PUT', `/v1/group/${encodeURIComponent(group)}/user/${encodeURIComponent(username)}`, {}, {});
      } catch (err) {
        console.warn(`[accounts] 百度云加入组 ${group} 失败: ${err.message}`);
      }
    }

    return { success: true, accessKey, secretKey, loginUsername: username, message: userAlreadyExists ? '百度智能云 IAM 用户已存在，已完成配置' : '百度智能云 IAM 用户创建成功' };
  } catch (err) {
    return { success: false, message: '百度云错误: ' + err.message };
  }
}

async function disableCloudUser(platform, cred, username, accessKeyId) {
  if (platform === 'aws') {
    const { IAMClient, UpdateAccessKeyCommand, DeleteLoginProfileCommand } = require('@aws-sdk/client-iam');
    const client = new IAMClient({ region: cred.region || 'us-east-1', credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
    // 禁用 AK
    if (accessKeyId) {
      try {
        await client.send(new UpdateAccessKeyCommand({ UserName: username, AccessKeyId: accessKeyId, Status: 'Inactive' }));
      } catch (e) {
        console.warn(`[accounts] AWS 禁用AK失败: ${e.message}`);
      }
    }
    // 删除控制台登录
    try {
      await client.send(new DeleteLoginProfileCommand({ UserName: username }));
    } catch (e) {
      if (e.name !== 'NoSuchEntityException') console.warn(`[accounts] AWS 删除控制台登录失败: ${e.message}`);
    }
    return;
  }
  if (platform === 'aliyun') {
    const Core = require('@alicloud/pop-core');
    const client = new Core({ accessKeyId: cred.access_key, accessKeySecret: cred.secret_key, endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01' });
    // 阿里云无直接禁用用户接口，同时禁 AK + 删控制台登录
    if (accessKeyId) {
      try {
        await client.request('UpdateAccessKey', { UserName: username, UserAccessKeyId: accessKeyId, Status: 'Inactive' }, { method: 'POST' });
      } catch (e) {
        console.warn(`[accounts] 阿里云禁用AK失败: ${e.message}`);
      }
    }
    try {
      await client.request('DeleteLoginProfile', { UserName: username }, { method: 'POST' });
    } catch (e) {
      // EntityNotExist.User.LoginProfile 表示本来就没有控制台登录，忽略
      if (!e.message?.includes('EntityNotExist')) console.warn(`[accounts] 阿里云删除控制台登录失败: ${e.message}`);
    }
    return;
  }
  if (platform === 'baidu') {
    try {
      // 百度云 IAM 直接 API 不支持禁用 AK，通过删除 AK 实现（启用时重建）
      const akList = await bceRequest(cred, 'GET', `/v1/user/${encodeURIComponent(username)}/accesskey`, {}, null);
      if (akList.accessKeys && Array.isArray(akList.accessKeys)) {
        for (const ak of akList.accessKeys) {
          try {
            await bceRequest(cred, 'DELETE', `/v1/user/${encodeURIComponent(username)}/accesskey/${ak.id}`, {}, null);
          } catch (e) {
            console.warn(`[accounts] 百度云删除AK ${ak.id} 失败: ${e.message}`);
          }
        }
      }
    } catch (e) {
      console.warn(`[accounts] 百度云禁用AK失败: ${e.message}`);
      throw e;
    }
    return;
  }
}

async function enableCloudUser(platform, cred, username, email, accessKeyId, consolePassword) {
  if (platform === 'aws') {
    const { IAMClient, UpdateAccessKeyCommand, CreateAccessKeyCommand, CreateLoginProfileCommand } = require('@aws-sdk/client-iam');
    const client = new IAMClient({ region: cred.region || 'us-east-1', credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
    if (accessKeyId) {
      // 重新激活原有 AK，不创建新的
      await client.send(new UpdateAccessKeyCommand({ UserName: username, AccessKeyId: accessKeyId, Status: 'Active' }));
    } else {
      // 原来没有 AK 记录时才创建新的
      const keyRes = await client.send(new CreateAccessKeyCommand({ UserName: username }));
      return { accessKey: keyRes.AccessKey.AccessKeyId, secretKey: keyRes.AccessKey.SecretAccessKey };
    }
    // 重建控制台登录（使用原始密码）
    if (consolePassword) {
      try {
        await client.send(new CreateLoginProfileCommand({ UserName: username, Password: consolePassword, PasswordResetRequired: false }));
      } catch (e) {
        if (e.name !== 'EntityAlreadyExistsException') console.warn(`[accounts] AWS 重建控制台登录失败: ${e.message}`);
      }
    }
    return {};
  }
  if (platform === 'aliyun') {
    const Core = require('@alicloud/pop-core');
    const client = new Core({ accessKeyId: cred.access_key, accessKeySecret: cred.secret_key, endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01' });
    if (accessKeyId) {
      // 重新激活原有 AK，不创建新的
      await client.request('UpdateAccessKey', { UserName: username, UserAccessKeyId: accessKeyId, Status: 'Active' }, { method: 'POST' });
    } else {
      // 原来没有 AK 记录时才创建新的
      const keyRes = await client.request('CreateAccessKey', { UserName: username }, { method: 'POST' });
      return { accessKey: keyRes.AccessKey?.AccessKeyId || '', secretKey: keyRes.AccessKey?.AccessKeySecret || '' };
    }
    // 重建控制台登录（使用原始密码）
    if (consolePassword) {
      try {
        await client.request('CreateLoginProfile', { UserName: username, Password: consolePassword, PasswordResetRequired: false }, { method: 'POST' });
      } catch (e) {
        if (!e.message?.includes('EntityAlreadyExists')) console.warn(`[accounts] 阿里云重建控制台登录失败: ${e.message}`);
      }
    }
    return {};
  }
  if (platform === 'baidu') {
    try {
      // 禁用时已删除 AK，重新创建
      const keyRes = await bceRequest(cred, 'POST', `/v1/user/${encodeURIComponent(username)}/accesskey`, {}, {});
      const accessKey = keyRes.id || keyRes.accessKeyId || '';
      const secretKey = keyRes.secret || keyRes.secretKey || '';
      return { accessKey, secretKey };
    } catch (e) {
      console.warn(`[accounts] 百度云启用AK失败: ${e.message}`);
      throw e;
    }
  }
  return {};
}

async function deleteCloudUser(platform, cred, username, accessKeyId, email) {
  try {
    if (platform === 'aws')      return await deleteAwsIamUser(cred, username, accessKeyId);
    if (platform === 'aliyun')   return await deleteAliyunRamUser(cred, username, accessKeyId);
    if (platform === 'baidu')    return await deleteBaiduIamUser(cred, username);
    if (platform === 'bytebase')    return await deleteBytebaseUser(cred, email);
    if (platform === 'jumpserver')  return await deleteJumpServerUser(cred, username);
    if (platform === 'kuboard')        return await deleteKuboardUser(cred, username);
    if (platform === 'grafana-aws')    return { success: true, message: 'Grafana (AWS) 账号需手动在控制台删除' };
    if (platform === 'grafana-wuwen')  return { success: true, message: 'Grafana (无问) 账号需手动在控制台删除' };
    if (platform === 'grafana-baidu')  return { success: true, message: 'Grafana (百度) 账号需手动在控制台删除' };
    return { success: false, message: '不支持的云平台' };
  } catch (err) {
    return { success: false, message: '云平台接口调用失败: ' + err.message };
  }
}

async function deleteAwsIamUser(cred, username) {
  try {
    const { IAMClient, ListGroupsForUserCommand, RemoveUserFromGroupCommand, ListAttachedUserPoliciesCommand, DetachUserPolicyCommand, ListAccessKeysCommand, DeleteAccessKeyCommand, DeleteLoginProfileCommand, DeleteUserCommand } = require('@aws-sdk/client-iam');
    const client = new IAMClient({
      region: cred.region || 'us-east-1',
      credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
    });
    // 1. 先退出所有组
    try {
      const { Groups } = await client.send(new ListGroupsForUserCommand({ UserName: username }));
      for (const g of Groups || []) {
        await client.send(new RemoveUserFromGroupCommand({ GroupName: g.GroupName, UserName: username }));
      }
    } catch {}
    // 2. 解除策略
    const { AttachedPolicies } = await client.send(new ListAttachedUserPoliciesCommand({ UserName: username }));
    for (const p of AttachedPolicies || []) {
      await client.send(new DetachUserPolicyCommand({ UserName: username, PolicyArn: p.PolicyArn }));
    }
    // 3. 删除 AccessKey
    const { AccessKeyMetadata } = await client.send(new ListAccessKeysCommand({ UserName: username }));
    for (const k of AccessKeyMetadata || []) {
      await client.send(new DeleteAccessKeyCommand({ UserName: username, AccessKeyId: k.AccessKeyId }));
    }
    // 4. 删除 Login Profile（控制台登录密码），不存在时忽略
    try {
      await client.send(new DeleteLoginProfileCommand({ UserName: username }));
    } catch (e) {
      if (e.name !== 'NoSuchEntityException') throw e;
    }
    // 5. 删除用户
    await client.send(new DeleteUserCommand({ UserName: username }));
    return { success: true, message: 'AWS IAM 用户已删除' };
  } catch (err) {
    if (err.name === 'NoSuchEntityException') return { success: true, message: 'AWS IAM 用户不存在，已跳过' };
    return { success: false, message: 'AWS 错误: ' + (err.message || err.Code) };
  }
}

async function deleteAliyunRamUser(cred, username) {
  try {
    const Core = require('@alicloud/pop-core');
    const client = new Core({
      accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
      endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01'
    });
    try {
      const gr = await client.request('ListGroupsForUser', { UserName: username }, { method: 'POST' });
      for (const g of gr.Groups?.Group || []) {
        await client.request('RemoveUserFromGroup', { GroupName: g.GroupName, UserName: username }, { method: 'POST' });
      }
    } catch {}
    try {
      const pr = await client.request('ListPoliciesForUser', { UserName: username }, { method: 'POST' });
      for (const p of pr.Policies?.Policy || []) {
        await client.request('DetachPolicyFromUser', { PolicyType: p.PolicyType, PolicyName: p.PolicyName, UserName: username }, { method: 'POST' });
      }
    } catch {}
    try {
      const kr = await client.request('ListAccessKeys', { UserName: username }, { method: 'POST' });
      for (const k of kr.AccessKeys?.AccessKey || []) {
        await client.request('DeleteAccessKey', { UserName: username, UserAccessKeyId: k.AccessKeyId }, { method: 'POST' });
      }
    } catch {}
    await client.request('DeleteUser', { UserName: username }, { method: 'POST' });
    return { success: true, message: '阿里云 RAM 用户已删除' };
  } catch (err) {
    if (err.code === 'EntityNotExist.User') return { success: true, message: '阿里云 RAM 用户不存在，已跳过' };
    return { success: false, message: '阿里云错误: ' + (err.message || err.Code) };
  }
}

async function deleteBaiduIamUser(cred, username) {
  try {
    // 1. 先将用户从所有组中移除（百度云要求删用户前必须清除组关联）
    try {
      const gr = await bceRequest(cred, 'GET', `/v1/user/${encodeURIComponent(username)}/group`, {}, null);
      for (const g of gr.groups || []) {
        const gname = g.name || g.groupName;
        if (gname) {
          try {
            await bceRequest(cred, 'DELETE', `/v1/group/${encodeURIComponent(gname)}/user/${encodeURIComponent(username)}`, {}, null);
          } catch {}
        }
      }
    } catch {}
    // 2. 解除策略
    try {
      const pr = await bceRequest(cred, 'GET', `/v1/user/${encodeURIComponent(username)}/policy`, {}, null);
      for (const p of pr.policies || []) {
        const pname = p.name || p.policyName;
        if (pname) await bceRequest(cred, 'DELETE', `/v1/user/${encodeURIComponent(username)}/policy/${encodeURIComponent(pname)}`, {}, null);
      }
    } catch {}
    // 3. 删除 AccessKey
    try {
      const kr = await bceRequest(cred, 'GET', `/v1/user/${encodeURIComponent(username)}/accesskey`, {}, null);
      for (const k of kr.accessKeys || []) {
        const kid = k.id || k.accessKeyId;
        if (kid) await bceRequest(cred, 'DELETE', `/v1/user/${encodeURIComponent(username)}/accesskey/${kid}`, {}, null);
      }
    } catch {}
    // 4. 删除用户
    await bceRequest(cred, 'DELETE', `/v1/user/${encodeURIComponent(username)}`, {}, null);
    return { success: true, message: '百度智能云 IAM 用户已删除' };
  } catch (err) {
    if (/NoSuchUser|not found|404/i.test(err.message)) return { success: true, message: '百度智能云 IAM 用户不存在，已跳过' };
    return { success: false, message: '百度云错误: ' + err.message };
  }
}

async function createBytebaseUser(cred, username, email, password) {
  return await createBytebaseMember(cred, email, username, password);
}

async function deleteBytebaseUser(cred, username) {
  // username 在 Bytebase 语境下就是邮箱
  return await deleteBytebaseMember(cred, username);
}

async function createJumpServerUserAccount(cred, username, email, password) {
  return await createJumpServerUser(cred, username, email, username, password);
}

/** 获取云平台控制台登录链接 */
async function getConsoleLoginUrl(platform, cred) {
  const { getConsoleLoginUrl: getUrl } = require('../utils/platform-registry');
  return getUrl(platform, cred);
}

module.exports = router;
module.exports.provisionCloudUser = provisionCloudUser;

async function disableConsoleLogin(platform, cred, username) {
  if (platform === 'aws') {
    const { IAMClient, DeleteLoginProfileCommand } = require('@aws-sdk/client-iam');
    const client = new IAMClient({ region: cred.region || 'us-east-1', credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
    try {
      await client.send(new DeleteLoginProfileCommand({ UserName: username }));
    } catch (e) {
      if (e.name !== 'NoSuchEntityException') throw e;
    }
    return;
  }
  if (platform === 'aliyun') {
    const Core = require('@alicloud/pop-core');
    const client = new Core({ accessKeyId: cred.access_key, accessKeySecret: cred.secret_key, endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01' });
    try {
      await client.request('DeleteLoginProfile', { UserName: username }, { method: 'POST' });
    } catch (e) {
      if (!e.message?.includes('EntityNotExist')) throw e;
    }
    return;
  }
  if (platform === 'baidu') {
    try {
      await bceRequest(cred, 'DELETE', `/v1/user/${encodeURIComponent(username)}/loginProfile`, {}, null);
    } catch (e) {
      if (!e.message?.includes('does not exist')) throw e;
    }
    return;
  }
}

async function enableConsoleLogin(platform, cred, username, consolePassword) {
  if (platform === 'aws') {
    const { IAMClient, CreateLoginProfileCommand, UpdateLoginProfileCommand } = require('@aws-sdk/client-iam');
    const client = new IAMClient({ region: cred.region || 'us-east-1', credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
    try {
      await client.send(new CreateLoginProfileCommand({ UserName: username, Password: consolePassword, PasswordResetRequired: false }));
    } catch (e) {
      if (e.name === 'EntityAlreadyExistsException') {
        await client.send(new UpdateLoginProfileCommand({ UserName: username, Password: consolePassword, PasswordResetRequired: false }));
      } else { throw e; }
    }
    return;
  }
  if (platform === 'aliyun') {
    const Core = require('@alicloud/pop-core');
    const client = new Core({ accessKeyId: cred.access_key, accessKeySecret: cred.secret_key, endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01' });
    try {
      await client.request('CreateLoginProfile', { UserName: username, Password: consolePassword, PasswordResetRequired: false }, { method: 'POST' });
    } catch (e) {
      if (!e.message?.includes('EntityAlreadyExists')) throw e;
    }
    return;
  }
  if (platform === 'baidu') {
    await bceRequest(cred, 'PUT', `/v1/user/${encodeURIComponent(username)}/loginProfile`, {}, { enabledLogin: true, password: consolePassword });
    return;
  }
}
module.exports.getConsoleLoginUrl = getConsoleLoginUrl;
module.exports.resetKuboardUserPassword = resetKuboardUserPassword;
