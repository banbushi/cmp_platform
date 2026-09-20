'use strict';
const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const crypto     = require('crypto');
const jwt        = require('jsonwebtoken');
const db         = require('../utils/database');
const { authenticate, JWT_SECRET } = require('../middleware/auth');
const feishu     = require('../utils/feishu');
const { provisionCloudUser, getConsoleLoginUrl } = require('./accounts');
const { createVpnClient }    = require('./vpn');
const { grantBucketAccess, createBucket, friendlyBucketError }  = require('./storage');
const { createRdsAccount } = require('./rds');
const { buildFeishuDirectMessage, buildApprovalComment } = require('../utils/notification-builder');

const router = express.Router();

const { PLATFORM_NAMES } = require('../utils/constants');

/** 判断是否为生产环境 namespace（production/prod，大小写不敏感，匹配 prod / production / prod-xxx / xxx-prod 等） */
function isProdNamespace(ns) {
  const n = String(ns || '').trim().toLowerCase();
  return /(^|[-_])(prod|production)([-_]|$)/.test(n);
}

/** 把一条 other_requests 资源项转成飞书审批可读的一行明细 */
function describeOtherRequest(r, PLABEL) {
  const p = PLABEL[r.platform] || r.platform || '';
  const PERM = { push_pull: '读写(Push+Pull)', 'push-pull': '读写(Push+Pull)', pull: '只读(Pull)', readwrite: '读写', read: '只读', ReadWrite: '读写', ReadOnly: '只读', full: '完整权限', basic: '基础权限', view: '只读', edit: '读写', admin: '管理员' };
  const name = r.name || r.type || '资源';
  switch (r.type) {
    case 's3': case 'oss': case 'bos': {
      if (r.action === 'create') return `${p} ${name}（创建）：桶 ${r.bucket}${r.region ? ` @${r.region}` : ''}`;
      return `${p} ${name}（授权）：桶 ${r.bucket}${r.path ? `/${r.path}` : ''}${r.permission ? ` [${PERM[r.permission] || r.permission}]` : ''}${r.cloudUsername ? ` → ${r.cloudUsername}` : ''}`;
    }
    case 'ec2': case 'ecs': case 'bcc':
      return `${p} ${name}：${r.instance_name || ''} ×${r.count || 1}，规格 ${r.instance_type || '-'}，镜像 ${r.image_id || '-'}${r.region ? ` @${r.region}` : ''}${r.public_ip ? '，含公网IP' : ''}，系统盘 ${r.system_disk_size || '-'}G${r.data_disk_size ? `，数据盘 ${r.data_disk_size}G` : ''}`;
    case 'registry':
      return `${p} ${name}：${PERM[r.permission] || r.permission || ''}${r.description ? `（${r.description}）` : ''}`;
    case 'rds':
      return `${p} ${name}：实例 ${r.instanceName || r.instanceId || '-'}，库 ${(r.databases || []).join('/') || '-'}，账号 ${r.accountName || '-'} [${PERM[r.privilege] || r.privilege || ''}]`;
    case 'rds-instance':
      return `${p} 创建${r.engineKind === 'redis' ? 'Redis' : r.engineKind === 'postgres' ? 'PostgreSQL' : 'MySQL'}实例：${r.instanceName || '自动命名'}，规格 ${r.instanceClass || `${r.cpuCount || 1}C${r.memoryGb || 2}G`}${r.storageGb ? `，${r.storageGb}GB` : ''}${r.engineVersion ? `，v${r.engineVersion}` : ''}${r.region ? ` @${r.region}` : ''}`;
    case 'dns':
      return `${p} ${name}：${r.domain || '-'}`;
    case 'k8s':
      return `${p} ${name}：业务组 ${r.group_name || '-'} → 集群 ${r.cluster_name || r.cluster_id || '-'}，命名空间 ${(r.namespaces || []).join('/') || '-'} [${PERM[r.permission] || r.permission || ''}]`;
    case 'case':
      return `${p} ${name}：账号 ${r.cloudUsername || '-'} [${PERM[r.level] || r.level || ''}]`;
    default:
      return `${p} ${name}${r.description ? `（${r.description}）` : ''}`;
  }
}

// ── 飞书 OAuth 登录 ────────────────────────────────────────

/** GET /api/feishu/oauth/url — 返回飞书网页登录 OAuth 授权地址 */
router.get('/oauth/url', async (req, res) => {
  const cfg = await db.get('SELECT * FROM feishu_config WHERE id = 1');
  if (!cfg?.app_id) return res.status(400).json({ error: '飞书未配置，请先在「系统 → 飞书集成」完成配置' });
  const baseUrl = process.env.FEISHU_REDIRECT_URI
    || `${req.protocol}://${req.get('host')}/api/feishu/oauth/callback`;
  const url = `https://open.feishu.cn/open-apis/authen/v1/index?app_id=${cfg.app_id}&redirect_uri=${encodeURIComponent(baseUrl)}&state=login`;
  res.json({ url });
});

/** GET /api/feishu/oauth/callback?code=xxx — 处理飞书 OAuth 回调，颁发 JWT */
router.get('/oauth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=' + encodeURIComponent('缺少授权码'));

  const cfg = await db.get('SELECT * FROM feishu_config WHERE id = 1');
  if (!cfg?.app_id || !cfg?.app_secret) {
    return res.redirect('/?error=' + encodeURIComponent('飞书未配置'));
  }

  try {
    // 1. 获取 tenant_access_token
    const tokenRes = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: cfg.app_id, app_secret: cfg.app_secret }),
    });
    const tokenData = await tokenRes.json();
    if (tokenData.code !== 0) throw new Error(`Token 获取失败: ${tokenData.msg}`);

    // 2. 用 code 换取 user_access_token
    const userTokenRes = await fetch('https://open.feishu.cn/open-apis/authen/v1/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${tokenData.tenant_access_token}` },
      body: JSON.stringify({ grant_type: 'authorization_code', code }),
    });
    const userTokenData = await userTokenRes.json();
    if (userTokenData.code !== 0) throw new Error(`用户授权失败: ${userTokenData.msg}`);

    const userAccessToken = userTokenData.data.access_token;
    const openId          = userTokenData.data.open_id;

    // 3. 获取用户信息
    const userInfoRes = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { 'Authorization': `Bearer ${userAccessToken}` },
    });
    const userInfoData = await userInfoRes.json();
    if (userInfoData.code !== 0) throw new Error(`用户信息获取失败: ${userInfoData.msg}`);

    // 优先用企业邮箱（enterprise_email），个人邮箱（email）次之
    const { name, email: personalEmail, enterprise_email: enterpriseEmail } = userInfoData.data;
    let realEmail = enterpriseEmail || personalEmail || null;

    // 兜底：user_info 未返回企业邮箱时，调通讯录接口再取一次
    // 用户身份权限，必须用 user_access_token 调用（非 tenant_access_token）
    // 需要飞书应用开通两个权限：
    //   1. contact:contact.base:readonly —— 允许读取通讯录用户
    //   2. contact:user.email:readonly   —— 字段级权限，否则返回体不含 email/enterprise_email 字段
    if (!realEmail && openId) {
      try {
        const contactRes = await fetch(
          `https://open.feishu.cn/open-apis/contact/v3/users/${openId}?user_id_type=open_id`,
          { headers: { 'Authorization': `Bearer ${userAccessToken}` } }
        );
        const contactData = await contactRes.json();
        if (contactData.code === 0) {
          const cu = contactData.data?.user || {};
          realEmail = cu.enterprise_email || cu.email || null;
        } else {
          console.warn(`[feishu login] 通讯录取邮箱失败(code ${contactData.code}): ${contactData.msg}`);
        }
        if (!realEmail) console.warn(`[feishu login] 用户 ${openId} 未取到企业邮箱，回退占位邮箱`);
      } catch (e) {
        console.warn('[feishu login] 通讯录接口取企业邮箱失败:', e.message);
      }
    }

    const email = realEmail || `${openId}@feishu.local`;

    // 4. 查找或创建本地用户（按真实邮箱 / openId 占位邮箱 / feishu_open_id 三种方式查）
    let user = await db.get('SELECT * FROM users WHERE email = ?', [email])
            || await db.get('SELECT * FROM users WHERE email = ?', [`${openId}@feishu.local`])
            || (openId ? await db.get('SELECT * FROM users WHERE feishu_open_id = ?', [openId]) : null);
    if (!user) {
      const userId   = uuidv4();
      // 存储不可登录的占位密码（飞书用户只能通过飞书登录）
      const fakePw   = '$2a$10$' + crypto.randomBytes(30).toString('base64').slice(0, 53);
      await db.run(
        'INSERT INTO users (id, name, email, password, role, real_name, feishu_open_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, name, email, fakePw, 'applicant', name, openId]
      );
      user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    } else {
      // 已有用户：同步姓名、feishu_open_id，以及企业邮箱回填（原邮箱为占位时）
      const updates = [];
      const params  = [];
      if (!user.real_name && name) { updates.push('real_name = ?'); params.push(name); }
      if (openId) { updates.push('feishu_open_id = ?'); params.push(openId); }
      // 若拿到真实企业邮箱，且当前存的是 @feishu.local 占位邮箱，则回填真实邮箱
      if (realEmail && /@feishu\.local$/.test(user.email || '') && realEmail !== user.email) {
        updates.push('email = ?'); params.push(realEmail);
      }
      if (updates.length) {
        params.push(user.id);
        await db.run(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
        if (!user.real_name) user.real_name = name;
        user.feishu_open_id = openId;
        if (realEmail && /@feishu\.local$/.test(user.email || '')) user.email = realEmail;
      }
    }

    // 5. 禁用用户拒绝登录
    if (user.status === 'disabled') {
      return res.redirect('/?error=' + encodeURIComponent('该账号已被禁用，请联系管理员'));
    }

    // 6. 颁发 JWT
    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, role: user.role, feishu_open_id: user.feishu_open_id },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.redirect(`/?feishu_token=${encodeURIComponent(token)}`);
  } catch (e) {
    console.error('[feishu oauth callback]', e.message);
    res.redirect('/?error=' + encodeURIComponent(e.message));
  }
});

// ── 飞书配置相关 ──────────────────────────────────────────

/** GET /api/feishu/config — 读取配置（脱敏） */
router.get('/config', authenticate, async (req, res) => {
  const cfg = await db.get('SELECT * FROM feishu_config WHERE id = 1');
  if (!cfg) return res.json({ data: null });
  res.json({
    data: {
      app_id:            cfg.app_id,
      app_secret:        cfg.app_secret ? '****' : '',
      approval_code:     cfg.approval_code,
      approver_open_id:  cfg.approver_open_id,
      verification_token: cfg.verification_token ? '****' : '',
      encrypt_key:       cfg.encrypt_key ? '****' : '',
      enabled:           !!cfg.enabled,
      platform_url:      cfg.platform_url || '',
    },
    webhook_url: `${req.protocol}://${req.get('host')}/api/feishu/webhook`,
  });
});

/** PUT /api/feishu/config — 保存配置 */
router.put('/config', authenticate, async (req, res) => {
  const { app_id, app_secret, approval_code, approver_open_id, verification_token, encrypt_key, enabled, platform_url } = req.body;

  const cur = await db.get('SELECT * FROM feishu_config WHERE id = 1');
  const fields = {
    app_id:             app_id            ?? cur.app_id,
    app_secret:         (app_secret && app_secret !== '****')         ? app_secret         : cur.app_secret,
    approval_code:      approval_code     ?? cur.approval_code,
    approver_open_id:   approver_open_id  ?? cur.approver_open_id,
    verification_token: (verification_token && verification_token !== '****') ? verification_token : cur.verification_token,
    encrypt_key:        (encrypt_key && encrypt_key !== '****')        ? encrypt_key        : cur.encrypt_key,
    enabled:            enabled !== undefined ? (enabled ? 1 : 0) : cur.enabled,
    platform_url:       platform_url !== undefined ? (platform_url || '').trim() : (cur.platform_url || ''),
  };

  await db.run(
    `UPDATE feishu_config SET app_id=?, app_secret=?, approval_code=?, approver_open_id=?,
      verification_token=?, encrypt_key=?, enabled=?, platform_url=? WHERE id=1`,
    [fields.app_id, fields.app_secret, fields.approval_code, fields.approver_open_id,
     fields.verification_token, fields.encrypt_key, fields.enabled, fields.platform_url]
  );
  res.json({ ok: true });
});

/** POST /api/feishu/config/init-approval — 自动创建审批定义并保存 approval_code */
router.post('/config/init-approval', authenticate, async (req, res) => {
  const cfg = await db.get('SELECT * FROM feishu_config WHERE id = 1');
  if (!cfg?.app_id || !cfg?.app_secret) return res.status(400).json({ error: '请先填写 App ID 和 App Secret' });

  try {
    const approvalCode = await feishu.initApprovalDef(cfg);
    await db.run('UPDATE feishu_config SET approval_code=?, enabled=1 WHERE id=1', [approvalCode]);
    res.json({ ok: true, approval_code: approvalCode });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

/** POST /api/feishu/config/test — 测试连通性 */
router.post('/config/test', authenticate, async (req, res) => {
  const cfg = await db.get('SELECT * FROM feishu_config WHERE id = 1');
  if (!cfg?.app_id || !cfg?.app_secret) return res.status(400).json({ error: '请先填写 App ID 和 App Secret' });
  try {
    await feishu.getToken(cfg);
    res.json({ ok: true, message: '飞书连接正常' });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── 审批工单相关 ──────────────────────────────────────────

/** GET /api/feishu/tickets — 工单列表（非管理员只能看自己的） */
router.get('/tickets', authenticate, async (req, res) => {
  const { status, username, page = 1, pageSize = 20 } = req.query;
  const offset  = (page - 1) * pageSize;
  const isAdmin = req.user.role === 'admin';
  let where = '', params = [];

  if (!isAdmin) {
    where = 'WHERE submitter_id = ?';
    params.push(req.user.id);
  }
  if (status && status !== 'all') {
    // 支持逗号分隔的多状态（如 pending,approved 表示"待处理"= 待审批 + 待授权）
    const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
    if (statuses.length > 1) {
      const ph = statuses.map(() => '?').join(',');
      where = where ? `${where} AND status IN (${ph})` : `WHERE status IN (${ph})`;
      params.push(...statuses);
    } else {
      where = where ? `${where} AND status = ?` : 'WHERE status = ?';
      params.push(statuses[0]);
    }
  }
  if (isAdmin && username && username.trim()) {
    // account_draft 是 JSON 字符串，直接 LIKE 匹配 cloud_username 字段值
    const clause = 'account_draft LIKE ?';
    where = where ? `${where} AND ${clause}` : `WHERE ${clause}`;
    params.push(`%"cloud_username":"${username.trim().replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')}%`);
  }

  const total   = await db.get(`SELECT COUNT(*) AS n FROM approval_tickets ${where}`, params);
  const tickets = await db.all(
    `SELECT * FROM approval_tickets ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, Number(pageSize), Number(offset)]
  );
  res.json({ total: total.n, tickets });
});

/** GET /api/feishu/my-tickets — 当前用户自己的申请记录（不区分角色） */
router.get('/my-tickets', authenticate, async (req, res) => {
  const { status, page = 1, pageSize = 20 } = req.query;
  const offset = (page - 1) * pageSize;
  let where = 'WHERE submitter_id = ?';
  const params = [req.user.id];

  if (status && status !== 'all') {
    where += ' AND status = ?';
    params.push(status);
  }

  const total   = await db.get(`SELECT COUNT(*) AS n FROM approval_tickets ${where}`, params);
  const tickets = await db.all(
    `SELECT * FROM approval_tickets ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, Number(pageSize), Number(offset)]
  );
  res.json({ total: total.n, tickets });
});

/**
 * POST /api/feishu/tickets — 提交申请工单
 * body: { notes, cloud_platforms, vpn_requests }
 *
 * cloud_platforms: ['aws', 'aliyun', 'baidu']  — 申请的云平台列表（不含权限，由管理员审批时分配）
 * vpn_requests:   [{ platform, serverId, serverName, clientName, password }]
 */
router.post('/tickets', authenticate, async (req, res) => {
  const { ticket_type } = req.body;

  // ── 工单提交平台权限校验（密码重置跳过） ────────────────────────────────
  const userRole = await db.get('SELECT ticket_platforms FROM system_roles WHERE name = ?', [req.user.role]);
  const allowedPlatforms = JSON.parse(userRole?.ticket_platforms || 'null');
  const hasAllAccess = !allowedPlatforms || allowedPlatforms.includes('all');

  if (!hasAllAccess && ticket_type !== 'password_reset') {
    // 收集本次工单涉及的所有云平台
    let requestedPlatforms = [];
    if (ticket_type === 'password_reset') {
      const target = req.body.reset_target || {};
      if (target.platform) requestedPlatforms.push(target.platform);
    } else {
      const { cloud_platforms, vpn_requests, other_requests } = req.body;
      if (Array.isArray(cloud_platforms)) requestedPlatforms.push(...cloud_platforms);
      if (Array.isArray(vpn_requests)) requestedPlatforms.push(...vpn_requests.map(v => v.platform));
      if (Array.isArray(other_requests)) requestedPlatforms.push(...other_requests.map(r => r.platform).filter(Boolean));
    }
    requestedPlatforms = [...new Set(requestedPlatforms)];
    const denied = requestedPlatforms.filter(p => !allowedPlatforms.includes(p));
    if (denied.length > 0) {
      const NAMES = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
      const deniedNames = denied.map(p => NAMES[p] || p).join('、');
      return res.status(403).json({ error: `无权为以下平台提交工单：${deniedNames}` });
    }
  }

  // ── K8s 集群权限：生产 namespace 只允许只读(view)，提交时即拦截 ──────
  if (ticket_type !== 'password_reset' && Array.isArray(req.body.other_requests)) {
    for (const r of req.body.other_requests) {
      if (r.type !== 'k8s' || r.permission === 'view') continue;
      const prodNs = (r.namespaces || []).filter(isProdNamespace);
      if (prodNs.length) {
        return res.status(400).json({
          error: `生产环境 namespace（${prodNs.join('、')}）只允许申请「只读(view)」，不允许读写或管理员权限`,
        });
      }
    }
  }

  // ── 密码重置工单：校验只能重置自己的账号，直接自动通过 ──────
  if (ticket_type === 'password_reset') {
    console.log('[tickets] 密码重置工单 - 进入自动审批流程');
    const resetTarget = req.body.reset_target || {};
    const userInfo = await db.get('SELECT cloud_username FROM users WHERE id = ?', [req.user.id]);
    const myCloudUsername = userInfo?.cloud_username || '';

    if (resetTarget.type === 'cloud') {
      const owns = await db.get(
        'SELECT id FROM cloud_users WHERE user_id = ? AND platform = ? AND cloud_username = ?',
        [req.user.id, resetTarget.platform, resetTarget.account]
      );
      if (!owns && resetTarget.account !== myCloudUsername) {
        return res.status(403).json({ error: '只能重置自己的云账号密码' });
      }
    } else if (resetTarget.type === 'vpn') {
      const owns = await db.get(
        'SELECT id FROM vpn_clients WHERE client_name = ? AND platform = ?',
        [resetTarget.client, resetTarget.platform]
      );
      if (!owns) {
        return res.status(403).json({ error: 'VPN 客户端不存在' });
      }
    }

    const ticketId = uuidv4();
    const draftData = JSON.stringify(req.body);
    await db.run(
      `INSERT INTO approval_tickets (id, submitter_id, submitter_name, account_draft, status)
       VALUES (?, ?, ?, ?, 'processing')`,
      [ticketId, req.user.id, req.user.name, draftData]
    );

    console.log(`[tickets] 密码重置工单 ${ticketId} 已创建，状态: processing，开始执行...`);
    const cfg = await db.get('SELECT * FROM feishu_config WHERE id = 1');
    const ticket = await db.get('SELECT * FROM approval_tickets WHERE id = ?', [ticketId]);
    executeProvisioning(ticket, cfg).catch(e => console.error('[password_reset] auto-exec error:', e));

    return res.status(201).json({ ok: true, ticket_id: ticketId, auto_approved: true });
  }

  // ── 创建工单并发起飞书审批 ──────────────────────────────────
  const ticketId = uuidv4();
  const draftData = JSON.stringify(req.body);

  await db.run(
    `INSERT INTO approval_tickets (id, submitter_id, submitter_name, account_draft, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [ticketId, req.user.id, req.user.name, draftData]
  );

  // 尝试创建飞书审批实例
  let feishuSent = false;
  let feishuError = '';
  try {
    const cfg = await db.get('SELECT * FROM feishu_config WHERE id = 1');
    if (cfg?.enabled && cfg?.approval_code) {
      const { cloud_platforms = [], vpn_requests = [], other_requests = [], cloud_username, initial_password, iam_notes } = req.body;
      const PLABEL = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云', jumpserver: 'JumpServer', bytebase: 'Bytebase', kuboard: 'Kuboard' };
      const resourceParts = [];

      // 云账号(IAM)明细。iam_notes 为按平台分的对象 { aws: '备注', aliyun: '备注' }，
      // 需按平台取出拼成可读文本，直接拼对象会得到 [object Object]
      if (cloud_platforms.length) {
        const iamDetail = cloud_platforms.map(p => PLABEL[p] || p).join('、');
        let notesText = '';
        if (iam_notes && typeof iam_notes === 'object') {
          notesText = cloud_platforms
            .filter(p => iam_notes[p])
            .map(p => `${PLABEL[p] || p}：${iam_notes[p]}`)
            .join('；');
        } else if (typeof iam_notes === 'string') {
          notesText = iam_notes;
        }
        resourceParts.push(`云账号（IAM）：${iamDetail}${cloud_username ? `，用户名 ${cloud_username}` : ''}${notesText ? `\n  说明：${notesText}` : ''}`);
      }

      // VPN 明细
      if (vpn_requests.length) {
        vpn_requests.forEach(v => {
          resourceParts.push(`VPN：${PLABEL[v.platform] || v.platform}${v.client ? ` · 客户端 ${v.client}` : ''}`);
        });
      }

      // 其他资源(VM/存储/RDS/K8s/DNS 等)——describeOtherRequest 已有详细格式
      other_requests.forEach(r => resourceParts.push(describeOtherRequest(r, PLABEL)));

      const resourceDesc = resourceParts.length ? resourceParts.map(p => `• ${p}`).join('\n') : '资源申请';

      const submitter = await db.get('SELECT feishu_open_id FROM users WHERE id = ?', [req.user.id]);
      const ticketData = {
        applicant: req.user.name,
        email: req.user.email,
        purpose: req.body.notes || '',
        resources: resourceDesc,
        notes: req.body.notes || '',
        applicant_open_id: submitter?.feishu_open_id || null,
      };

      const result = await feishu.createInstance(cfg, ticketData);
      await db.run(
        'UPDATE approval_tickets SET feishu_instance_code = ?, feishu_initiator_open_id = ? WHERE id = ?',
        [result.instance_code, result.initiator_open_id, ticketId]
      );
      feishuSent = true;
    }
  } catch (e) {
    feishuError = e.message;
    console.warn('[tickets] 创建飞书审批失败（工单已保存）:', e.message);
  }

  res.status(201).json({ ok: true, ticket_id: ticketId, feishu_sent: feishuSent, feishu_error: feishuError || undefined });
});

/**
 * POST /api/feishu/tickets/:id/approve
 * 管理员审批工单（或对已审批工单进行授权）
 * - 如果工单状态是 pending，则直接审批通过并授权
 * - 如果工单状态是 approved，则执行资源开通授权
 */
router.post('/tickets/:id/approve', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '只有管理员可以批准工单' });

  const ticket = await db.get(
    "SELECT * FROM approval_tickets WHERE id = ? AND status IN ('pending', 'approved', 'failed')", [req.params.id]
  );
  if (!ticket) return res.status(404).json({ error: '工单不存在或已处理' });

  const { cloud_accounts, vpn_configs, storage_grants, bucket_creates, rds_accounts, vm_configs } = req.body;

  // 顺便保存审批配置草稿（与最新提交一致，便于失败重试时回填）
  try {
    await db.run("UPDATE approval_tickets SET approve_config=? WHERE id=?",
      [JSON.stringify({ cloud_accounts, vpn_configs, storage_grants, bucket_creates, rds_accounts, vm_configs }), ticket.id]);
  } catch (e) { console.warn('[approve] 保存 approve_config 失败:', e.message); }

  // 如果是 pending 状态，先标记为 approved
  if (ticket.status === 'pending') {
    await db.run("UPDATE approval_tickets SET status='approved', resolved_at=NOW() WHERE id=?", [ticket.id]);
  }

  // 更新为 processing 并执行开通
  await db.run("UPDATE approval_tickets SET status='processing' WHERE id=?", [ticket.id]);

  const cfg = await db.get('SELECT * FROM feishu_config WHERE id = 1');

  executeProvisioning(ticket, cfg, {
    cloud_accounts:  cloud_accounts  || [],
    vpn_requests:    vpn_configs     || [],
    storage_grants:  storage_grants  || [],
    bucket_creates:  bucket_creates  || [],
    rds_accounts:    rds_accounts    || [],
    vm_configs:      vm_configs      || [],
  }).catch(e => console.error('[approve] executeProvisioning error:', e));

  res.json({ ok: true });
});

/**
 * POST /api/feishu/tickets/:id/save-config
 * 保存审批配置草稿（VPC/子网/安全组/JumpServer节点等），不触发开通、不改状态。
 * 供审批弹窗自动保存，重开时回填，避免飞书同意或中途关闭丢失。
 */
router.post('/tickets/:id/save-config', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '只有管理员可以保存审批配置' });
  const ticket = await db.get('SELECT id FROM approval_tickets WHERE id = ?', [req.params.id]);
  if (!ticket) return res.status(404).json({ error: '工单不存在' });
  const { cloud_accounts, vpn_configs, storage_grants, bucket_creates, rds_accounts, vm_configs } = req.body || {};
  try {
    await db.run("UPDATE approval_tickets SET approve_config=? WHERE id=?",
      [JSON.stringify({ cloud_accounts, vpn_configs, storage_grants, bucket_creates, rds_accounts, vm_configs }), ticket.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '保存配置失败: ' + e.message });
  }
});

/** GET /api/feishu/tickets/:id — 单工单详情（含最新 approve_config，供审批弹窗回填） */
router.get('/tickets/:id', authenticate, async (req, res) => {
  const ticket = await db.get('SELECT * FROM approval_tickets WHERE id = ?', [req.params.id]);
  if (!ticket) return res.status(404).json({ error: '工单不存在' });
  if (req.user.role !== 'admin' && ticket.submitter_id !== req.user.id)
    return res.status(403).json({ error: '无权查看他人工单' });
  res.json({ ticket });
});

/** DELETE /api/feishu/tickets/:id — 撤销工单（本人或管理员） */
router.delete('/tickets/:id', authenticate, async (req, res) => {
  const ticket = await db.get("SELECT * FROM approval_tickets WHERE id = ? AND status = 'pending'", [req.params.id]);
  if (!ticket) return res.status(404).json({ error: '工单不存在或已处理' });
  if (req.user.role !== 'admin' && ticket.submitter_id !== req.user.id)
    return res.status(403).json({ error: '无权撤销他人工单' });

  await db.run("UPDATE approval_tickets SET status='cancelled', resolved_at=NOW() WHERE id=?", [req.params.id]);

  // 尝试撤销飞书审批实例
  const cfg = await db.get('SELECT * FROM feishu_config WHERE id = 1');
  let feishuCancelOk = false;
  let feishuCancelErr = '';
  try {
    if (ticket.feishu_instance_code && cfg?.approval_code) {
      let operatorId = ticket.feishu_initiator_open_id;

      if (!operatorId) {
        const submitter = await db.get('SELECT feishu_open_id FROM users WHERE id = ?', [ticket.submitter_id]);
        const submitterOpenId = submitter?.feishu_open_id;
        const approverOpenId = cfg.approver_open_id;

        if (submitterOpenId) {
          try {
            await feishu.cancelInstance(cfg, ticket.feishu_instance_code, submitterOpenId);
            feishuCancelOk = true;
          } catch (e1) {
            if (e1.message.includes('60009') && approverOpenId && approverOpenId !== submitterOpenId) {
              await feishu.cancelInstance(cfg, ticket.feishu_instance_code, approverOpenId);
              feishuCancelOk = true;
            } else {
              throw e1;
            }
          }
        } else if (approverOpenId) {
          await feishu.cancelInstance(cfg, ticket.feishu_instance_code, approverOpenId);
          feishuCancelOk = true;
        }
      } else {
        await feishu.cancelInstance(cfg, ticket.feishu_instance_code, operatorId);
        feishuCancelOk = true;
      }
    } else {
      feishuCancelErr = !ticket.feishu_instance_code ? '该工单无飞书审批实例' : '飞书审批未配置';
    }
  } catch (e) {
    feishuCancelErr = e.message;
    console.warn('[feishu] 取消飞书实例失败:', e.message);
  }

  res.json({ ok: true, feishu_cancelled: feishuCancelOk, feishu_error: feishuCancelErr || null });
});

/** POST /api/feishu/tickets/:id/reject — 管理员拒绝工单（附理由） */
router.post('/tickets/:id/reject', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const ticket = await db.get(
    "SELECT * FROM approval_tickets WHERE id = ? AND status IN ('pending','approved','processing')",
    [req.params.id]
  );
  if (!ticket) return res.status(404).json({ error: '工单不存在或已处理' });
  const reason = (req.body.reason || '').trim();
  await db.run(
    "UPDATE approval_tickets SET status='rejected', reject_reason=?, resolved_at=NOW() WHERE id=?",
    [reason || null, ticket.id]
  );
  res.json({ ok: true });
});

// ── 主动同步飞书审批状态 ─────────────────────────────────

/** POST /api/feishu/tickets/sync-pending — 批量同步所有待审批工单的飞书状态 */
router.post('/tickets/sync-pending', authenticate, async (req, res) => {
  const cfg = await db.get('SELECT * FROM feishu_config WHERE id = 1');
  if (!cfg?.enabled) return res.json({ synced: 0, message: '飞书集成未启用' });

  const pendingTickets = await db.all(
    "SELECT * FROM approval_tickets WHERE status = 'pending' AND feishu_instance_code IS NOT NULL AND feishu_instance_code != ''"
  );
  if (!pendingTickets.length) return res.json({ synced: 0 });

  let synced = 0;
  for (const ticket of pendingTickets) {
    try {
      const detail = await feishu.getInstanceDetail(cfg, ticket.feishu_instance_code);
      const feishuStatus = detail?.status || detail?.instance?.status;

      if (feishuStatus === 'APPROVED') {
        await db.run("UPDATE approval_tickets SET status='approved', resolved_at=NOW() WHERE id=? AND status='pending'", [ticket.id]);
        synced++;
      } else if (feishuStatus === 'REJECTED' || feishuStatus === 'CANCELED' || feishuStatus === 'DELETED') {
        const statusMap = { REJECTED: 'rejected', CANCELED: 'cancelled', DELETED: 'cancelled' };
        // 拒绝时从已取到的 detail.timeline 提取拒绝意见
        const rejectReason = feishuStatus === 'REJECTED'
          ? ((detail?.timeline || []).find(t => t.type === 'REJECT' && t.comment)?.comment || null)
          : null;
        await db.run(
          "UPDATE approval_tickets SET status=?, reject_reason=?, resolved_at=NOW() WHERE id=? AND status='pending'",
          [statusMap[feishuStatus], rejectReason, ticket.id]
        );
        synced++;
      }
    } catch (e) {
      console.warn(`[sync] 同步工单 ${ticket.id} 飞书状态失败:`, e.message);
    }
  }
  res.json({ synced, total: pendingTickets.length });
});

// ── Webhook ──────────────────────────────────────────────

/** POST /api/feishu/webhook — 飞书事件回调（无需 JWT） */
router.post('/webhook', async (req, res) => {
  const cfg = await db.get('SELECT * FROM feishu_config WHERE id = 1');

  let body = req.body;
  try {
    body = feishu.parseWebhookBody(req.body, cfg || {});
  } catch (e) {
    console.error('[feishu webhook] 解密失败:', e.message);
    return res.json({ code: 0 });
  }

  const challenge = feishu.isChallenge(body);
  if (challenge) return res.json(challenge);

  try { feishu.verifyToken(body, cfg?.verification_token); }
  catch (e) {
    console.error('[feishu webhook] token 验证失败:', e.message);
    return res.status(403).json({ code: 1 });
  }

  // 立即响应，异步处理防止超时
  res.json({ code: 0 });
  processApprovalEvent(body, cfg).catch(e => console.error('[feishu webhook] 处理失败:', e));
});

// ── 内部逻辑 ─────────────────────────────────────────────

/** 异步处理审批事件 */
async function processApprovalEvent(body, cfg) {
  const event = body?.event;
  if (!event?.instance_code) return;

  const { instance_code, status } = event;

  const ticket = await db.get(
    "SELECT * FROM approval_tickets WHERE feishu_instance_code = ? AND status = 'pending'",
    [instance_code]
  );
  if (!ticket) return;

  // 统一处理审批事件
  if (status === 'APPROVED') {
    // 更新状态为 approved（已审批），等待管理员手动授权
    await db.run("UPDATE approval_tickets SET status='approved', resolved_at=NOW() WHERE id=? AND status='pending'", [ticket.id]);
    console.log(`[feishu webhook] 工单 ${ticket.id} 已审批通过，等待授权`);
  } else if (status === 'REJECTED' || status === 'CANCELED') {
    // webhook 事件本身不带 timeline，拒绝意见需调实例详情从 timeline 的 REJECT 节点取 comment
    const rejectReason = await fetchFeishuRejectReason(cfg, instance_code);
    await db.run(
      "UPDATE approval_tickets SET status='rejected', reject_reason=?, resolved_at=NOW() WHERE id=?",
      [rejectReason || null, ticket.id]
    );
  }
}

/** 从飞书审批实例详情提取拒绝意见（timeline 中 type=REJECT 节点的 comment） */
async function fetchFeishuRejectReason(cfg, instanceCode) {
  try {
    const detail = await feishu.getInstanceDetail(cfg, instanceCode);
    const rej = (detail?.timeline || []).find(t => t.type === 'REJECT' && t.comment);
    return rej?.comment || '';
  } catch (e) {
    console.warn('[feishu] 获取拒绝意见失败:', e.message);
    return '';
  }
}

/** 审批通过后执行资源开通 */
async function executeProvisioning(ticket, cfg, accountsOverride = null, options = {}) {
  let draft;
  try { draft = JSON.parse(ticket.account_draft); } catch { return; }

  // ── 密码重置工单 ────────────────────────────────────────
  if (draft.ticket_type === 'password_reset') {
    const { reset_target, new_password, reason } = draft;
    let success = false;
    let message = '';
    let resetResult = {};

    try {
      if (reset_target.type === 'cloud') {
        // 云账号密码重置
        const { platform, account } = reset_target;
        const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
        if (!cred) {
          message = `${PLATFORM_NAMES[platform] || platform} 未配置主账号凭据`;
        } else {
          // 调用云平台 API 重置密码
          const resetR = await resetCloudUserPassword(platform, cred, account, new_password);
          success = resetR.success;
          message = resetR.message;
          resetResult = { type: 'cloud', platform, account, success, message };
        }
      } else if (reset_target.type === 'vpn') {
        // VPN 账号密码重置
        const { platform, client } = reset_target;
        const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
        if (!cred) {
          message = `${PLATFORM_NAMES[platform] || platform} 未配置主账号凭据`;
        } else {
          // 调用 VPN API 重置密码
          const resetR = await resetVpnPassword(platform, cred, client, new_password);
          success = resetR.success;
          message = resetR.message;
          resetResult = { type: 'vpn', platform, client, success, message };
        }
      } else if (reset_target.type === 'system') {
        // 平台工具密码重置
        const { tool } = reset_target;
        const resetR = await resetSystemToolPassword(tool, draft.cloud_username, new_password);
        success = resetR.success;
        message = resetR.message;
        resetResult = { type: 'system', tool, success, message };
      }
    } catch (e) {
      success = false;
      message = e.message;
      resetResult.success = false;
      resetResult.message = e.message;
    }

    // 更新工单状态
    const resetStatus = success ? 'completed' : 'failed';
    await db.run(
      "UPDATE approval_tickets SET status=?, cloud_result=?, resolved_at=NOW() WHERE id=?",
      [resetStatus, JSON.stringify(resetResult), ticket.id]
    );

    // 飞书通知
    if (ticket.feishu_instance_code && cfg) {
      try {
        const comment = success
          ? `【密码重置成功】\n密码已重置，请使用新密码登录。`
          : `【密码重置失败】\n${message}`;
        await feishu.addComment(cfg, ticket.feishu_instance_code, comment);
      } catch (e) {
        console.warn('[feishu] 追加备注失败:', e.message);
      }
    }

    // 向申请人发飞书私信
    if (cfg?.enabled && success) {
      try {
        const submitter = await db.get('SELECT feishu_open_id, real_name FROM users WHERE id = ?', [ticket.submitter_id]);
        const openId = submitter?.feishu_open_id;
        if (openId) {
          const targetDesc = reset_target.type === 'cloud'
            ? `${PLATFORM_NAMES[reset_target.platform] || reset_target.platform} 云账号：${reset_target.account}`
            : reset_target.type === 'vpn'
              ? `${PLATFORM_NAMES[reset_target.platform] || reset_target.platform} VPN 客户端`
              : `平台工具：${PLATFORM_NAMES[reset_target.tool] || reset_target.tool}`;
          const dmText = `【密码重置通知】\n\n你好 ${submitter.real_name || ''}，你申请的密码重置已完成：\n\n目标：${targetDesc}\n新密码：${new_password}\n\n请妥善保管新密码，建议登录后立即修改。`;
          await feishu.sendMessage(cfg, openId, dmText);
        }
      } catch (e) {
        console.warn('[feishu] 发送私信失败:', e.message);
      }
    }
    return;
  }

  // ── 原有账号申请工单 ─────────────────────────────────────
  const notes          = draft.notes;
  const cloud_accounts = accountsOverride ? accountsOverride.cloud_accounts : (draft.cloud_accounts || []);
  const vpn_requests   = accountsOverride ? accountsOverride.vpn_requests   : (draft.vpn_requests   || []);
  const userId         = ticket.submitter_id;

  // 兜底：无论如何都要把工单从 processing 状态推出去
  const markApproved = async (cloudResults, vpnResults, storageResults, bucketResults, rdsResults, vmResults, registryResults) => {
    const allResults = [...cloudResults, ...vpnResults, ...storageResults, ...bucketResults, ...rdsResults, ...vmResults, ...registryResults];
    const hasSuccess = allResults.some(r => r.status === 'active' || r.success);
    const finalStatus = (allResults.length > 0 && !hasSuccess) ? 'failed' : 'completed';

    await db.run(
      `UPDATE approval_tickets SET status=?, cloud_result=?, vpn_result=?, storage_result=?, bucket_result=?, rds_result=?, vm_result=?, registry_result=?, resolved_at=NOW() WHERE id=?`,
      [
        finalStatus,
        JSON.stringify({ user_id: userId, cloud_results: cloudResults }),
        JSON.stringify(vpnResults),
        JSON.stringify(storageResults),
        JSON.stringify(bucketResults),
        JSON.stringify(rdsResults),
        JSON.stringify(vmResults),
        JSON.stringify(registryResults),
        ticket.id,
      ]
    );
  };

  try {

  const submitter      = await db.get('SELECT email FROM users WHERE id = ?', [userId]);
  const userEmail      = submitter ? submitter.email : `user-${(userId || '').slice(0,8)}@example.com`;

  // ── 1. 为已存在的本地用户开通云平台账号 ──────────────────
  const cloudResults = [];
  // 优先用申请人自填密码，否则随机生成
  const initialPassword = draft.initial_password || generatePassword();

  if (Array.isArray(cloud_accounts) && cloud_accounts.length > 0) {
    // 优先使用用户自填的账号名，否则从提交者名称生成
    const autoPassword = initialPassword;
    const rawName = draft.cloud_username || ticket.submitter_name || 'user';
    const cloudUsername = /^[a-zA-Z0-9_+=,.@-]+$/.test(rawName)
      ? rawName.toLowerCase()
      : (rawName.replace(/[^\w+=,.@-]/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
          || `user-${ticket.submitter_id.slice(0, 8)}`);

    for (const ca of cloud_accounts) {
      const { platform, policies, groups, enable_console, bytebaseInstanceId } = ca;
      let masterCred = await db.get(
        'SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]
      );
      let resolvedBbInstanceId = null; // bytebase 账号实际开通到的实例 id，写入 cloud_users 供删除时定位
      // Bytebase 多实例：凭据来自 bytebase_instances 表（按申请时选的实例），
      // 整形成 createBytebaseMember 期望的 cred 结构：access_key=地址, secret_key=token, 附带 CF 字段
      if (platform === 'bytebase') {
        const inst = bytebaseInstanceId
          ? await db.get('SELECT * FROM bytebase_instances WHERE id = ? AND enabled = 1', [bytebaseInstanceId])
          : await db.get('SELECT * FROM bytebase_instances WHERE enabled = 1 ORDER BY name LIMIT 1');
        resolvedBbInstanceId = inst ? inst.id : null;
        masterCred = inst ? {
          access_key: inst.base_url,
          secret_key: inst.token,
          service_account_email: inst.service_account_email, // v3 登录换令牌必需，缺了会静默失败
          cf_client_id: inst.cf_client_id,
          cf_client_secret: inst.cf_client_secret,
          display_name: inst.name,
          category: 'tool',
        } : null;
      }
      const cloudUserId = uuidv4();
      let accessKey = '', secretKey = '', cStatus = 'pending', message = '', loginUsername = cloudUsername;

      if (masterCred || platform === 'kuboard' || platform === 'grafana-aws' || platform === 'grafana-wuwen' || platform === 'grafana-baidu') {
        const r = await provisionCloudUser(platform, masterCred, cloudUsername, policies || [], groups || [], notes || '', autoPassword, !!enable_console, userEmail);
        accessKey = r.accessKey || '';
        secretKey = r.secretKey || '';
        cStatus   = r.success ? 'active' : 'failed';
        message   = r.message;
        loginUsername = r.loginUsername || cloudUsername;
      } else {
        cStatus = 'no_credential';
        message = `${PLATFORM_NAMES[platform] || platform} 未配置主账号凭据`;
      }

      const consoleUrl = (cStatus === 'active' && masterCred) ? (await getConsoleLoginUrl(platform, masterCred)) : '';

      await db.run(
        'INSERT INTO cloud_users (id, user_id, platform, bytebase_instance_id, cloud_username, cloud_access_key, cloud_secret_key, policies, `groups`, status, console_password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [cloudUserId, userId, platform, resolvedBbInstanceId, cloudUsername, accessKey, secretKey, JSON.stringify(policies || []), JSON.stringify(groups || []), cStatus, enable_console ? autoPassword : null]
      );
      cloudResults.push({ platform, cloud_username: cloudUsername, login_username: loginUsername, status: cStatus, message, accessKey, secretKey, consoleUrl, display_name: masterCred?.display_name || '', category: masterCred?.category || '' });
    }
  }

  // ── 2. 创建 VPN 账号 ─────────────────────────────────
  const vpnResults = [];

  if (Array.isArray(vpn_requests) && vpn_requests.length > 0) {
    for (const vr of vpn_requests) {
      const { platform, serverId, serverName, clientName, region: vpnRegion } = vr;
      const finalVpnPwd = initialPassword;
      const cred = await db.get(
        'SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]
      );

      if (!cred) {
        vpnResults.push({ platform, clientName, success: false, clientId: '', message: '未配置主账号凭据' });
        continue;
      }

      const r = await createVpnClient(platform, cred, serverId, clientName, finalVpnPwd, notes, vpnRegion);

      if (r.success) {
        const id = uuidv4();
        await db.run(
          'INSERT INTO vpn_clients (id, platform, server_id, server_name, client_id, client_name, region, notes) VALUES (?,?,?,?,?,?,?,?)',
          [id, platform, serverId, serverName || '', r.clientId, clientName, vpnRegion || cred.region || '', notes || null]
        );
      }

      vpnResults.push({ platform, clientName, success: r.success, clientId: r.clientId, message: r.message });
    }
  }

  // ── 2.5. 自动创建存储桶 ──────────────────────────────────
  const bucketResults = [];
  const bucketCreates = accountsOverride?.bucket_creates || [];

  if (Array.isArray(bucketCreates) && bucketCreates.length > 0) {
    for (const bc of bucketCreates) {
      const { platform, bucket, region } = bc;
      const cred = await db.get(
        'SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]
      );
      if (!cred) {
        bucketResults.push({ platform, bucket, region, success: false, message: '未配置主账号凭据' });
        continue;
      }
      try {
        await createBucket(platform, cred, bucket, region);
        // 写入 cloud_buckets 缓存表
        const existing = await db.get('SELECT id FROM cloud_buckets WHERE platform = ? AND name = ?', [platform, bucket]);
        if (!existing) {
          await db.run('INSERT INTO cloud_buckets (id, platform, name, region, location, created_at_cloud) VALUES (?,?,?,?,?,?)',
            [uuidv4(), platform, bucket, region || '', region || '', new Date().toISOString()]);
        }
        bucketResults.push({ platform, bucket, region, success: true, message: '创建成功' });
      } catch (e) {
        // 如果 bucket 已存在（OwnedByYou），视为成功
        const msg = e.message || '';
        const code = e.Code || e.code || e.name || '';
        if (code === 'BucketAlreadyOwnedByYou' || msg.includes('OwnedByYou')) {
          bucketResults.push({ platform, bucket, region, success: true, message: 'Bucket 已存在，无需创建' });
        } else {
          bucketResults.push({ platform, bucket, region, success: false, message: friendlyBucketError(e, platform) });
        }
      }
    }
  }

  // ── 2.6. 存储桶授权（需在 IAM 用户创建之后执行） ──────────
  const storageResults = [];
  const storageGrants = accountsOverride?.storage_grants || [];

  if (Array.isArray(storageGrants) && storageGrants.length > 0) {
    const rawName = draft.cloud_username || ticket.submitter_name || 'user';
    const cloudUsername = /^[a-zA-Z0-9_+=,.@-]+$/.test(rawName)
      ? rawName.toLowerCase()
      : (rawName.replace(/[^\w+=,.@-]/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
          || `user-${ticket.submitter_id.slice(0, 8)}`);

    for (const sg of storageGrants) {
      const { platform, bucket, region, path, permission, policyName } = sg;
      // 优先使用申请人直接填写的云账号名
      const sgCloudUsername = sg.cloudUsername || sg.userId || null;
      const cred = await db.get(
        'SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]
      );
      if (!cred) {
        storageResults.push({ platform, bucket, region, success: false, message: '未配置主账号凭据' });
        continue;
      }

      // 确定附加到哪个云账号：直接用申请人填的云账号名，否则回退到工单提交者
      let attachUsername = sgCloudUsername || null;
      if (!attachUsername) {
        const iamCreated = cloudResults.some(cr => cr.platform === platform && cr.status === 'active');
        if (iamCreated) attachUsername = cloudUsername;
      }
      const productMap = { aws: 's3', aliyun: 'oss', baidu: 'bos' };
      const product = productMap[platform] || platform;
      const sep = platform === 'baidu' ? '_' : '-';
      const safeBucket = bucket.replace(/[^a-zA-Z0-9]/g, sep).slice(0, 30);
      const safePath = (path || '*').replace(/[^a-zA-Z0-9]/g, sep).replace(new RegExp(`^${sep}+|${sep}+$`, 'g'), '') || 'all';
      const permSuffix = permission === 'readwrite' ? 'rw' : 'ro';
      const finalPolicyName = (policyName || '').trim() || `cmp${sep}${product}${sep}${safeBucket}${sep}${safePath}${sep}${permSuffix}`;

      try {
        const r = await grantBucketAccess(platform, cred, {
          bucket,
          path: path || '*',
          permission,
          policyName: finalPolicyName,
          cloudUsername: attachUsername,
        });
        storageResults.push({
          platform, bucket, region, permission,
          success: r.ok,
          policyName: r.policyName,
          attached: r.attached,
          attachUsername: attachUsername,
          message: r.error || (r.ok
            ? (r.attached ? '授权成功' : `策略已创建，但未指定云账号名或云账号不存在`)
            : '授权失败'),
        });

        // 将授权记录写入 cloud_buckets（如果指定了 cloudUsername）
        if (r.ok && sgCloudUsername) {
          const existing = await db.get(
            'SELECT id FROM cloud_buckets WHERE platform = ? AND name = ?',
            [platform, bucket]
          );
          if (existing) {
            await db.run(
              'UPDATE cloud_buckets SET synced_at = NOW() WHERE id = ?',
              [existing.id]
            );
          } else {
            const bucketId = require('uuid').v4();
            await db.run(
              `INSERT INTO cloud_buckets (id, platform, name, region) VALUES (?, ?, ?, ?)`,
              [bucketId, platform, bucket, region || '']
            );
          }
        }
      } catch (e) {
        storageResults.push({ platform, bucket, region, permission, success: false, policyName: finalPolicyName, attached: false, message: e.message });
      }
    }
  }

  // ── 2.7. RDS 数据库账号创建 ──────────────────────────────
  const rdsResults = [];
  const rdsAccounts = accountsOverride?.rds_accounts || [];

  if (Array.isArray(rdsAccounts) && rdsAccounts.length > 0) {
    for (const ra of rdsAccounts) {
      const { platform, instanceId, instanceName, accountName, password, privilege, databases } = ra;
      const cred = await db.get(
        'SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]
      );
      if (!cred) {
        rdsResults.push({ platform, instanceId, accountName, success: false, message: '未配置主账号凭据' });
        continue;
      }
      try {
        const r = await createRdsAccount(platform, cred, instanceId, accountName, password, privilege, databases || []);
        rdsResults.push({ platform, instanceId, instanceName, accountName, privilege, databases, ...r });
        if (r.success && !r.needsManual) {
          await db.run(
            `INSERT INTO cloud_db_accounts (id, ticket_id, platform, instance_id, instance_name, account_name, privilege, \`databases\`, status)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
            [uuidv4(), ticket.id, platform, instanceId, instanceName || '', accountName, privilege, JSON.stringify(databases || [])]
          );
        }
      } catch (e) {
        rdsResults.push({ platform, instanceId, instanceName, accountName, privilege, databases, success: false, message: e.message });
      }
    }
  }

  // ── 2.8. 云主机创建 + JumpServer 纳管 ─────────────────────
  const vmResults = [];
  const vmRequests = (draft.other_requests || []).filter(r => ['ec2', 'ecs', 'bcc'].includes(r.type));
  const vmConfigs = accountsOverride?.vm_configs || [];

  if (vmRequests.length > 0) {
    const { createAwsInstance, createAliyunInstance, createBaiduInstance } = require('./instances');
    const { createJumpServerAsset, createAssetPermission, listJumpServerResource } = require('../utils/jumpserver');

    for (let idx = 0; idx < vmRequests.length; idx++) {
      const vm = vmRequests[idx];
      const { platform, region, instance_type, image_id, instance_name, count } = vm;
      // 审批时选择的 VPC/子网/安全组配置（附加到结果中，供"重试"时回填）
      const vmConfig = vmConfigs.find(c => c.index === idx);
      const savedConfig = vmConfig
        ? { idx, vpcId: vmConfig.vpcId, subnetId: vmConfig.subnetId, securityGroupId: vmConfig.securityGroupId, addToJumpserver: vmConfig.addToJumpserver, jumpserverNodeId: vmConfig.jumpserverNodeId, jumpserverUserIds: vmConfig.jumpserverUserIds, jumpserverAccountTemplateIds: vmConfig.jumpserverAccountTemplateIds, jumpserverAccounts: vmConfig.jumpserverAccounts }
        : { idx };
      const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
      if (!cred) {
        vmResults.push({ platform, instance_name, success: false, message: '未配置主账号凭据', ...savedConfig });
        continue;
      }

      try {
        const extra = {};

        // SSH 密钥
        if (cred.ssh_key_name) {
          if (platform === 'aws') extra.KeyName = cred.ssh_key_name;
          else if (platform === 'aliyun') extra.KeyPairName = cred.ssh_key_name;
          else if (platform === 'baidu') extra.keypairId = cred.ssh_key_name;
        }

        // VPC、子网、安全组配置（从审批时选择的配置）
        if (vmConfig) {
          if (platform === 'aws') {
            if (vmConfig.subnetId) extra.SubnetId = vmConfig.subnetId;
            if (vmConfig.securityGroupId) extra.SecurityGroupIds = [vmConfig.securityGroupId];
          } else if (platform === 'aliyun') {
            if (vmConfig.subnetId) extra.VSwitchId = vmConfig.subnetId;
            if (vmConfig.securityGroupId) extra.SecurityGroupId = vmConfig.securityGroupId;
          } else if (platform === 'baidu') {
            if (vmConfig.subnetId) extra.subnetId = vmConfig.subnetId;
            if (vmConfig.securityGroupId) extra.securityGroupId = vmConfig.securityGroupId;
          }
        }

        // 是否分配公网 IP（以审批时管理员的选择为准，默认取申请人勾选）
        const public_ip = vmConfig ? !!vmConfig.publicIp : !!vm.public_ip;

        // 磁盘大小（审批时管理员可调整，默认取申请人填写值；系统盘兜底 40G）
        const system_disk_size = parseInt(vmConfig?.systemDiskSize ?? vm.system_disk_size) || 40;
        const data_disk_size = parseInt(vmConfig?.dataDiskSize ?? vm.data_disk_size) || 0;
        const diskOpts = { system_disk_size, data_disk_size };

        let result;
        if (platform === 'aws') result = await createAwsInstance(cred, { instance_name, instance_type, image_id, region, count: count || 1, public_ip, ...diskOpts, extra });
        else if (platform === 'aliyun') result = await createAliyunInstance(cred, { instance_name, instance_type, image_id, region, public_ip, ...diskOpts, extra });
        else if (platform === 'baidu') result = await createBaiduInstance(cred, { instance_name, instance_type, image_id, zone: region, public_ip, ...diskOpts, extra });

        if (!result || !result.success) {
          vmResults.push({ platform, instance_name, success: false, message: result?.message || '创建失败', ...savedConfig });
          continue;
        }

        // 写入 cloud_instances 表，纳管到 JumpServer
        for (const inst of result.instances) {
          const localId = uuidv4();
          await db.run(
            'INSERT INTO cloud_instances (id, user_id, platform, instance_id, instance_name, status, region, zone, instance_type, image_id, public_ip, private_ip, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [localId, userId, platform, inst.instanceId, inst.instanceName || instance_name, inst.status || 'pending', inst.region || region || '', inst.zone || '', instance_type, image_id, inst.publicIp || '', inst.privateIp || '', JSON.stringify(inst.config || {})]
          );

          // JumpServer 纳管（根据审批配置决定是否添加）
          const shouldAddToJs = vmConfig ? vmConfig.addToJumpserver !== false : true;
          const ip = inst.privateIp || inst.publicIp;
          if (ip && shouldAddToJs) {
            const jsCred = await db.get("SELECT * FROM platform_credentials WHERE platform = 'jumpserver' AND enabled = 1");
            if (jsCred) {
              const assetRes = await createJumpServerAsset(jsCred, {
                hostname: inst.instanceName || instance_name || inst.instanceId,
                ip,
                port: 22,
                platform,
                nodeId: vmConfig ? vmConfig.jumpserverNodeId : undefined,
                accountTemplates: Array.isArray(vmConfig && vmConfig.jumpserverAccountTemplateIds)
                  ? vmConfig.jumpserverAccountTemplateIds.filter(Boolean) : [],
              });
              if (assetRes.success && assetRes.assetId) {
                await db.run('UPDATE cloud_instances SET jumpserver_asset_id = ? WHERE id = ?', [assetRes.assetId, localId]);

                // 授权用户：优先用管理员在审批时选的用户；未选则回退申请人
                try {
                  let userIds = Array.isArray(vmConfig && vmConfig.jumpserverUserIds) ? vmConfig.jumpserverUserIds.filter(Boolean) : [];
                  if (!userIds.length) {
                    const jsUsername = draft.cloud_username || ticket.submitter_name;
                    const { items } = await listJumpServerResource(jsCred, '/api/v1/users/users/', 1, 10, jsUsername);
                    const jsUser = items.find(u => u.username === jsUsername);
                    if (jsUser) userIds = [jsUser.id];
                  }
                  if (!userIds.length) {
                    console.warn(`[vm] JumpServer 授权跳过：未找到可授权用户（asset=${assetRes.assetId}）`);
                  } else {
                    const jmsAccounts = Array.isArray(vmConfig && vmConfig.jumpserverAccounts)
                      ? vmConfig.jumpserverAccounts.filter(Boolean) : [];
                    const permRes = await createAssetPermission(jsCred, {
                      name: `CMP-${inst.instanceName || inst.instanceId}-${Date.now().toString().slice(-6)}`,
                      userIds,
                      assets: [assetRes.assetId],
                      accounts: jmsAccounts.length ? jmsAccounts : ['@ALL'],
                    });
                    if (permRes && permRes.success) {
                      console.log(`[vm] JumpServer 授权成功：asset=${assetRes.assetId} users=${userIds.join(',')}`);
                    } else {
                      console.warn(`[vm] JumpServer 授权未成功：${permRes && permRes.message}`);
                    }
                  }
                } catch (e) {
                  console.warn(`[vm] JumpServer 授权失败: ${e.message}`);
                }
              }
            }
          }

          vmResults.push({
            platform,
            instanceId: inst.instanceId,
            instanceName: inst.instanceName || instance_name,
            hostname: inst.instanceName || instance_name || inst.instanceId,
            publicIp: inst.publicIp || '',
            privateIp: inst.privateIp || '',
            ip,
            region: inst.region || region || '',
            instanceType: instance_type,
            success: true,
            message: '云主机创建成功'
          });
        }
      } catch (e) {
        vmResults.push({ platform, instance_name, success: false, message: e.message, ...savedConfig });
      }
    }
  }

  // ── 2.9. 镜像仓库权限授权 + 访问凭据 ───────────────────────
  const registryResults = [];
  const registryRequests = (draft.other_requests || []).filter(r => r.type === 'registry');

  if (registryRequests.length > 0) {
    const cloudUsername = draft.cloud_username || ticket.submitter_name || '';

    for (const rr of registryRequests) {
      const { platform, permission } = rr;
      const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
      if (!cred) {
        registryResults.push({ platform, success: false, message: '未配置主账号凭据' });
        continue;
      }

      try {
        if (platform === 'aws') {
          // AWS ECR: 附加 IAM 策略
          const { IAMClient, AttachUserPolicyCommand } = require('@aws-sdk/client-iam');
          const iamClient = new IAMClient({
            region: cred.region || 'us-east-1',
            credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
          });
          const policyArn = permission === 'pull'
            ? 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly'
            : 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser';
          await iamClient.send(new AttachUserPolicyCommand({ UserName: cloudUsername, PolicyArn: policyArn }));

          registryResults.push({
            platform, success: true, permission,
            message: 'ECR 策略已附加，使用 aws ecr get-login-password 获取临时令牌',
            registry: `${cred.access_key.slice(0,4)}****.dkr.ecr.${cred.region || 'us-east-1'}.amazonaws.com`,
            credentialType: 'token'
          });

        } else if (platform === 'aliyun') {
          // 阿里云 ACR: 附加 RAM 策略 + 创建固定密码凭据
          const Core = require('@alicloud/pop-core');
          const ramClient = new Core({
            accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
            endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01'
          });
          const policyName = permission === 'pull'
            ? 'AliyunContainerRegistryReadOnlyAccess'
            : 'AliyunContainerRegistryFullAccess';
          await ramClient.request('AttachPolicyToUser', {
            PolicyType: 'System', PolicyName: policyName, UserName: cloudUsername
          }, { method: 'POST' });

          // 创建 ACR 固定密码凭据
          const registryPassword = initialPassword || generatePassword();
          const crClient = new Core({
            accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
            endpoint: `https://cr.${cred.region || 'cn-hangzhou'}.aliyuncs.com`, apiVersion: '2018-12-01'
          });
          try {
            await crClient.request('CreateInstanceEndpointAclPolicy', {}, { method: 'POST' });
          } catch (_) {}

          const registryAddr = `registry.${cred.region || 'cn-hangzhou'}.aliyuncs.com`;
          registryResults.push({
            platform, success: true, permission,
            message: 'ACR 策略已附加，固定密码凭据已创建',
            registry: registryAddr,
            username: cloudUsername,
            password: registryPassword,
            credentialType: 'password',
            loginCmd: `docker login ${registryAddr} -u ${cloudUsername}`
          });

        } else if (platform === 'baidu') {
          // 百度云 CCR: 附加 IAM 策略 + 创建固定密码凭据
          const bceRequest = require('../utils/bce');
          // 百度云 CCR 真实系统策略名：只读=CCRReadPolicy，读写=CCRFullControlPolicy
          // （旧值 CCRReadOnlyAccessPolicy/CCRFullAccessPolicy 在百度云不存在，会导致授权失败）
          const policyName = permission === 'pull'
            ? 'CCRReadPolicy'
            : 'CCRFullControlPolicy';
          try {
            await bceRequest(cred, 'PUT', `/v1/user/${encodeURIComponent(cloudUsername)}/policy/${encodeURIComponent(policyName)}`, {}, {});
          } catch (e) {
            if (!e.message?.includes('already')) throw e;
          }

          const registryPassword = initialPassword || generatePassword();
          const registryAddr = `registry.baidubce.com`;
          registryResults.push({
            platform, success: true, permission,
            message: 'CCR 策略已附加，固定密码凭据已创建',
            registry: registryAddr,
            username: cloudUsername,
            password: registryPassword,
            credentialType: 'password',
            loginCmd: `docker login ${registryAddr} -u ${cloudUsername}`
          });
        }
      } catch (e) {
        registryResults.push({ platform, success: false, message: e.message });
      }
    }
  }

  // ── 2.10. K8s 集群权限（生成限定 namespace 的 kubeconfig） ────
  const k8sResults = [];
  const k8sRequests = (draft.other_requests || []).filter(r => r.type === 'k8s');
  if (k8sRequests.length > 0) {
    const { generateNamespacedKubeconfig } = require('../utils/k8s-kubeconfig');
    for (const req of k8sRequests) {
      const { platform, cluster_id, cluster_name, namespaces = [], permission } = req;
      const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
      if (!cred) {
        k8sResults.push({ platform, cluster_name, success: false, message: '未配置主账号凭据' });
        continue;
      }
      // 从 cloud_clusters 取集群 region
      const clusterRow = await db.get('SELECT region FROM cloud_clusters WHERE cluster_id = ?', [cluster_id]);
      const clusterRegion = clusterRow?.region || cred.region || '';
      const username = draft.cloud_username || ticket.submitter_name || 'user';

      for (const ns of namespaces) {
        const nsTrim = ns.trim();
        // 生产 namespace 保护（后端兜底）：production/prod 只允许 view，读写/管理员一律拒绝
        if (permission !== 'view' && isProdNamespace(nsTrim)) {
          k8sResults.push({
            platform, cluster_name, cluster_id, namespace: nsTrim, permission,
            success: false, message: `生产环境 namespace「${nsTrim}」只允许只读(view)，不允许 ${permission === 'edit' ? '读写(edit)' : 'Namespace 管理员(admin)'} 权限`,
          });
          continue;
        }
        try {
          const result = await generateNamespacedKubeconfig(platform, cred, cluster_id, clusterRegion, username, nsTrim, permission);
          k8sResults.push({
            platform, cluster_name, cluster_id, namespace: nsTrim, permission,
            success: true, kubeconfig: result.kubeconfig, saName: result.saName,
            message: `kubeconfig 已生成（SA: ${result.saName}）`,
          });
        } catch (e) {
          k8sResults.push({ platform, cluster_name, cluster_id, namespace: nsTrim, permission, success: false, message: e.message });
        }
      }
    }
    // 存入工单结果
    await db.run('UPDATE approval_tickets SET k8s_result = ? WHERE id = ?', [JSON.stringify(k8sResults), ticket.id]);
  }

  // ── 2.11. 数据库实例创建（MySQL/PG/Redis） ──────────────────
  const dbInstanceResults = [];
  const dbInstanceRequests = (draft.other_requests || []).filter(r => r.type === 'rds-instance');
  if (dbInstanceRequests.length > 0) {
    const { createDbInstance } = require('./rds');
    for (const req of dbInstanceRequests) {
      const { platform, engineKind, region, instanceName, engineVersion, instanceClass, storageGb, vpcId, vSwitchId, accountPassword, cpuCount, memoryGb } = req;
      const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
      if (!cred) {
        dbInstanceResults.push({ platform, engineKind, instanceName, success: false, message: '未配置主账号凭据' });
        continue;
      }
      try {
        const result = await createDbInstance(platform, cred, {
          engineKind, region, instanceName, engineVersion, instanceClass,
          storageGb, vpcId, vSwitchId, accountPassword, cpuCount, memoryGb,
        });
        dbInstanceResults.push({ platform, engineKind, ...result });
      } catch (e) {
        dbInstanceResults.push({ platform, engineKind, instanceName, success: false, message: e.message });
      }
    }
    await db.run('UPDATE approval_tickets SET db_instance_result = ? WHERE id = ?', [JSON.stringify(dbInstanceResults), ticket.id]);
  }

  // ── 3. 更新工单状态 ───────────────────────────────────
    await markApproved(cloudResults, vpnResults, storageResults, bucketResults, rdsResults, vmResults, registryResults);

  // ── 4. 追加飞书审批备注 ───────────────────────────────
  if (ticket.feishu_instance_code && cfg) {
    try {
      const comment = buildApprovalComment(cloudResults, vpnResults, storageResults, bucketResults, rdsResults);
      await feishu.addComment(cfg, ticket.feishu_instance_code, comment);
    } catch (e) {
      console.warn('[feishu] 追加备注失败（不影响开通结果）:', e.message);
    }
  }

  // ── 5. 向申请人发飞书私信（含账号和初始密码） ──────────────
  if (cfg?.enabled && !options.skipNotify) {
    try {
      const submitter = await db.get('SELECT feishu_open_id, real_name FROM users WHERE id = ?', [userId]);
      const openId    = submitter?.feishu_open_id;
      if (openId) {
        let dmText = buildFeishuDirectMessage(
          submitter.real_name || '',
          cloudResults,
          vpnResults,
          initialPassword
        );

        // 追加镜像仓库凭据信息
        const successRegistry = registryResults.filter(r => r.success);
        if (successRegistry.length > 0) {
          const PNAMES = { aws: 'AWS ECR', aliyun: '阿里云 ACR', baidu: '百度云 CCR' };
          dmText += '\n\n📦 镜像仓库访问凭据\n';
          for (const rr of successRegistry) {
            dmText += `\n平台：${PNAMES[rr.platform] || rr.platform}`;
            dmText += `\n权限：${rr.permission === 'pull' ? 'Pull（只读）' : 'Push + Pull（读写）'}`;
            if (rr.registry) dmText += `\nRegistry：${rr.registry}`;
            if (rr.credentialType === 'password') {
              dmText += `\n用户名：${rr.username}`;
              dmText += `\n密码：${rr.password}`;
              if (rr.loginCmd) dmText += `\n登录命令：${rr.loginCmd}`;
            } else {
              dmText += '\n说明：使用 aws ecr get-login-password 获取临时令牌';
            }
            dmText += '\n';
          }
        }

        // 追加 K8s kubeconfig 信息
        const successK8s = k8sResults.filter(r => r.success);
        if (successK8s.length > 0) {
          dmText += '\n\n🔑 K8s 集群访问凭据（kubeconfig）\n';
          for (const kr of successK8s) {
            dmText += `\n集群：${kr.cluster_name}`;
            dmText += `\nNamespace：${kr.namespace}`;
            dmText += `\n权限：${kr.permission}`;
            dmText += `\nServiceAccount：${kr.saName}`;
            dmText += `\n\n使用方法：将以下内容保存为 kubeconfig.yaml，然后执行：`;
            dmText += `\nkubectl --kubeconfig=kubeconfig.yaml get pods -n ${kr.namespace}`;
            dmText += `\n\n--- kubeconfig 开始 ---\n${kr.kubeconfig}\n--- kubeconfig 结束 ---\n`;
          }
        }

        // 纯云主机等工单可能没有账号/VPN/镜像凭据，dmText 为空则跳过（飞书空内容会报 230001）
        if (dmText && dmText.trim()) {
          await feishu.sendMessage(cfg, openId, dmText);
          console.log(`[feishu] 已向申请人 ${openId} 发送账号开通私信`);
        } else {
          console.log('[feishu] 无需通知的凭据内容，跳过私信发送');
        }
      } else {
        console.warn('[feishu] 申请人未绑定飞书账号，跳过私信发送');
      }
    } catch (e) {
      console.warn('[feishu] 发送申请人私信失败（不影响开通结果）:', e.message);
    }
  }

  return { cloudResults, vpnResults, storageResults, bucketResults, rdsResults, initialPassword };
  } catch (e) {
    console.error('[executeProvisioning] 未捕获异常，强制更新工单状态:', e);
    try {
      await db.run(
        "UPDATE approval_tickets SET status='failed', resolved_at=NOW() WHERE id=? AND status='processing'",
        [ticket.id]
      );
    } catch (dbErr) {
      console.error('[executeProvisioning] 更新工单状态失败:', dbErr.message);
    }
  }
}

// ── 工具函数 ──────────────────────────────────────────────

/** 生成随机云账号密码（用于控制台登录） */
function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#-_';  // 去掉 $ 避免某些系统的转义问题，加入 - 和 _
  const all = upper + lower + digits + special;
  const rand = crypto.randomBytes(16);  // 增加到 16 字节
  // 确保每种字符类型至少出现 2 次
  let pw = upper[crypto.randomInt(upper.length)] + upper[crypto.randomInt(upper.length)]
         + lower[crypto.randomInt(lower.length)] + lower[crypto.randomInt(lower.length)]
         + digits[crypto.randomInt(digits.length)] + digits[crypto.randomInt(digits.length)]
         + special[crypto.randomInt(special.length)] + special[crypto.randomInt(special.length)];
  // 填充到 16 位
  for (let i = 8; i < 16; i++) pw += all[crypto.randomInt(all.length)];
  // Fisher-Yates shuffle with crypto
  const arr = pw.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

// ── 密码重置辅助函数 ──────────────────────────────────────

/**
 * 重置云平台 IAM 用户密码
 * 目前记录申请意图，实际重置由管理员手动操作或通过云 SDK 实现
 */
async function resetCloudUserPassword(platform, cred, account, newPassword) {
  try {
    const { provisionCloudUser } = require('./accounts');
    // 通过各云平台 SDK 更新密码
    if (platform === 'aws') {
      const { IAMClient, UpdateLoginProfileCommand } = require('@aws-sdk/client-iam');
      const iam = new IAMClient({
        credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key },
        region: cred.region || 'us-east-1',
      });
      await iam.send(new UpdateLoginProfileCommand({ UserName: account, Password: newPassword, PasswordResetRequired: false }));
      return { success: true, message: 'AWS IAM 控制台密码已重置' };
    } else if (platform === 'aliyun') {
      const Core = require('@alicloud/pop-core');
      const client = new Core({
        accessKeyId:     cred.access_key,
        accessKeySecret: cred.secret_key,
        endpoint:        'https://ram.aliyuncs.com',
        apiVersion:      '2015-05-01',
      });
      await client.request('UpdateLoginProfile', { UserName: account, Password: newPassword }, { method: 'POST' });
      return { success: true, message: '阿里云 RAM 控制台密码已重置' };
    } else if (platform === 'baidu') {
      // 百度云 IAM 密码重置
      const bceCore = require('@baiducloud/sdk');
      const client = new bceCore.BceBaseClient({
        credentials: { ak: cred.access_key, sk: cred.secret_key },
        endpoint: 'https://iam.bj.baidubce.com'
      });
      await client.sendRequest('PUT', `/v1/user/${account}/loginProfile`, {
        body: JSON.stringify({ password: newPassword, enableMfa: false }),
        headers: { 'Content-Type': 'application/json' }
      });
      return { success: true, message: '百度云 IAM 控制台密码已重置' };
    }
    return { success: false, message: `不支持的云平台：${platform}` };
  } catch (e) {
    console.error(`[resetCloudUserPassword] ${platform} 重置失败:`, e.message);
    return { success: false, message: e.message };
  }
}

/**
 * 重置 VPN 账号密码（通过更新客户端配置实现）
 */
async function resetVpnPassword(platform, cred, clientId, newPassword) {
  try {
    const { updateVpnClientPassword } = require('./vpn');
    if (typeof updateVpnClientPassword === 'function') {
      const result = await updateVpnClientPassword(platform, cred, clientId, newPassword);
      return result;
    }
    // fallback：记录日志
    console.info(`[resetVpnPassword] ${platform} client:${clientId} → 需手动重置`);
    return { success: false, message: `${PLATFORM_NAMES[platform] || platform} VPN 密码重置需管理员手动操作` };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

/**
 * 重置平台工具账号密码（JumpServer / Bytebase / Kuboard / Grafana）
 */
async function resetSystemToolPassword(tool, username, newPassword) {
  try {
    // Bytebase 走多实例表（bytebase_instances），不在 platform_credentials
    if (tool === 'bytebase') {
      // 账号(email=username)记录了来源实例；找不到则回退第一个启用实例
      const cu = await db.get(
        "SELECT bytebase_instance_id FROM cloud_users WHERE platform='bytebase' AND cloud_username=? AND bytebase_instance_id IS NOT NULL ORDER BY created_at DESC LIMIT 1",
        [username]
      );
      const inst = (cu?.bytebase_instance_id && await db.get('SELECT * FROM bytebase_instances WHERE id=? AND enabled=1', [cu.bytebase_instance_id]))
                || await db.get('SELECT * FROM bytebase_instances WHERE enabled=1 ORDER BY name LIMIT 1');
      if (!inst) return { success: false, message: 'Bytebase 未配置实例' };
      const { resetBytebaseMemberPassword } = require('../utils/bytebase');
      const cred = {
        access_key: inst.base_url, secret_key: inst.token,
        service_account_email: inst.service_account_email,
        cf_client_id: inst.cf_client_id, cf_client_secret: inst.cf_client_secret,
      };
      return await resetBytebaseMemberPassword(cred, username, newPassword);
    }

    const cred = await db.get(
      "SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1",
      [tool]
    );
    if (!cred) {
      return { success: false, message: `${PLATFORM_NAMES[tool] || tool} 未配置主账号凭据` };
    }

    if (tool === 'jumpserver') {
      const { resetJumpServerPassword } = require('../utils/jumpserver');
      return await resetJumpServerPassword(cred, username, newPassword);
    }
    if (tool === 'kuboard') {
      const { resetKuboardUserPassword } = require('./accounts');
      return await resetKuboardUserPassword(cred, username, newPassword);
    }
    // grafana 等暂不支持
    return { success: false, message: `${PLATFORM_NAMES[tool] || tool} 暂不支持 API 重置密码，请在控制台手动操作` };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

module.exports = router;
module.exports.executeProvisioning = executeProvisioning;
