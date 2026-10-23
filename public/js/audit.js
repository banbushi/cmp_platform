// ─────────────────────────────────────────
// 操作审计日志（仅管理员）
// ─────────────────────────────────────────

let _auditPage = 1;
let _auditPageSize = 20;
let _auditSuccess = '';        // '' 全部 / '1' 成功 / '0' 失败
let _auditRows = [];           // 当前页记录，供详情弹窗按 id 取用
let _auditFacetsLoaded = false;

const AUDIT_METHOD_COLORS = {
  POST:   { bg: '#ECFDF5', fg: '#047857' },
  PUT:    { bg: '#EFF6FF', fg: '#1D4ED8' },
  PATCH:  { bg: '#EFF6FF', fg: '#1D4ED8' },
  DELETE: { bg: '#FEF2F2', fg: '#B91C1C' },
};

// 与 middleware/audit.js 的 MODULE_LABELS 保持一致（后端也用它生成下拉 label，
// 这里是表格里模块列的兜底翻译）
const MODULE_LABELS_FE = {
  accounts: '账号', roles: '角色', cloud: '云凭据', sync: '同步',
  instances: '云主机', pai: 'PAI', rds: '数据库', bytebase: 'Bytebase',
  clusters: '集群', storage: '存储', jumpserver: '堡垒机', vpn: 'VPN',
  feishu: '飞书', billing: '账单', oauth: 'OAuth',
  audit: '审计', sso: 'SSO',
};

function _auditQuery() {
  const v = id => (document.getElementById(id)?.value || '').trim();
  const p = new URLSearchParams();
  p.set('page', _auditPage);
  p.set('pageSize', _auditPageSize);
  if (_auditSuccess !== '') p.set('success', _auditSuccess);
  if (v('audit-user'))    p.set('user_id', v('audit-user'));
  if (v('audit-module'))  p.set('module',  v('audit-module'));
  if (v('audit-method'))  p.set('method',  v('audit-method'));
  if (v('audit-start'))   p.set('start',   v('audit-start'));
  if (v('audit-end'))     p.set('end',     v('audit-end'));
  if (v('audit-keyword')) p.set('keyword', v('audit-keyword'));
  return p.toString();
}

async function loadAudit() {
  if (!_auditFacetsLoaded) await loadAuditFacets();
  const wrap = document.getElementById('audit-table-wrap');
  wrap.innerHTML = '<div class="sync-loading"><div class="spin"></div> 正在加载审计记录...</div>';

  const r = await get(`/audit?${_auditQuery()}`);
  if (!r.ok) {
    wrap.innerHTML = `<div class="empty-tip">加载失败：${esc(r.data?.error || '未知错误')}</div>`;
    return;
  }

  _auditRows = r.data.items || [];
  renderAuditTable(_auditRows, r.data.total || 0);
}

// 筛选下拉数据只在首次进入时拉一次，避免每次翻页都查 distinct
async function loadAuditFacets() {
  const r = await get('/audit/facets');
  if (!r.ok) return;
  _auditFacetsLoaded = true;

  const modSel = document.getElementById('audit-module');
  if (modSel) {
    modSel.innerHTML = '<option value="">全部模块</option>' +
      (r.data.modules || []).map(m =>
        `<option value="${esc(m.value)}">${esc(m.label)} (${m.count})</option>`).join('');
  }

  const userSel = document.getElementById('audit-user');
  if (userSel) {
    userSel.innerHTML = '<option value="">全部操作人</option>' +
      (r.data.users || []).map(u =>
        `<option value="${esc(u.user_id)}">${esc(u.user_name || u.user_email || u.user_id)} (${u.n})</option>`).join('');
  }

  const st = r.data.stats || {};
  const el = document.getElementById('audit-stats');
  if (el) {
    el.textContent = st.total
      ? `共 ${st.total} 条记录，最早 ${String(st.earliest || '').slice(0, 10)}`
      : '暂无记录';
  }
}

function renderAuditTable(rows, total) {
  const wrap = document.getElementById('audit-table-wrap');
  if (!rows.length) {
    wrap.innerHTML = '<div class="empty-tip">没有符合条件的审计记录</div>';
    return;
  }

  const body = rows.map(r => {
    const mc = AUDIT_METHOD_COLORS[r.method] || { bg: 'var(--g100)', fg: 'var(--g600)' };
    const who = r.user_name || r.user_email || '-';
    const roleTag = r.user_role
      ? `<div style="color:var(--g400);font-size:11px">${esc(PROLES[r.user_role] || r.user_role)}</div>`
      : '';
    const result = r.success
      ? `<span class="tag" style="background:#ECFDF5;color:#047857">成功</span>`
      : `<span class="tag" style="background:#FEF2F2;color:#B91C1C">失败 ${r.status_code}</span>` +
        (r.error_msg ? `<div style="color:var(--g400);font-size:11px;margin-top:2px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.error_msg)}">${esc(r.error_msg)}</div>` : '');

    return `<tr>
      <td style="white-space:nowrap;color:var(--g600);font-size:12px">${esc(String(r.created_at || ''))}</td>
      <td><strong>${esc(who)}</strong>${roleTag}</td>
      <td>${esc(r.action || '-')}</td>
      <td style="color:var(--g600);font-size:12px">${esc(MODULE_LABELS_FE[r.module] || r.module || '-')}</td>
      <td style="white-space:nowrap">
        <span class="tag" style="background:${mc.bg};color:${mc.fg};font-size:11px">${esc(r.method)}</span>
        <div style="color:var(--g400);font-size:11px;font-family:monospace;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.path)}">${esc(r.path)}</div>
      </td>
      <td>${result}</td>
      <td style="white-space:nowrap"><button class="btn-ghost" style="padding:3px 10px;font-size:12px" onclick="showAuditDetail('${esc(r.id)}')">详情</button></td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="sync-table-container"><table class="sync-table acc-table-compact" style="min-width:1080px">
      <thead><tr>
        <th style="width:150px">时间</th>
        <th style="width:140px">操作人</th>
        <th style="width:180px">操作</th>
        <th style="width:90px">模块</th>
        <th style="width:300px">请求</th>
        <th style="width:150px">结果</th>
        <th style="width:70px">详情</th>
      </tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    ${_buildPagination(total, _auditPage, _auditPageSize, '_goAuditPage', '_setAuditPageSize')}`;
}

function _goAuditPage(p) { _auditPage = p; loadAudit(); }
function _setAuditPageSize(s) { _auditPageSize = Number(s); _auditPage = 1; loadAudit(); }

function setAuditSuccess(val, el) {
  _auditSuccess = val;
  document.querySelectorAll('[data-auditresult]').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _auditPage = 1;
  loadAudit();
}

// 筛选项变化统一回到第一页
function onAuditFilterChange() { _auditPage = 1; loadAudit(); }

function resetAuditFilters() {
  ['audit-user', 'audit-module', 'audit-method', 'audit-start', 'audit-end', 'audit-keyword']
    .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  _auditSuccess = '';
  document.querySelectorAll('[data-auditresult]').forEach(b => b.classList.remove('active'));
  document.querySelector('[data-auditresult="all"]')?.classList.add('active');
  _auditPage = 1;
  loadAudit();
}

// ── 详情弹窗 ──
function showAuditDetail(id) {
  const r = _auditRows.find(x => x.id === id);
  if (!r) return;

  let bodyText = '（无请求体）';
  if (r.req_body) {
    try { bodyText = JSON.stringify(JSON.parse(r.req_body), null, 2); }
    catch (_) { bodyText = r.req_body; }
  }

  const row = (label, val) => val
    ? `<div style="display:flex;gap:10px;font-size:13px"><span style="color:var(--g400);width:82px;flex-shrink:0">${label}</span><span style="word-break:break-all">${esc(String(val))}</span></div>`
    : '';

  document.getElementById('audit-detail-content').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px">
      ${row('时间', r.created_at)}
      ${row('操作人', `${r.user_name || '-'}${r.user_email ? '（' + r.user_email + '）' : ''}`)}
      ${row('角色', r.user_role ? (PROLES[r.user_role] || r.user_role) : '')}
      ${row('操作', r.action)}
      ${row('请求', `${r.method} ${r.path}`)}
      ${row('路由', r.route)}
      ${row('状态码', `${r.status_code}${r.success ? '（成功）' : '（失败）'}`)}
      ${row('错误信息', r.error_msg)}
      ${row('耗时', r.duration_ms != null ? r.duration_ms + ' ms' : '')}
      ${row('来源 IP', r.ip)}
      ${row('User-Agent', r.user_agent)}
    </div>
    <div style="margin-top:16px">
      <div style="font-size:12px;color:var(--g400);margin-bottom:6px">请求体（密码与密钥已脱敏为 ***）</div>
      <pre style="background:var(--g50);border:1px solid var(--g200);border-radius:8px;padding:12px;font-size:12px;overflow:auto;max-height:280px;margin:0">${esc(bodyText)}</pre>
    </div>`;

  document.getElementById('modal-audit-detail').classList.remove('hidden');
}

function closeAuditDetail() {
  document.getElementById('modal-audit-detail').classList.add('hidden');
}
