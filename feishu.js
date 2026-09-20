'use strict';
const crypto = require('crypto');

const FEISHU_BASE = 'https://open.feishu.cn';

// token 内存缓存（进程级别，2h 过期前5分钟刷新）
let _tokenCache = { token: '', expiresAt: 0 };

async function getToken(config) {
  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - 300_000) {
    return _tokenCache.token;
  }
  const res = await fetch(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: config.app_id, app_secret: config.app_secret }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`飞书 Token 获取失败: ${data.msg}`);
  _tokenCache = { token: data.tenant_access_token, expiresAt: Date.now() + data.expire * 1000 };
  return _tokenCache.token;
}

async function _api(config, method, path, body, query) {
  const token = await getToken(config);
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  };
  if (body) opts.body = JSON.stringify(body);
  const url = query
    ? `${FEISHU_BASE}${path}?${new URLSearchParams(query)}`
    : `${FEISHU_BASE}${path}`;
  const res = await fetch(url, opts);

  // 检查响应是否为 JSON
  const contentType = res.headers.get('content-type');
  if (!contentType || !contentType.includes('application/json')) {
    const text = await res.text();
    console.error(`Feishu API Non-JSON Response: [${method} ${url}] Status: ${res.status}`, text.slice(0, 200));
    throw new Error(`飞书 API 返回非 JSON 响应: ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (json.code !== 0) {
    console.error(`Feishu API Error: [${method} ${url}]`, JSON.stringify(json, null, 2));
  }
  return json;
}

/**
 * 一次性初始化审批定义，返回 approval_code
 * 如果已存在 config.approval_code 则跳过创建，直接验证
 */
async function initApprovalDef(config) {
  if (!config.approver_open_id) {
    throw new Error('请先配置「审批人 OpenID」再初始化审批定义');
  }

  const formContent = JSON.stringify([
    { id: 'f_applicant',  name: '@i18n@f_applicant',  type: 'input',    required: true  },
    { id: 'f_email',      name: '@i18n@f_email',      type: 'input',    required: true  },
    { id: 'f_department', name: '@i18n@f_department', type: 'input',    required: false },
    { id: 'f_purpose',    name: '@i18n@f_purpose',    type: 'input',    required: true  },
    { id: 'f_resources',  name: '@i18n@f_resources',  type: 'textarea', required: true  },
    { id: 'f_notes',      name: '@i18n@f_notes',      type: 'textarea', required: false },
  ]);

  const i18n_resources = [{
    locale: 'zh-CN',
    is_default: true,
    texts: [
      { key: '@i18n@approval_name', value: '云账号申请' },
      { key: '@i18n@node_approver', value: '审批' },
      { key: '@i18n@f_applicant',   value: '申请人姓名' },
      { key: '@i18n@f_email',       value: '工作邮箱' },
      { key: '@i18n@f_department',  value: '所在部门' },
      { key: '@i18n@f_purpose',     value: '申请用途' },
      { key: '@i18n@f_resources',   value: '申请资源清单' },
      { key: '@i18n@f_notes',       value: '申请说明' },
    ],
  }];

  console.log(`[feishu] 初始化审批定义，审批人 open_id: ${config.approver_open_id}`);

  const r = await _api(config, 'POST', '/open-apis/approval/v4/approvals', {
    approval_name: '@i18n@approval_name',
    form: { form_content: formContent },
    node_list: [
      { id: 'START',    name: '@i18n@node_approver' },
      { id: 'APPROVER', name: '@i18n@node_approver', node_type: 'AND',
        approver_chosen_type: 1, approver_chosen_multi: false,
        approver: [{ type: 'Personal', user_id: config.approver_open_id }] },
      { id: 'END',      name: '@i18n@node_approver' },
    ],
    viewers: [{ viewer_type: 'TENANT' }],
    i18n_resources,
  }, { user_id_type: 'open_id' });

  if (r.code !== 0) {
    console.error('[feishu initApprovalDef] full response:', JSON.stringify(r));
    throw new Error(`创建审批定义失败: ${r.msg}`);
  }
  return r.data.approval_code;
}

// 审批定义控件缓存（approval_code -> { widget, fetchedAt }），5 分钟过期
const _widgetCache = new Map();

/**
 * 动态获取审批定义里第一个文本控件（input/textarea），返回 { id, type }
 * 避免硬编码控件 ID —— 换审批流后控件 ID 会变
 */
async function getApprovalTextWidget(config) {
  const code = config.approval_code;
  const cached = _widgetCache.get(code);
  if (cached && Date.now() - cached.fetchedAt < 300_000) return cached.widget;

  const r = await _api(config, 'GET', `/open-apis/approval/v4/approvals/${encodeURIComponent(code)}`, null, { locale: 'zh-CN' });
  if (r.code !== 0) throw new Error(`获取审批定义详情失败: ${r.msg}`);
  const form = JSON.parse(r.data.form || '[]');
  // 优先取多行文本，其次单行，再兜底第一个控件
  const widget = form.find(w => w.type === 'textarea')
              || form.find(w => w.type === 'input')
              || form[0];
  if (!widget) throw new Error('审批定义中没有可填写的表单控件');
  const picked = { id: widget.id, type: widget.type };
  _widgetCache.set(code, { widget: picked, fetchedAt: Date.now() });
  return picked;
}

/**
 * 创建审批实例，返回 instance_code
 * @param {object} config   feishu_config 行
 * @param {object} ticket   { applicant, email, department, platforms, notes }
 */
async function createInstance(config, ticket) {
  // 把申请信息汇总填入审批流表单的文本控件
  const formText = [
    `申请人：${ticket.applicant}`,
    `邮箱：${ticket.email}`,
    `申请用途：${ticket.purpose || '未填写'}`,
    `申请资源：\n${ticket.resources}`,
    ticket.notes ? `备注：${ticket.notes}` : '',
  ].filter(Boolean).join('\n');

  // 动态取控件 ID/类型，避免硬编码（换审批流后控件 ID 会变）
  const widget = await getApprovalTextWidget(config);
  const formValues = JSON.stringify([
    { id: widget.id, type: widget.type, value: formText },
  ]);

  // user_id 为申请人；若申请人无飞书账号则退回用管理员 open_id 提交
  const initiatorId = ticket.applicant_open_id || config.approver_open_id;

  const body = {
    approval_code: config.approval_code,
    open_id:       initiatorId,
    form:          formValues,
  };

  const r = await _api(config, 'POST', '/open-apis/approval/v4/instances', body);

  if (r.code !== 0) {
    console.error('[feishu createInstance] field_violations:', JSON.stringify(r.error?.field_violations));
    throw new Error(`创建审批实例失败: ${r.msg}`);
  }
  return { instance_code: r.data.instance_code, initiator_open_id: initiatorId };
}

/** 取消审批实例 */
async function cancelInstance(config, instanceCode, operatorId) {
  if (!operatorId) {
    console.warn('[feishu cancelInstance] 无发起人 open_id，无法撤销飞书审批');
    throw new Error('申请人未绑定飞书账号，无法撤销飞书审批实例');
  }
  const r = await _api(config, 'POST', '/open-apis/approval/v4/instances/cancel', {
    approval_code: config.approval_code,
    instance_code: instanceCode,
    user_id:       operatorId,
    reason:        '申请人撤销',
  }, { user_id_type: 'open_id' });
  if (r.code !== 0) throw new Error(`取消审批失败(code=${r.code}): ${r.msg}`);
}

/** 在审批实例上追加备注（开通结果） */
async function addComment(config, instanceCode, comment) {
  if (!config.approver_open_id) throw new Error('缺少 approver_open_id，无法添加备注');
  const r = await _api(config, 'POST', `/open-apis/approval/v4/instances/${encodeURIComponent(instanceCode)}/comments`, {
    user_id: config.approver_open_id,
    comment,
  }, { user_id_type: 'open_id' });
  if (r.code !== 0) throw new Error(`添加审批备注失败: ${r.msg}`);
  return r.data;
}

/** 处理 webhook 请求体：解密（如有）并返回 event body */
function parseWebhookBody(rawBody, config) {
  // AES 加密模式
  if (rawBody.encrypt) {
    if (!config.encrypt_key) throw new Error('收到加密事件但未配置 Encrypt Key');
    const keyBuf = crypto.createHash('sha256').update(config.encrypt_key).digest();
    const buf    = Buffer.from(rawBody.encrypt, 'base64');
    const iv      = buf.slice(0, 16);
    const content = buf.slice(16);
    const dc = crypto.createDecipheriv('aes-256-cbc', keyBuf, iv);
    return JSON.parse(dc.update(content) + dc.final('utf-8'));
  }
  return rawBody;
}

/** URL 验证握手 */
function isChallenge(body) {
  return body.type === 'url_verification' ? { challenge: body.challenge } : null;
}

/** 验证 verification_token */
function verifyToken(body, expectedToken) {
  if (!expectedToken) return; // 未配置则跳过
  const token = body?.header?.token;
  if (token && token !== expectedToken) throw new Error('Webhook verification_token 不匹配');
}

/**
 * 向指定飞书用户发送文本消息（机器人私信）
 * @param {object} config  feishu_config 行
 * @param {string} openId  接收人 open_id
 * @param {string} text    消息文本
 */
async function sendMessage(config, openId, text, link) {
  let msg_type, content;

  // 飞书 text 消息不允许空内容（否则 230001 invalid message content）
  if (!text || !String(text).trim()) {
    throw new Error('消息内容为空，跳过发送');
  }

  msg_type = 'text';
  const fullText = link ? `${text}\n\n前往工单详情：${link}` : text;
  content = JSON.stringify({ text: fullText });

  const r = await _api(config, 'POST', '/open-apis/im/v1/messages?receive_id_type=open_id', {
    receive_id: openId,
    msg_type,
    content,
  });
  if (r.code !== 0) throw new Error(`发送飞书消息失败: ${r.msg}`);
  return r.data;
}

/** 查询审批实例详情，返回 status: PENDING / APPROVED / REJECTED / CANCELED / DELETED */
async function getInstanceDetail(config, instanceCode) {
  const r = await _api(config, 'GET', `/open-apis/approval/v4/instances/${encodeURIComponent(instanceCode)}`);
  if (r.code !== 0) throw new Error(`查询审批实例失败: ${r.msg}`);
  return r.data;
}

module.exports = { getToken, initApprovalDef, createInstance, cancelInstance, addComment, sendMessage, getInstanceDetail, parseWebhookBody, isChallenge, verifyToken };
