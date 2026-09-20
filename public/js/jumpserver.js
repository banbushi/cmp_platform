// ─────────────────────────────────────────
// 堡垒机管理 (JumpServer)
// ─────────────────────────────────────────
let _jsTab = 'groups';
const _jsPage = { groups: 1, assets: 1, users: 1 };
const _jsPageSize = { groups: 20, assets: 20, users: 20 };
const _jsSearch = { groups: '', assets: '', users: '' };

function loadJumpServer() {
  jsTabSwitch(_jsTab);
}

function jsTabSwitch(tab) {
  _jsTab = tab;
  ['groups', 'assets', 'users'].forEach(t => {
    const btn = document.getElementById(`js-tab-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
  });
  _jsLoadTab(tab);
}

function _jsGoPage(tab, page) {
  _jsPage[tab] = page;
  _jsLoadTab(tab);
}

function _jsSetPageSize(tab, size) {
  _jsPageSize[tab] = size;
  _jsPage[tab] = 1;
  _jsLoadTab(tab);
}

function _jsDoSearch(tab) {
  const el = document.getElementById('js-search-input');
  _jsSearch[tab] = el ? el.value.trim() : '';
  _jsPage[tab] = 1;
  _jsLoadTab(tab);
}

async function _jsLoadTab(tab) {
  const wrap = document.getElementById('jumpserver-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="sync-loading"><div class="spin"></div> 加载中...</div>';

  const apiMap = { groups: '/jumpserver/user-groups', assets: '/jumpserver/assets', users: '/jumpserver/users' };
  const page = _jsPage[tab];
  const pageSize = _jsPageSize[tab];
  const search = _jsSearch[tab];

  const qs = new URLSearchParams({ page, pageSize, search });
  const r = await get(`${apiMap[tab]}?${qs}`);

  if (!r.ok) {
    wrap.innerHTML = `<div class="empty-tip">加载失败：${r.data?.error || '未知错误'}</div>`;
    return;
  }

  if (r.data.error) {
    wrap.innerHTML = `<div class="empty-tip" style="color:var(--g500)">${esc(r.data.error)}，请到「系统 → 接入集成」配置 JumpServer 凭据</div>`;
    return;
  }

  const { items, total } = r.data;

  let searchBar = `<div style="display:flex;gap:10px;margin-bottom:14px;align-items:center">
    <span class="search-field" style="flex:1;max-width:280px">
      <input type="text" class="search-input" id="js-search-input" placeholder="搜索..." value="${esc(search)}" onkeydown="if(event.key==='Enter')_jsDoSearch('${tab}')">
    </span>
    <button class="btn-ghost btn-sm" onclick="_jsDoSearch('${tab}')">搜索</button>
    <span style="font-size:12px;color:var(--g400)">共 ${total} 条</span>
    ${tab === 'assets' ? '<button class="btn-primary btn-sm perm-operate" style="margin-left:auto" onclick="jsShowAssetCreate()">+ 新增资产</button>' : ''}
  </div>`;

  let table = '';
  if (tab === 'groups') {
    table = _jsRenderGroups(items);
  } else if (tab === 'assets') {
    table = _jsRenderAssets(items);
  } else {
    table = _jsRenderUsers(items);
  }

  const pagination = _buildPagination(total, page, pageSize,
    '_jsGoPage',
    '_jsSetPageSize',
    `'${tab}'`
  );

  wrap.innerHTML = searchBar + table + pagination;
}

function _jsRenderGroups(items) {
  if (!items.length) return '<div class="empty-tip">暂无用户组</div>';
  return `<table class="acc-table"><thead><tr>
    <th>名称</th><th>用户数</th><th>备注</th><th>创建时间</th>
  </tr></thead><tbody>${items.map(g => {
    const cnt = g.users_amount ?? g.users?.length ?? 0;
    const cntCell = cnt > 0
      ? `<a onclick="jsShowGroupUsers('${esc(g.id)}','${esc((g.name||'').replace(/'/g,''))}')" style="cursor:pointer;color:var(--primary)">${cnt} 人 ›</a>`
      : '0 人';
    return `<tr>
    <td style="font-weight:500">${esc(g.name || '-')}</td>
    <td>${cntCell}</td>
    <td style="font-size:12px;color:var(--g500)">${esc(g.comment || '-')}</td>
    <td style="font-size:12px;color:var(--g400)">${(g.date_created || '').slice(0, 16)}</td>
  </tr>`; }).join('')}</tbody></table>`;
}

function _jsRenderAssets(items) {
  if (!items.length) return '<div class="empty-tip">暂无资产</div>';
  return `<table class="acc-table"><thead><tr>
    <th>主机名</th><th>IP</th><th>平台</th><th>节点</th><th>授权用户/组</th><th>状态</th><th class="perm-operate">操作</th>
  </tr></thead><tbody>${items.map(a => {
    const ip = a.address || a.ip || '-';
    const platform = a.platform?.name || a.platform || '-';
    const nodes = (a.nodes || []).map(n => n.full_value || n.value || n.name || '').filter(Boolean).join(', ') || '-';
    const active = a.is_active !== false;
    const name = a.name || a.hostname || '-';
    return `<tr>
      <td style="font-weight:500">${esc(name)}</td>
      <td style="font-family:monospace;font-size:12px">${esc(ip)}</td>
      <td>${esc(platform)}</td>
      <td style="font-size:12px;color:var(--g500)">${esc(nodes)}</td>
      <td style="font-size:12px"><a onclick="jsShowAssetPerms('${esc(a.id)}','${esc(name.replace(/'/g,''))}')" style="cursor:pointer;color:var(--primary)">查看授权 ›</a></td>
      <td><span class="badge ${active ? 'badge-ok' : 'badge-gray'}">${active ? '在线' : '离线'}</span></td>
      <td class="perm-operate">
        <button class="btn-ghost btn-sm perm-operate" style="padding:2px 10px;font-size:12px" onclick="jsShowGrant('${esc(a.id)}','${esc(name.replace(/'/g,''))}')">授权</button>
        <button class="btn-ghost btn-sm" style="color:var(--err,#dc2626);padding:2px 10px;font-size:12px;margin-left:4px" onclick="jsDeleteAsset('${esc(a.id)}','${esc(name.replace(/'/g,''))}')">删除</button>
      </td>
    </tr>`;
  }).join('')}</tbody></table>`;
}

function _jsRenderUsers(items) {
  if (!items.length) return '<div class="empty-tip">暂无用户</div>';
  return `<table class="acc-table"><thead><tr>
    <th>用户名</th><th>姓名</th><th>邮箱</th><th>角色</th><th>状态</th><th>最近登录</th>
  </tr></thead><tbody>${items.map(u => {
    const role = u.role_display || u.role || '-';
    const active = u.is_active !== false;
    const lastLogin = u.last_login ? u.last_login.slice(0, 16) : '-';
    return `<tr>
      <td style="font-weight:500">${esc(u.username || '-')}</td>
      <td>${esc(u.name || '-')}</td>
      <td style="font-size:12px">${esc(u.email || '-')}</td>
      <td><span class="badge badge-info" style="font-size:10px">${esc(role)}</span></td>
      <td><span class="badge ${active ? 'badge-ok' : 'badge-gray'}">${active ? '启用' : '禁用'}</span></td>
      <td style="font-size:12px;color:var(--g400)">${lastLogin}</td>
    </tr>`;
  }).join('')}</tbody></table>`;
}

// ── 资产：删除 ──
async function jsDeleteAsset(id, name) {
  if (!confirm(`确定删除资产「${name}」？此操作会从 JumpServer 移除该资产（不影响云主机本身）。`)) return;
  const r = await del(`/jumpserver/assets/${encodeURIComponent(id)}`);
  if (!r.ok) { toast(r.data?.error || '删除失败', 'err'); return; }
  toast('资产已删除', 'ok');
  _jsLoadTab('assets');
}

// ── 资产：新增 ──
async function jsShowAssetCreate() {
  // 动态构建弹窗
  let modal = document.getElementById('modal-js-asset-create');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-js-asset-create';
    modal.className = 'modal-overlay hidden';
    modal.onclick = () => modal.classList.add('hidden');
    modal.innerHTML = `<div class="modal" style="width:440px;max-width:95vw" onclick="event.stopPropagation()">
      <div class="modal-header"><h3>新增资产</h3><button class="modal-close" onclick="document.getElementById('modal-js-asset-create').classList.add('hidden')">✕</button></div>
      <div style="padding:20px 24px;display:flex;flex-direction:column;gap:14px">
        <div class="field"><label>主机名 <span class="req">*</span></label><input type="text" id="js-ac-name" placeholder="如 host-2026-01" style="margin-top:6px"></div>
        <div class="field"><label>IP 地址 <span class="req">*</span></label><input type="text" id="js-ac-ip" placeholder="如 10.0.5.12" style="margin-top:6px"></div>
        <div class="field"><label>SSH 端口</label><input type="number" id="js-ac-port" value="22" min="1" max="65535" style="margin-top:6px"></div>
        <div class="field"><label>资产树节点(组)</label><select id="js-ac-node" style="margin-top:6px"><option value="">默认（不指定）</option></select></div>
        <div id="js-ac-err" class="err-text"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn-ghost" onclick="document.getElementById('modal-js-asset-create').classList.add('hidden')">取消</button>
          <button class="btn-primary" id="js-ac-submit" onclick="jsSubmitAssetCreate()">创建</button>
        </div>
      </div></div>`;
    document.body.appendChild(modal);
  }
  // 重置
  document.getElementById('js-ac-name').value = '';
  document.getElementById('js-ac-ip').value = '';
  document.getElementById('js-ac-port').value = '22';
  document.getElementById('js-ac-err').textContent = '';
  modal.classList.remove('hidden');
  // 加载节点
  const nodeSel = document.getElementById('js-ac-node');
  const r = await get('/jumpserver/nodes?pageSize=100');
  if (r.ok && r.data && r.data.items) {
    nodeSel.innerHTML = '<option value="">默认（不指定）</option>'
      + r.data.items.map(n => `<option value="${esc(n.id)}">${esc(n.full_value || n.value || n.id)}</option>`).join('');
  }
}

async function jsSubmitAssetCreate() {
  const errEl = document.getElementById('js-ac-err');
  errEl.textContent = '';
  const hostname = document.getElementById('js-ac-name').value.trim();
  const ip = document.getElementById('js-ac-ip').value.trim();
  const port = document.getElementById('js-ac-port').value;
  const nodeId = document.getElementById('js-ac-node').value;
  if (!hostname) { errEl.textContent = '请填写主机名'; return; }
  if (!ip) { errEl.textContent = '请填写 IP 地址'; return; }
  const btn = document.getElementById('js-ac-submit');
  btn.disabled = true; btn.textContent = '创建中...';
  const r = await post('/jumpserver/assets', { hostname, ip, port, nodeId });
  btn.disabled = false; btn.textContent = '创建';
  if (!r.ok) { errEl.textContent = r.data?.error || '创建失败'; return; }
  toast('资产已创建', 'ok');
  document.getElementById('modal-js-asset-create').classList.add('hidden');
  _jsLoadTab('assets');
}

// ── 通用明细弹窗 ──
function _jsShowDetailPopup(title, html) {
  let modal = document.getElementById('modal-js-detail');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-js-detail';
    modal.className = 'modal-overlay hidden';
    modal.onclick = () => modal.classList.add('hidden');
    modal.innerHTML = `<div class="modal" style="width:420px;max-width:95vw" onclick="event.stopPropagation()">
      <div class="modal-header"><h3 id="js-detail-title"></h3><button class="modal-close" onclick="document.getElementById('modal-js-detail').classList.add('hidden')">✕</button></div>
      <div id="js-detail-body" style="max-height:50vh;overflow:auto"></div></div>`;
    document.body.appendChild(modal);
  }
  document.getElementById('js-detail-title').textContent = title;
  document.getElementById('js-detail-body').innerHTML = html;
  modal.classList.remove('hidden');
}

// 查看用户组成员
async function jsShowGroupUsers(groupId, groupName) {
  _jsShowDetailPopup(`用户组「${groupName}」成员`, '<div style="padding:16px;color:var(--g400)">加载中...</div>');
  const r = await get(`/jumpserver/user-groups/${encodeURIComponent(groupId)}/users`);
  if (!r.ok || !(r.data.items||[]).length) {
    document.getElementById('js-detail-body').innerHTML = '<div style="padding:16px;color:var(--g400)">暂无成员</div>';
    return;
  }
  const rows = r.data.items.map(u => `<div style="display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid var(--g100)">
    <div class="avatar" style="width:30px;height:30px;font-size:13px">${esc((u.name||u.username||'?').charAt(0).toUpperCase())}</div>
    <div><div style="font-weight:500;font-size:13px">${esc(u.name || u.username)}</div><div style="font-size:12px;color:var(--g400)">@${esc(u.username)}</div></div>
  </div>`).join('');
  document.getElementById('js-detail-body').innerHTML = rows;
}

// 查看资产授权明细
async function jsShowAssetPerms(assetId, assetName) {
  _jsShowDetailPopup(`资产「${assetName}」授权`, '<div style="padding:16px;color:var(--g400)">加载中...</div>');
  const r = await get(`/jumpserver/assets/${encodeURIComponent(assetId)}/perms`);
  if (!r.ok) {
    document.getElementById('js-detail-body').innerHTML = '<div style="padding:16px;color:var(--err,#dc2626)">加载失败</div>';
    return;
  }
  const { permissions = [], users = [], groups = [] } = r.data || {};
  let html = '';
  if (permissions.length) html += `<div style="padding:8px 16px;font-size:12px;color:var(--g500)">授权规则：${esc(permissions.join('、'))}</div>`;
  if (users.length) {
    html += '<div style="padding:8px 16px;font-size:13px;font-weight:600;color:var(--g700)">授权用户</div>';
    html += users.map(name => `<div style="padding:6px 16px 6px 28px;font-size:13px">• ${esc(name)}</div>`).join('');
  }
  if (groups.length) {
    html += '<div style="padding:8px 16px;font-size:13px;font-weight:600;color:var(--g700)">授权用户组</div>';
    html += groups.map(name => `<div style="padding:6px 16px 6px 28px;font-size:13px">• ${esc(name)}</div>`).join('');
  }
  if (!users.length && !groups.length) html += '<div style="padding:16px;color:var(--g400)">暂无授权</div>';
  document.getElementById('js-detail-body').innerHTML = html;
}

// ── 资产：授权给指定系统账号 ──
let _jsGrantAssetId = null;

async function jsShowGrant(assetId, assetName) {
  _jsGrantAssetId = assetId;
  let modal = document.getElementById('modal-js-grant');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-js-grant';
    modal.className = 'modal-overlay hidden';
    modal.onclick = () => modal.classList.add('hidden');
    modal.innerHTML = `<div class="modal" style="width:480px;max-width:95vw" onclick="event.stopPropagation()">
      <div class="modal-header"><h3>资产授权</h3><button class="modal-close" onclick="document.getElementById('modal-js-grant').classList.add('hidden')">✕</button></div>
      <div style="padding:20px 24px;display:flex;flex-direction:column;gap:14px">
        <div style="font-size:13px;color:var(--g600)">资产：<span id="js-grant-asset" style="font-weight:600"></span></div>
        <div class="field"><label>系统账号 <span class="req">*</span></label>
          <select id="js-grant-account" style="margin-top:6px"><option value="">加载中...</option></select>
          <div style="font-size:11.5px;color:var(--g400);margin-top:4px">资产上已有的登录账号（如 root）</div>
        </div>
        <div class="field"><label>授权用户 <span class="req">*</span></label>
          <input type="text" id="js-grant-user-search" placeholder="搜索用户名/姓名筛选" style="margin-top:6px" oninput="_jsGrantFilterUsers(this.value)">
          <div id="js-grant-users" style="margin-top:8px;max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:8px;padding:6px"></div>
        </div>
        <div id="js-grant-err" class="err-text"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn-ghost" onclick="document.getElementById('modal-js-grant').classList.add('hidden')">取消</button>
          <button class="btn-primary" id="js-grant-submit" onclick="jsSubmitGrant()">确认授权</button>
        </div>
      </div></div>`;
    document.body.appendChild(modal);
  }
  document.getElementById('js-grant-asset').textContent = assetName;
  document.getElementById('js-grant-err').textContent = '';
  document.getElementById('js-grant-user-search').value = '';
  modal.classList.remove('hidden');

  // 加载资产的系统账号
  const acctSel = document.getElementById('js-grant-account');
  acctSel.innerHTML = '<option value="">加载中...</option>';
  const ar = await get(`/jumpserver/assets/${encodeURIComponent(assetId)}/accounts`);
  if (ar.ok && ar.data.accounts && ar.data.accounts.length) {
    acctSel.innerHTML = ar.data.accounts.map(a =>
      `<option value="${esc(a.username || a.name)}">${esc(a.name || a.username)}${a.username && a.name !== a.username ? `（${esc(a.username)}）` : ''}</option>`
    ).join('');
  } else {
    acctSel.innerHTML = '<option value="">该资产暂无系统账号</option>';
  }

  // 加载 JumpServer 用户列表（多选）
  _jsGrantAllUsers = [];
  const ur = await get('/jumpserver/users?pageSize=500');
  if (ur.ok && ur.data.items) _jsGrantAllUsers = ur.data.items;
  _jsGrantRenderUsers(_jsGrantAllUsers);
}

let _jsGrantAllUsers = [];

function _jsGrantRenderUsers(list) {
  const box = document.getElementById('js-grant-users');
  if (!box) return;
  if (!list.length) { box.innerHTML = '<div style="padding:8px;color:var(--g400);font-size:13px">无用户</div>'; return; }
  box.innerHTML = list.map(u => `<label style="display:flex;align-items:center;gap:8px;padding:5px 6px;cursor:pointer;font-size:13px">
    <input type="checkbox" class="js-grant-user-chk" value="${esc(u.id)}">
    <span>${esc(u.name || u.username)}<span style="color:var(--g400)">（${esc(u.username)}）</span></span>
  </label>`).join('');
}

function _jsGrantFilterUsers(kw) {
  const k = (kw || '').toLowerCase().trim();
  const checked = new Set([...document.querySelectorAll('.js-grant-user-chk:checked')].map(el => el.value));
  const filtered = !k ? _jsGrantAllUsers : _jsGrantAllUsers.filter(u =>
    (u.username || '').toLowerCase().includes(k) || (u.name || '').toLowerCase().includes(k));
  _jsGrantRenderUsers(filtered);
  // 恢复已勾选状态
  document.querySelectorAll('.js-grant-user-chk').forEach(el => { if (checked.has(el.value)) el.checked = true; });
}

async function jsSubmitGrant() {
  const errEl = document.getElementById('js-grant-err');
  errEl.textContent = '';
  const account = document.getElementById('js-grant-account').value;
  const userIds = [...document.querySelectorAll('.js-grant-user-chk:checked')].map(el => el.value);
  if (!account) { errEl.textContent = '请选择系统账号'; return; }
  if (!userIds.length) { errEl.textContent = '请至少选择一个授权用户'; return; }

  const btn = document.getElementById('js-grant-submit');
  btn.disabled = true; btn.textContent = '授权中...';
  const r = await post(`/jumpserver/assets/${encodeURIComponent(_jsGrantAssetId)}/grant`, {
    userIds, accounts: [account],
  });
  btn.disabled = false; btn.textContent = '确认授权';
  if (!r.ok) { errEl.textContent = r.data?.error || '授权失败'; return; }
  toast('授权规则已创建', 'ok');
  document.getElementById('modal-js-grant').classList.add('hidden');
  _jsLoadTab('assets');
}
