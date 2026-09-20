const express = require('express');
const db = require('../utils/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { MODULE_LABELS } = require('../middleware/audit');

const router = express.Router();

// 审计日志仅管理员可见。前端藏菜单不算安全，接口这里强制校验。
router.use(authenticate, requireAdmin);

// 把列表/清理共用的筛选条件拼成 WHERE
function buildWhere(q) {
  const where = [];
  const params = [];

  if (q.user_id)            { where.push('user_id = ?');     params.push(q.user_id); }
  if (q.module)             { where.push('module = ?');      params.push(q.module); }
  if (q.method)             { where.push('method = ?');      params.push(q.method); }
  if (q.success === '0' || q.success === '1') {
    where.push('success = ?'); params.push(Number(q.success));
  }
  // 时间范围：start 含当日 00:00:00，end 含当日 23:59:59
  if (q.start)              { where.push('created_at >= ?'); params.push(`${q.start} 00:00:00`); }
  if (q.end)                { where.push('created_at <= ?'); params.push(`${q.end} 23:59:59`); }
  if (q.keyword) {
    where.push('(path LIKE ? OR action LIKE ? OR user_name LIKE ? OR user_email LIKE ?)');
    const kw = `%${q.keyword}%`;
    params.push(kw, kw, kw, kw);
  }

  return { sql: where.length ? 'WHERE ' + where.join(' AND ') : '', params };
}

// GET /api/audit — 分页列表
router.get('/', async (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 20));
  const offset   = (page - 1) * pageSize;

  const { sql, params } = buildWhere(req.query);

  const countRow = await db.get(`SELECT COUNT(*) AS n FROM audit_logs ${sql}`, params);
  const items = await db.all(
    `SELECT id, user_id, user_name, user_email, user_role, method, path, route, module, action,
            status_code, success, req_body, error_msg, ip, user_agent, duration_ms, created_at
       FROM audit_logs ${sql}
      ORDER BY created_at DESC, id DESC
      LIMIT ? OFFSET ?`,
    [...params, pageSize, offset]
  );

  res.json({
    total: countRow?.n || 0,
    items: items.map(r => ({ ...r, success: !!r.success })),
  });
});

// GET /api/audit/facets — 筛选下拉数据（有记录的模块与操作人）
router.get('/facets', async (req, res) => {
  const [modules, users, range] = await Promise.all([
    db.all("SELECT module, COUNT(*) AS n FROM audit_logs WHERE module IS NOT NULL GROUP BY module ORDER BY n DESC"),
    db.all(`SELECT user_id, MAX(user_name) AS user_name, MAX(user_email) AS user_email, COUNT(*) AS n
              FROM audit_logs WHERE user_id IS NOT NULL
             GROUP BY user_id ORDER BY n DESC LIMIT 200`),
    db.get('SELECT MIN(created_at) AS earliest, MAX(created_at) AS latest, COUNT(*) AS total FROM audit_logs'),
  ]);

  res.json({
    modules: modules.map(m => ({ value: m.module, label: MODULE_LABELS[m.module] || m.module, count: m.n })),
    users,
    stats: range || { earliest: null, latest: null, total: 0 },
  });
});

// 审计日志只读，不提供删除接口：
// 能被清理的审计等于没有审计，且删除动作本身也会被记进审计，很荒谬。
// 如需清理（例如表过大），走 DBA 手工 SQL，不从应用层开这个口子。

module.exports = router;
