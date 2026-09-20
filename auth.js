const jwt = require('jsonwebtoken');
const db = require('../utils/database');

const JWT_SECRET = process.env.JWT_SECRET || 'cloud-iam-dev-secret-x9k2m7';
if (!process.env.JWT_SECRET) {
  console.warn('  ⚠ 未设置 JWT_SECRET 环境变量，使用内置开发密钥（生产环境请务必配置）');
}

async function authenticate(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: '未授权，请先登录' });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(403).json({ error: 'Token 无效或已过期' });
  }

  // auto-sync 的内部身份，users 表中无对应行
  if (decoded.id === 'system') {
    req.user = decoded;
    return next();
  }

  // 角色以库为准而非 token：JWT 有效期 24h 且无刷新机制，
  // 若沿用 token 里的快照，改角色/禁用最长 24h 后才生效
  try {
    const row = await db.get('SELECT role, status FROM users WHERE id = ?', [decoded.id]);
    if (!row) return res.status(403).json({ error: '账号不存在' });
    if (row.status === 'disabled') return res.status(403).json({ error: '该账号已被禁用，请联系管理员' });
    req.user = { ...decoded, role: row.role };
    next();
  } catch (err) {
    next(err);
  }
}

// 按角色的 accessible_groups 校验菜单分组访问权。
// 前端隐藏菜单只是展示层，接口仍需自行拦截，否则换个角色直接调 API 就能拿到数据。
function requireGroup(group) {
  return async (req, res, next) => {
    if (req.user?.id === 'system') return next();
    try {
      const role = await db.get('SELECT accessible_groups FROM system_roles WHERE name = ?', [req.user.role]);
      const groups = JSON.parse(role?.accessible_groups || '[]');
      if (!groups.includes(group)) return res.status(403).json({ error: '无权限访问该功能' });
      next();
    } catch (err) {
      next(err);
    }
  };
}

// 在 requireGroup 之上再要求 can_operate：用于「有该分组的写操作权」的接口。
// 只读角色（viewer/billing）能看见分组但不能改，故不能只判分组。
function requireOperate(group) {
  return async (req, res, next) => {
    if (req.user?.id === 'system') return next();
    try {
      const role = await db.get(
        'SELECT accessible_groups, can_operate FROM system_roles WHERE name = ?', [req.user.role]
      );
      const groups = JSON.parse(role?.accessible_groups || '[]');
      if (!groups.includes(group)) return res.status(403).json({ error: '无权限访问该功能' });
      if (!role.can_operate) return res.status(403).json({ error: '当前角色为只读，无操作权限' });
      next();
    } catch (err) {
      next(err);
    }
  };
}

// 仅管理员。项目里另有 30+ 处内联 `req.user.role !== 'admin'` 判断，
// 本次不重构那些，新接口统一用这个。
function requireAdmin(req, res, next) {
  if (req.user?.id === 'system') return next();
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可访问' });
  }
  next();
}

module.exports = { authenticate, requireGroup, requireOperate, requireAdmin, JWT_SECRET };
