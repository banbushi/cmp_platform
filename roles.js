const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../utils/database');
const { authenticate, requireAdmin } = require('../middleware/auth');

const router = express.Router();

function parseRole(r) {
  return {
    ...r,
    accessible_groups: JSON.parse(r.accessible_groups || '[]'),
    ticket_platforms:  JSON.parse(r.ticket_platforms || 'null'),
    can_operate: !!r.can_operate,
    is_builtin:  !!r.is_builtin
  };
}

// 获取所有角色
// 注意：这里**故意不加 requireAdmin**。每个用户登录时 permissions.js 的
// loadAndApplyPermissions() 都要调本接口来算自己的可见菜单与操作权限，
// 加了 admin 限制会导致所有非 admin 用户登录即白屏。
// 写操作（POST/PUT/DELETE）才是需要锁的，见下方三个接口。
router.get('/', authenticate, async (req, res) => {
  const rows = await db.all('SELECT * FROM system_roles ORDER BY is_builtin DESC, created_at ASC');
  res.json({ roles: rows.map(parseRole) });
});

// 创建自定义角色
router.post('/', authenticate, requireAdmin, async (req, res) => {
  const { name, display_name, description, accessible_groups, ticket_platforms, can_operate } = req.body;
  if (!name || !display_name) return res.status(400).json({ error: '请填写角色标识和显示名' });
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) return res.status(400).json({ error: '角色标识只能包含小写字母、数字、下划线和连字符' });

  const existing = await db.get('SELECT id FROM system_roles WHERE name = ?', [name]);
  if (existing) return res.status(409).json({ error: '角色标识已存在' });

  const id = uuidv4();
  await db.run(
    'INSERT INTO system_roles (id, name, display_name, description, accessible_groups, ticket_platforms, can_operate, is_builtin) VALUES (?, ?, ?, ?, ?, ?, ?, 0)',
    [id, name, display_name, description || '', JSON.stringify(accessible_groups || []), JSON.stringify(ticket_platforms || null), can_operate ? 1 : 0]
  );
  res.status(201).json({ message: '角色创建成功', id });
});

// 修改角色（不可修改内置角色）
router.put('/:id', authenticate, requireAdmin, async (req, res) => {
  const role = await db.get('SELECT * FROM system_roles WHERE id = ?', [req.params.id]);
  if (!role) return res.status(404).json({ error: '角色不存在' });
  if (role.is_builtin) return res.status(403).json({ error: '内置角色不可修改' });

  const { display_name, description, accessible_groups, ticket_platforms, can_operate } = req.body;
  await db.run(
    'UPDATE system_roles SET display_name=?, description=?, accessible_groups=?, ticket_platforms=?, can_operate=? WHERE id=?',
    [display_name, description || '', JSON.stringify(accessible_groups || []), JSON.stringify(ticket_platforms || null), can_operate ? 1 : 0, req.params.id]
  );
  res.json({ message: '角色已更新' });
});

// 删除角色（不可删除内置角色 & 仍有用户使用的角色）
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  const role = await db.get('SELECT * FROM system_roles WHERE id = ?', [req.params.id]);
  if (!role) return res.status(404).json({ error: '角色不存在' });
  if (role.is_builtin) return res.status(403).json({ error: '内置角色不可删除' });

  const inUse = await db.get('SELECT id FROM users WHERE role = ?', [role.name]);
  if (inUse) return res.status(409).json({ error: '仍有系统账号使用该角色，请先更换账号角色' });

  await db.run('DELETE FROM system_roles WHERE id = ?', [req.params.id]);
  res.json({ message: '角色已删除' });
});

module.exports = router;
