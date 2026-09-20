// ─────────────────────────────────────────────────────────────
// 操作审计中间件
//
// 设计要点（改动前请先读完，几处都是踩过坑的）：
//
// 1) 只记写操作（POST/PUT/DELETE/PATCH）+ 登录事件。不记普通 GET——
//    93 个读接口里光概览页一次加载就发 15 个请求，会把真实操作淹没。
//
// 2) 用 res.on('finish') 而非在 handler 里埋点：本中间件注册在所有路由之前
//    （因为要先挂上钩子），但 finish 回调在 handler 跑完才触发，此时各路由的
//    authenticate 已把 req.user 挂好。这样既能读到已解析的 req.body，
//    又能读到身份，且**无需改动 88 个 handler**。
//
// 3) 写库一律 fire-and-forget：不 await、失败只 console 告警。
//    审计绝不能拖慢或搞挂真实请求。
// ─────────────────────────────────────────────────────────────

const { v4: uuidv4 } = require('uuid');
const db = require('../utils/database');

const AUDIT_METHODS = new Set(['POST', 'PUT', 'DELETE', 'PATCH']);

// req_body 落库上限，超出截断（避免超长 body 撑爆表）
const MAX_BODY_CHARS = 8000;

// ── 脱敏 ─────────────────────────────────────────────────────
// 写接口的请求体里高频出现密码与云凭据：access_key(142处)/secret_key(135)/
// password(93)/token(48)…… 一律不得落库明文。
// 匹配用「键名小写后包含子串」，能覆盖 accessKey/access_key/AccessKeyId 等各种写法。
// 保留键名、只替换值，这样仍看得出「改过密码」这件事。
const SECRET_KEY_PARTS = [
  'password', 'passwd', 'secret', 'token', 'cookie',
  'accesskey', 'access_key', 'secretkey', 'secret_key',
  'privatekey', 'private_key', 'credential', 'apikey', 'api_key',
];

// 需整体匹配的短键名（'ak'/'sk' 太短，子串匹配会误伤 task/mask 等）
const SECRET_KEY_EXACT = new Set(['ak', 'sk', 'pwd']);

function isSecretKey(key) {
  const k = String(key).toLowerCase();
  if (SECRET_KEY_EXACT.has(k)) return true;
  return SECRET_KEY_PARTS.some(p => k.includes(p));
}

function redact(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (typeof value !== 'object') return value;

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSecretKey(k)) {
      out[k] = '***';
    } else if (v && typeof v === 'object') {
      out[k] = redact(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function serializeBody(body) {
  if (!body || typeof body !== 'object' || Object.keys(body).length === 0) return null;
  try {
    let s = JSON.stringify(redact(body));
    if (s && s.length > MAX_BODY_CHARS) {
      s = s.slice(0, MAX_BODY_CHARS) + `…[已截断，原长度 ${s.length}]`;
    }
    return s;
  } catch (_) {
    return null;
  }
}

// ── 动作标签 ─────────────────────────────────────────────────
// key = `${METHOD} ${baseUrl}${route.path}`，如 'DELETE /api/pai/dsw/:id'
//
// 这里只登记高价值/破坏性操作。未登记的走 fallbackAction() 自动生成，
// 保证**永不丢记录**，只是标签不如手写的漂亮。新增路由忘了登记也不会出问题。
const ACTION_LABELS = {
  // 账号与登录
  'POST /api/accounts/login':                        '登录',
  'POST /api/accounts/create':                       '创建云账号',
  'DELETE /api/accounts/:id':                        '删除用户',
  'DELETE /api/accounts/:id/cloud/:platform':        '删除用户的云账号',
  'DELETE /api/accounts/tool-account/:platform/:username': '删除平台工具账号',
  'PATCH /api/accounts/:id/cloud/:platform/status':  '启停用户云账号',
  'PATCH /api/accounts/:id/cloud/:platform/console': '改云账号控制台登录',
  'POST /api/accounts/admins':                       '创建系统账号',
  'PUT /api/accounts/admins/:id':                    '修改系统账号',
  'PUT /api/accounts/admins/:id/password':           '重置系统账号密码',
  'DELETE /api/accounts/admins/:id':                 '删除系统账号',
  'PUT /api/accounts/login-users/:id/status':        '启停飞书登录用户',
  'PUT /api/accounts/login-users/:id/role':          '修改飞书用户角色',
  'DELETE /api/accounts/login-users/:id':            '删除飞书登录用户',
  'POST /api/accounts/synced/bind':                  '绑定已同步云账号',
  'POST /api/accounts/jumpserver-user':              '创建 JumpServer 账号',
  'POST /api/accounts/bytebase-user':                '创建 Bytebase 账号',
  'POST /api/accounts/kuboard-user':                 '创建 Kuboard 账号',
  'POST /api/accounts/me/profile':                   '修改个人资料',
  'PUT /api/accounts/me':                            '修改个人信息',

  // 角色与权限
  'POST /api/roles':                                 '创建角色',
  'PUT /api/roles/:id':                              '修改角色权限',
  'DELETE /api/roles/:id':                           '删除角色',

  // 云凭据（高敏感）
  'POST /api/cloud/credentials':                     '配置云平台凭据',
  'DELETE /api/cloud/credentials/:platform':         '删除云平台凭据',
  'POST /api/cloud/credentials/test':                '测试云平台凭据',
  'POST /api/cloud/policies/custom':                 '创建自定义策略',

  // 云主机
  'POST /api/instances':                             '创建云主机',
  'POST /api/instances/:id/start':                   '启动云主机',
  'POST /api/instances/:id/stop':                    '停止云主机',
  'DELETE /api/instances/:id':                       '删除云主机',

  // PAI DSW
  'POST /api/pai/dsw':                               '创建 DSW 实例',
  'POST /api/pai/dsw/:id/start':                     '启动 DSW 实例',
  'POST /api/pai/dsw/:id/stop':                      '停止 DSW 实例',
  'DELETE /api/pai/dsw/:id':                         '删除 DSW 实例',
  'POST /api/pai/workspaces/:wsId/members':          '添加 PAI 工作空间成员',
  'DELETE /api/pai/workspaces/:wsId/members/:memberId': '移除 PAI 工作空间成员',

  // 数据库
  'POST /api/rds/instances':                         '创建数据库实例',
  'POST /api/bytebase/instances':                    '新增 Bytebase 实例',
  'PUT /api/bytebase/instances/:id':                 '修改 Bytebase 实例',
  'DELETE /api/bytebase/instances/:id':              '删除 Bytebase 实例',

  // 集群
  'POST /api/clusters/groups':                       '创建集群业务组',
  'PUT /api/clusters/groups/:id':                    '修改集群业务组',
  'DELETE /api/clusters/groups/:id':                 '删除集群业务组',

  // 存储
  'POST /api/storage/buckets':                       '创建存储桶',
  'POST /api/storage/grant':                         '存储桶授权',
  'POST /api/storage/check-permission':              '校验存储权限',

  // 堡垒机
  'POST /api/jumpserver/assets':                     '创建堡垒机资产',
  'DELETE /api/jumpserver/assets/:id':               '删除堡垒机资产',
  'POST /api/jumpserver/assets/:id/grant':           '堡垒机资产授权',

  // VPN
  'POST /api/vpn/clients':                           '创建 VPN 客户端',
  'PUT /api/vpn/clients/:id':                        '修改 VPN 客户端',
  'DELETE /api/vpn/clients/:id':                     '删除 VPN 客户端',

  // 工单
  'POST /api/feishu/tickets':                        '提交工单',
  'POST /api/feishu/tickets/:id/approve':            '通过工单',
  'POST /api/feishu/tickets/:id/reject':             '拒绝工单',
  'POST /api/feishu/tickets/:id/save-config':        '保存工单配置',
  'DELETE /api/feishu/tickets/:id':                  '删除工单',
  'POST /api/feishu/tickets/sync-pending':           '同步待处理工单',
  'PUT /api/feishu/config':                          '修改飞书配置',
  'POST /api/feishu/config/init-approval':           '初始化飞书审批流',
  'POST /api/feishu/config/test':                    '测试飞书配置',

  // 用户组
  'POST /api/sync/groups/create':                    '创建云用户组',
  'DELETE /api/sync/groups/:platform/:groupName':    '删除云用户组',

  // 其他
  'PUT /api/apply-config':                           '修改申请项配置',
  'POST /api/feedback':                              '提交反馈',
  'PUT /api/feedback/:id/reply':                     '回复反馈',
  'POST /api/oauth/clients':                         '创建 OAuth 客户端',
  'DELETE /api/oauth/clients/:id':                   '删除 OAuth 客户端',
};

// 模块中文名，用于兜底标签和前端筛选下拉
const MODULE_LABELS = {
  accounts: '账号', roles: '角色', cloud: '云凭据', sync: '同步',
  instances: '云主机', pai: 'PAI', rds: '数据库', bytebase: 'Bytebase',
  clusters: '集群', storage: '存储', jumpserver: '堡垒机', vpn: 'VPN',
  feishu: '飞书', billing: '账单', feedback: '反馈', oauth: 'OAuth',
  'apply-config': '申请项配置', audit: '审计', sso: 'SSO',
};

const METHOD_VERB = { POST: '新增', PUT: '修改', PATCH: '修改', DELETE: '删除' };

// 同步类路径统一叫「同步」，比「新增 :platform」可读
function fallbackAction(method, routeKeyPath, module) {
  const modLabel = MODULE_LABELS[module] || module || '';
  // 取非参数段，并剔除 'api' 与模块自身段（否则会出现「修改申请项配置 apply-config」这种重复）
  const objSegs = String(routeKeyPath || '')
    .split('/')
    .filter(s => s && !s.startsWith(':') && s !== 'api' && s !== module);

  if (/(^|\/)sync/.test(routeKeyPath || '')) {
    const objs = objSegs.filter(s => !s.startsWith('sync'));
    const obj = objs.length ? objs[objs.length - 1] : '';
    // module 本身就是 sync 时 modLabel 已是「同步」，不再叠加
    return obj ? `同步 ${obj}` : `同步${modLabel === '同步' ? '' : modLabel}`;
  }

  const verb = METHOD_VERB[method] || method;
  const tail = objSegs.length ? objSegs[objSegs.length - 1] : '';
  return `${verb}${modLabel}${tail ? ' ' + tail : ''}`.trim();
}

// ── 主中间件 ─────────────────────────────────────────────────
function auditMiddleware(req, res, next) {
  if (!AUDIT_METHODS.has(req.method)) return next();

  const startedAt = Date.now();

  // 捕获响应体用于失败时提取 error 文案。只在失败时才留，成功的响应可能很大。
  let captured = null;
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400) captured = body;
    return origJson(body);
  };

  res.on('finish', () => {
    try {
      // 未匹配到任何路由（打错的路径）不是操作，不记
      if (!req.route) return;

      // auto-sync 内部身份：每 30 分钟 13 个 POST（约 624 条/天），
      // 加上每日证书检查，不过滤的话表里 95% 是机器噪音。直接丢弃。
      if (req.user && req.user.id === 'system') return;

      const routeKeyPath = `${req.baseUrl || ''}${req.route.path === '/' ? '' : req.route.path}`;
      const routeKey = `${req.method} ${routeKeyPath}`;
      const module = String(req.baseUrl || '').replace(/^\/api\//, '').replace(/^\//, '').split('/')[0] || null;

      const rec = {
        id: uuidv4(),
        user_id:   req.user?.id || null,
        user_name: req.user?.name || null,
        user_email: req.user?.email || null,
        user_role: req.user?.role || null,
        method: req.method,
        path: String(req.originalUrl || '').slice(0, 512),
        route: routeKeyPath.slice(0, 256) || null,
        module,
        action: (ACTION_LABELS[routeKey] || fallbackAction(req.method, routeKeyPath, module)).slice(0, 128),
        status_code: res.statusCode,
        success: res.statusCode < 400 ? 1 : 0,
        req_body: serializeBody(req.body),
        error_msg: captured ? String(captured.error || captured.message || '').slice(0, 512) || null : null,
        ip: (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 45) || null,
        user_agent: String(req.headers['user-agent'] || '').slice(0, 512) || null,
        duration_ms: Date.now() - startedAt,
      };

      // 登录接口没有 authenticate，req.user 恒为空：
      // 失败时把尝试的邮箱记进 user_email（密码已被脱敏），成功时按邮箱反查补齐身份。
      const isLogin = routeKey === 'POST /api/accounts/login';
      if (isLogin && !rec.user_id) {
        rec.user_email = (req.body?.email || '').slice(0, 255) || null;
      }

      // fire-and-forget：不 await，失败只告警，绝不影响真实请求
      persist(rec, isLogin).catch(err => console.warn('[audit] 写入失败:', err.message));
    } catch (err) {
      console.warn('[audit] 记录异常:', err.message);
    }
  });

  next();
}

async function persist(rec, isLogin) {
  // 登录成功但身份未知（无 authenticate）→ 按邮箱补齐，便于按人筛选
  if (isLogin && rec.success && !rec.user_id && rec.user_email) {
    try {
      const u = await db.get('SELECT id, name, role FROM users WHERE email = ?', [rec.user_email]);
      if (u) { rec.user_id = u.id; rec.user_name = u.name; rec.user_role = u.role; }
    } catch (_) { /* 补齐失败不影响主记录 */ }
  }

  await db.run(
    `INSERT INTO audit_logs
       (id, user_id, user_name, user_email, user_role, method, path, route, module, action,
        status_code, success, req_body, error_msg, ip, user_agent, duration_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [rec.id, rec.user_id, rec.user_name, rec.user_email, rec.user_role, rec.method, rec.path,
     rec.route, rec.module, rec.action, rec.status_code, rec.success, rec.req_body,
     rec.error_msg, rec.ip, rec.user_agent, rec.duration_ms]
  );
}

module.exports = { auditMiddleware, redact, isSecretKey, fallbackAction, MODULE_LABELS, ACTION_LABELS };
