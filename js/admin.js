// ─────────────────────────────────────────
// 平台账号（admin 账号管理）
// ─────────────────────────────────────────
let _adminPwdTargetId = '';
let _adminEditTargetId = '';

let _accountTab = 'system';

async function loadAdminAccounts() {
  // 进入页面默认回到系统账号 tab
  switchAccountTab(_accountTab || 'system');
}

function switchAccountTab(tab) {
  _accountTab = tab;
  document.getElementById('acctab-system')?.classList.toggle('active', tab === 'system');
  document.getElementById('acctab-feishu')?.classList.toggle('active', tab === 'feishu');
  document.getElementById('admin-accounts-panel')?.classList.toggle('hidden', tab !== 'system');
  document.getElementById('feishu-users-panel')?.classList.toggle('hidden', tab !== 'feishu');
  // 创建系统账号按钮只在系统账号 tab 显示
  const createBtn = document.getElementById('admin-create-btn');
  if (createBtn) createBtn.style.display = tab === 'system' ? '' : 'none';
  if (tab === 'system') loadSystemAccounts();
  else loadFeishuUsers();
}

let _adminUsersCache = [];
let _feishuUsersCache = [];

async function loadSystemAccounts() {
  const wrap = document.getElementById('admin-accounts-table-wrap');
  wrap.innerHTML = '<div class="empty-tip">加载中...</div>';
  const r = await get('/accounts/admins');
  if (!r.ok) { wrap.innerHTML = '<div class="empty-tip">加载失败</div>'; return; }
  _adminUsersCache = r.data.users || [];
  filterAdminAccounts(document.getElementById('admin-search')?.value || '');
}

// 输入时只重渲染表格，不动搜索框，避免中文输入被打断
function filterAdminAccounts(keyword) {
  const kw = (keyword || '').toLowerCase().trim();
  const list = kw
    ? _adminUsersCache.filter(u =>
        (u.name || '').toLowerCase().includes(kw) ||
        (u.email || '').toLowerCase().includes(kw))
    : _adminUsersCache;
  const cnt = document.getElementById('admin-count');
  if (cnt) cnt.textContent = `共 ${list.length} 个账号`;
  renderAdminTable(list);
}

// 角色显示名：内置角色用 PROLES，自定义角色回退 system_roles 的 display_name
function _roleLabel(role) {
  if (!role) return '-';
  return PROLES[role] || _allRoles.find(r => r.name === role)?.display_name || role;
}

async function loadFeishuUsers() {
  const wrap = document.getElementById('feishu-users-table-wrap');
  wrap.innerHTML = '<div class="empty-tip">加载中...</div>';
  // 角色列/下拉依赖 _allRoles，登录时已填充；为稳妥这里兜底补一次
  if (!_allRoles.length) {
    const rr = await get('/roles');
    if (rr.ok) _allRoles = rr.data.roles || [];
  }
  const r = await get('/accounts/login-users');
  if (!r.ok) { wrap.innerHTML = `<div class="empty-tip">加载失败：${esc(r.data?.error || '')}</div>`; return; }
  _feishuUsersCache = r.data.users || [];
  filterFeishuUsers(document.getElementById('feishu-search')?.value || '');
}

function filterFeishuUsers(keyword) {
  const kw = (keyword || '').toLowerCase().trim();
  const list = kw
    ? _feishuUsersCache.filter(u =>
        (u.name || '').toLowerCase().includes(kw) ||
        (u.real_name || '').toLowerCase().includes(kw) ||
        (u.email || '').toLowerCase().includes(kw) ||
        (u.feishu_open_id || '').toLowerCase().includes(kw))
    : _feishuUsersCache;
  const cnt = document.getElementById('feishu-count');
  if (cnt) cnt.textContent = `共 ${list.length} 个用户`;
  renderFeishuUsersTable(list, kw);
}

function renderFeishuUsersTable(users, kw) {
  const wrap = document.getElementById('feishu-users-table-wrap');
  if (!users.length) {
    wrap.innerHTML = `<div class="empty-tip">${kw ? '没有符合条件的用户' : '暂无飞书登录用户'}</div>`; return;
  }
  wrap.innerHTML = `
    <table class="acc-table">
      <thead><tr>
        <th>姓名</th><th>邮箱</th><th>角色</th><th>飞书 OpenID</th><th>关联云账号</th><th>关联平台工具</th><th>状态</th><th>首次登录</th><th>操作</th>
      </tr></thead>
      <tbody>${users.map(u => {
        const disabled = u.status === 'disabled';
        const statusBadge = disabled
          ? '<span class="badge" style="background:#fce4e4;color:#c62828;font-size:10px;padding:1px 7px;border-radius:10px">已禁用</span>'
          : '<span class="badge badge-ok" style="font-size:10px;padding:1px 7px;border-radius:10px">正常</span>';
        const openId = u.feishu_open_id
          ? `<code style="font-size:11px;background:var(--g100);padding:1px 5px;border-radius:4px">${esc(u.feishu_open_id)}</code>`
          : '<span style="color:var(--g400);font-size:12px">-</span>';
        return `<tr>
        <td><strong>${esc(u.name)}</strong>${u.real_name && u.real_name !== u.name ? `<div style="font-size:11px;color:var(--g400)">${esc(u.real_name)}</div>` : ''}</td>
        <td style="color:var(--g600)">${esc(u.email)}</td>
        <td><span class="tag ${ROLE_TAG[u.role] || 'tag-user'}">${esc(_roleLabel(u.role))}</span></td>
        <td>${openId}</td>
        <td style="text-align:center">${u.cloud_count > 0 ? `<span class="badge" style="background:#e3f2fd;color:#1565c0;font-size:10px;padding:1px 7px;border-radius:10px;cursor:pointer" title="点击查看明细" onclick="showUserAccounts('${u.id}','${esc(u.name)}','cloud')">${u.cloud_count}</span>` : '<span style="color:var(--g400);font-size:12px">0</span>'}</td>
        <td style="text-align:center">${u.tool_count > 0 ? `<span class="badge" style="background:#f3e5f5;color:#7b1fa2;font-size:10px;padding:1px 7px;border-radius:10px;cursor:pointer" title="点击查看明细" onclick="showUserAccounts('${u.id}','${esc(u.name)}','tool')">${u.tool_count}</span>` : '<span style="color:var(--g400);font-size:12px">0</span>'}</td>
        <td>${statusBadge}</td>
        <td style="color:var(--g400)">${u.created_at ? String(u.created_at).slice(0,10) : '-'}</td>
        <td style="white-space:nowrap">
          <button class="btn-ghost btn-sm" onclick="showFeishuRoleModal('${u.id}')">改角色</button>
          <button class="btn-ghost btn-sm" style="margin-left:4px" onclick="toggleFeishuUserStatus('${u.id}','${esc(u.name)}','${disabled ? 'active' : 'disabled'}')">${disabled ? '启用' : '禁用'}</button>
          <button class="btn-ghost btn-sm btn-danger" style="margin-left:4px" onclick="deleteFeishuUser('${u.id}','${esc(u.name)}',${(u.cloud_count || 0) + (u.tool_count || 0)})">删除</button>
        </td>
      </tr>`; }).join('')}
      </tbody>
    </table>`;
}

let _feishuRoleTargetId = '';

function showFeishuRoleModal(id) {
  const user = _feishuUsersCache.find(u => u.id === id);
  if (!user) return;
  _feishuRoleTargetId = id;
  document.getElementById('feishu-role-title').textContent = `指定角色 — ${user.name}`;
  const sel = document.getElementById('feishu-role-select');
  sel.innerHTML = _allRoles.map(r =>
    `<option value="${esc(r.name)}" ${r.name === user.role ? 'selected' : ''}>${esc(r.display_name)}</option>`
  ).join('') || '<option value="">暂无可用角色</option>';
  _updateFeishuRoleHint(sel.value);
  document.getElementById('feishu-role-err').textContent = '';
  document.getElementById('feishu-role-modal').classList.remove('hidden');
}

function closeFeishuRoleModal() {
  document.getElementById('feishu-role-modal').classList.add('hidden');
}

function _updateFeishuRoleHint(roleName) {
  const el = document.getElementById('feishu-role-hint');
  if (!el) return;
  const role = _allRoles.find(r => r.name === roleName);
  el.textContent = role ? (role.description || '') : (_ROLE_HINTS[roleName] || '');
}

async function submitFeishuRole() {
  const role = document.getElementById('feishu-role-select').value;
  const err  = document.getElementById('feishu-role-err');
  err.textContent = '';
  if (!role) { err.textContent = '请选择角色'; return; }
  if (role === 'admin' && !confirm('确定要将该用户设为管理员吗？\n管理员拥有平台全部功能的完整访问权限，包括账号与凭据管理。')) return;

  const r = await put(`/accounts/login-users/${_feishuRoleTargetId}/role`, { role });
  if (r.ok) {
    toast('角色已更新', 'ok');
    closeFeishuRoleModal();
    loadFeishuUsers();
  } else {
    err.textContent = r.data?.error || '修改失败';
  }
}

async function toggleFeishuUserStatus(id, name, newStatus) {
  const action = newStatus === 'disabled' ? '禁用' : '启用';
  if (!confirm(`确定要${action}用户「${name}」吗？${newStatus === 'disabled' ? '\n禁用后该用户将无法登录平台。' : ''}`)) return;
  const r = await put(`/accounts/login-users/${id}/status`, { status: newStatus });
  if (r.ok) { toast(`已${action}`, 'ok'); loadFeishuUsers(); }
  else toast((r.data?.error || '操作失败'), 'err');
}

async function deleteFeishuUser(id, name, assocCount) {
  const extra = assocCount > 0
    ? `\n该用户名下有 ${assocCount} 个关联账号（云账号 / 平台工具），删除后将解除关联（云端/远端子账号保留，不会被删除）。`
    : '';
  if (!confirm(`确定要删除登录用户「${name}」吗？${extra}`)) return;
  const r = await del(`/accounts/login-users/${id}`);
  if (r.ok) { toast('登录用户已删除', 'ok'); loadFeishuUsers(); }
  else toast((r.data?.error || '删除失败'), 'err');
}

const _PLAT_LABEL_ADMIN = {
  aws: 'AWS', aliyun: '阿里云', baidu: '百度云',
  jumpserver: 'JumpServer', bytebase: 'Bytebase', kuboard: 'Kuboard',
  'grafana-aws': 'Grafana (AWS)', 'grafana-wuwen': 'Grafana (无问)', 'grafana-baidu': 'Grafana (百度)'
};

// 点击关联云账号/平台工具数字，弹窗展示具体账号明细
async function showUserAccounts(id, name, category) {
  const title = category === 'tool' ? '关联平台工具账号' : '关联云账号';
  const overlay = document.createElement('div');
  overlay.id = 'modal-user-accounts';
  overlay.className = 'modal-overlay';
  overlay.onclick = () => overlay.remove();
  overlay.innerHTML = `
    <div class="modal" style="width:520px;max-width:92vw;padding:0" onclick="event.stopPropagation()">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <h3 style="margin:0;font-size:15px">${title} · ${esc(name)}</h3>
        <button style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--g400)" onclick="document.getElementById('modal-user-accounts').remove()">×</button>
      </div>
      <div id="user-accounts-body" style="padding:16px 20px;max-height:60vh;overflow:auto">
        <div class="empty-tip">加载中...</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const r = await get(`/accounts/login-users/${id}/accounts?category=${category}`);
  const body = document.getElementById('user-accounts-body');
  if (!body) return;
  if (!r.ok) { body.innerHTML = `<div class="empty-tip">加载失败：${esc(r.data?.error || '')}</div>`; return; }
  const list = r.data.accounts || [];
  if (!list.length) { body.innerHTML = '<div class="empty-tip">无关联账号</div>'; return; }

  body.innerHTML = `
    <table class="acc-table">
      <thead><tr><th>平台</th><th>账号名</th><th>状态</th><th>创建时间</th></tr></thead>
      <tbody>${list.map(a => {
        const st = a.status === 'active'
          ? '<span class="badge badge-ok" style="font-size:10px;padding:1px 7px;border-radius:10px">正常</span>'
          : `<span class="badge" style="background:var(--g100);color:var(--g500);font-size:10px;padding:1px 7px;border-radius:10px">${esc(a.status || '-')}</span>`;
        return `<tr>
          <td>${esc(_PLAT_LABEL_ADMIN[a.platform] || a.platform)}</td>
          <td style="color:var(--g700)"><strong>${esc(a.cloud_username)}</strong></td>
          <td>${st}</td>
          <td style="color:var(--g400)">${a.created_at ? String(a.created_at).slice(0,10) : '-'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

function renderAdminTable(users) {
  const wrap = document.getElementById('admin-accounts-table-wrap');
  if (!users.length) {
    const kw = document.getElementById('admin-search')?.value?.trim();
    wrap.innerHTML = `<div class="empty-tip">${kw ? '没有符合条件的账号' : '暂无平台账号'}</div>`; return;
  }
  // 默认 admin（最早创建）从完整缓存取，避免过滤后误判；接口按 created_at ASC 排序
  const defaultId = (_adminUsersCache[0] || users[0]).id;
  wrap.innerHTML = `
    <table class="acc-table">
      <thead><tr>
        <th>姓名</th><th>邮箱</th><th>角色</th><th>创建时间</th><th>操作</th>
      </tr></thead>
      <tbody>${users.map(u => `<tr>
        <td><strong>${esc(u.name)}</strong></td>
        <td style="color:var(--g600)">${esc(u.email)}</td>
        <td><span class="tag ${ROLE_TAG[u.role] || 'tag-admin'}">${PROLES[u.role] || u.role}</span></td>
        <td style="color:var(--g400)">${u.created_at.slice(0,10)}</td>
        <td>
          <button class="btn-ghost btn-sm" onclick="showAdminPwdModal('${u.id}','${esc(u.name)}')">修改密码</button>
          ${u.id !== defaultId ? `<button class="btn-ghost btn-sm" onclick="showAdminEditModal('${u.id}','${esc(u.email)}','${u.role}')">编辑</button>` : ''}
          ${u.id !== defaultId ? `<button class="btn-ghost btn-sm btn-danger" onclick="deleteAdminAccount('${u.id}','${esc(u.name)}')">删除</button>` : ''}
        </td>
      </tr>`).join('')}
      </tbody>
    </table>`;
}

async function deleteAdminAccount(id, name) {
  if (!confirm(`确定要删除账号「${name}」吗？`)) return;
  try {
    const r = await del(`/accounts/admins/${id}`);
    if (r.ok) {
      toast('账号已删除', 'ok');
      loadAdminAccounts();
    } else {
      toast('删除失败: ' + (r.data.error || '未知错误'), 'err');
    }
  } catch (e) {
    toast('删除失败: ' + e.message, 'err');
  }
}

function showAdminCreateModal() {
  document.getElementById('adm-name').value = '';
  document.getElementById('adm-email').value = '';
  document.getElementById('adm-password').value = '';
  document.getElementById('adm-create-err').textContent = '';
  // 动态填充角色列表（来自 _allRoles）
  const sel = document.getElementById('adm-role');
  sel.innerHTML = _allRoles.map(r =>
    `<option value="${r.name}">${r.display_name}</option>`
  ).join('') || '<option value="">暂无可用角色</option>';
  _updateAdmRoleHint(sel.value);
  document.getElementById('admin-create-modal').classList.remove('hidden');
}
function closeAdminCreateModal() {
  document.getElementById('admin-create-modal').classList.add('hidden');
}

const _ROLE_HINTS = {
  admin:    '拥有平台所有功能的完整访问权限',
  operator: '可访问计算资源与网络资源，支持创建、同步、删除操作',
  viewer:   '只能查看计算资源与网络资源，无法执行任何操作',
  billing:  '仅可查看各云平台费用账单，无法执行任何操作'
};
function _updateAdmRoleHint(roleName) {
  const el = document.getElementById('adm-role-hint');
  if (!el) return;
  const role = _allRoles.find(r => r.name === roleName);
  el.textContent = role ? (role.description || '') : (_ROLE_HINTS[roleName] || '');
}

async function submitAdminCreate() {
  const name = document.getElementById('adm-name').value.trim();
  const email = document.getElementById('adm-email').value.trim();
  const role = document.getElementById('adm-role').value;
  const password = document.getElementById('adm-password').value;
  const err = document.getElementById('adm-create-err');
  err.textContent = '';
  if (!name || !email || !password) { err.textContent = '请填写所有字段'; return; }
  const r = await post('/accounts/admins', { name, email, role, password });
  if (r.ok) {
    toast('平台账号创建成功', 'ok');
    closeAdminCreateModal();
    loadAdminAccounts();
  } else {
    err.textContent = r.data.error || '创建失败';
  }
}

function showAdminEditModal(id, email, role) {
  _adminEditTargetId = id;
  document.getElementById('adm-edit-email').value = email;
  const sel = document.getElementById('adm-edit-role');
  sel.innerHTML = _allRoles.map(r =>
    `<option value="${r.name}" ${r.name === role ? 'selected' : ''}>${r.display_name}</option>`
  ).join('') || '<option value="">暂无可用角色</option>';
  document.getElementById('adm-edit-err').textContent = '';
  document.getElementById('admin-edit-modal').classList.remove('hidden');
}
function closeAdminEditModal() {
  document.getElementById('admin-edit-modal').classList.add('hidden');
}

async function submitAdminEdit() {
  const email = document.getElementById('adm-edit-email').value.trim();
  const role  = document.getElementById('adm-edit-role').value;
  const err   = document.getElementById('adm-edit-err');
  err.textContent = '';
  if (!email) { err.textContent = '请填写邮箱'; return; }
  const r = await put(`/accounts/admins/${_adminEditTargetId}`, { email, role });
  if (r.ok) {
    toast('账号信息已更新', 'ok');
    closeAdminEditModal();
    loadAdminAccounts();
  } else {
    err.textContent = r.data.error || '修改失败';
  }
}

function showAdminPwdModal(id, name) {
  _adminPwdTargetId = id;
  document.getElementById('admin-pwd-title').textContent = `修改密码 — ${name}`;
  document.getElementById('adm-new-pwd').value = '';
  document.getElementById('adm-pwd-err').textContent = '';
  document.getElementById('admin-pwd-modal').classList.remove('hidden');
}
function closeAdminPwdModal() {
  document.getElementById('admin-pwd-modal').classList.add('hidden');
}

async function submitAdminPwd() {
  const new_password = document.getElementById('adm-new-pwd').value;
  const err = document.getElementById('adm-pwd-err');
  err.textContent = '';
  if (!new_password) { err.textContent = '请输入新密码'; return; }
  const r = await put(`/accounts/admins/${_adminPwdTargetId}/password`, { new_password });
  if (r.ok) {
    toast('密码修改成功', 'ok');
    closeAdminPwdModal();
  } else {
    err.textContent = r.data.error || '修改失败';
  }
}

// ─────────────────────────────────────────
// 系统角色管理
// ─────────────────────────────────────────
async function loadRoles() {
  const wrap = document.getElementById('roles-table-wrap');
  wrap.innerHTML = '<div class="empty-tip">加载中...</div>';
  const r = await get('/roles');
  if (!r.ok) { wrap.innerHTML = '<div class="empty-tip">加载失败</div>'; return; }
  _allRoles = r.data.roles;
  renderRolesTable(_allRoles);
}

function renderRolesTable(roles) {
  const wrap = document.getElementById('roles-table-wrap');
  if (!roles.length) { wrap.innerHTML = '<div class="empty-tip">暂无角色</div>'; return; }

  wrap.innerHTML = `
    <table class="acc-table">
      <thead><tr>
        <th>显示名</th><th>角色标识</th><th>描述</th><th>可访问菜单</th><th>工单提交权限</th><th>操作权限</th><th>操作</th>
      </tr></thead>
      <tbody>${roles.map(role => {
        const groupBadges = (role.accessible_groups || [])
          .map(g => `<span class="group-badge">${GROUP_LABELS[g] || g}</span>`).join('');
        const opBadge = role.can_operate
          ? '<span class="tag tag-ops">可操作</span>'
          : '<span class="tag tag-user">只读</span>';
        const builtinTag = role.is_builtin ? '<span class="tag" style="font-size:11px;background:var(--g100);color:var(--g600)">内置</span>' : '';

        // 工单平台权限展示
        const ticketPlatforms = role.ticket_platforms;
        let ticketBadge = '<span style="color:var(--g400);font-size:12px">-</span>';
        if (!ticketPlatforms || ticketPlatforms.includes('all')) {
          ticketBadge = '<span class="tag" style="background:var(--blue-100);color:var(--primary)">全部平台</span>';
        } else if (ticketPlatforms.length === 0) {
          ticketBadge = '<span class="tag" style="background:var(--g100);color:var(--g500)">禁止提交</span>';
        } else {
          const PLABELS = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
          const badges = ticketPlatforms.map(p => `<span class="group-badge">${PLABELS[p] || p}</span>`).join('');
          ticketBadge = badges;
        }

        // 内置角色不可改不可删；其余角色都可编辑
        const actions = role.is_builtin
          ? '<span style="color:var(--g400);font-size:12px">不可修改</span>'
          : `<button class="btn-ghost btn-sm" style="margin-right:6px" onclick="showRoleEditModal('${role.id}')">编辑</button>`
            + `<button class="btn-danger btn-sm" onclick="deleteRole('${role.id}','${esc(role.display_name)}')">删除</button>`;
        return `<tr class="${role.is_builtin ? 'role-row-builtin' : ''}">
          <td><strong>${esc(role.display_name)}</strong> ${builtinTag}</td>
          <td style="font-family:monospace;color:var(--g600)">${esc(role.name)}</td>
          <td style="color:var(--g600)">${esc(role.description || '-')}</td>
          <td>${groupBadges || '<span style="color:var(--g400)">无</span>'}</td>
          <td>${ticketBadge}</td>
          <td>${opBadge}</td>
          <td>${actions}</td>
        </tr>`;
      }).join('')}
      </tbody>
    </table>`;
}

// 当前编辑中的角色 id；null 表示创建模式
let _roleEditingId = null;

function showRoleCreateModal() {
  _roleEditingId = null;
  document.getElementById('role-modal-title').textContent = '创建系统角色';
  document.getElementById('role-submit-btn').textContent = '创建';
  document.getElementById('r-name').value = '';
  document.getElementById('r-name').disabled = false;
  document.getElementById('r-display').value = '';
  document.getElementById('r-desc').value = '';
  document.getElementById('r-can-operate').checked = false;
  document.querySelectorAll('input[name="r-group"]').forEach(el => el.checked = false);
  document.querySelectorAll('input[name="r-ticket-mode"]').forEach(el => el.checked = el.value === 'all');
  document.querySelectorAll('input[name="r-ticket-platform"]').forEach(el => el.checked = false);
  document.getElementById('r-ticket-platforms').style.display = 'none';
  document.getElementById('role-create-err').textContent = '';
  document.getElementById('role-create-modal').classList.remove('hidden');
}

// 编辑角色：复用同一个弹窗，回填现有配置
// 角色标识(name)不允许改——users.role 存的是 name，改了会让已有账号的角色失效
function showRoleEditModal(id) {
  const role = (_allRoles || []).find(r => r.id === id);
  if (!role) { toast('角色不存在，请刷新重试', 'err'); return; }
  if (role.is_builtin) { toast('内置角色不可修改', 'err'); return; }

  _roleEditingId = id;
  document.getElementById('role-modal-title').textContent = `编辑角色：${role.display_name}`;
  document.getElementById('role-submit-btn').textContent = '保存';

  const nameEl = document.getElementById('r-name');
  nameEl.value = role.name;
  nameEl.disabled = true;          // 标识不可改

  document.getElementById('r-display').value = role.display_name || '';
  document.getElementById('r-desc').value = role.description || '';
  document.getElementById('r-can-operate').checked = !!role.can_operate;

  const groups = role.accessible_groups || [];
  document.querySelectorAll('input[name="r-group"]').forEach(el => { el.checked = groups.includes(el.value); });

  // 工单权限三态：null/["all"]=全部，[]=禁止，其他=指定平台
  const tp = role.ticket_platforms;
  let mode = 'all';
  if (Array.isArray(tp)) {
    if (tp.length === 0) mode = 'none';
    else if (!tp.includes('all')) mode = 'specific';
  }
  document.querySelectorAll('input[name="r-ticket-mode"]').forEach(el => { el.checked = el.value === mode; });
  document.querySelectorAll('input[name="r-ticket-platform"]').forEach(el => {
    el.checked = mode === 'specific' && Array.isArray(tp) && tp.includes(el.value);
  });
  document.getElementById('r-ticket-platforms').style.display = mode === 'specific' ? '' : 'none';

  document.getElementById('role-create-err').textContent = '';
  document.getElementById('role-create-modal').classList.remove('hidden');
}

function closeRoleCreateModal() {
  document.getElementById('role-create-modal').classList.add('hidden');
}

function toggleTicketPlatformMode() {
  const mode = document.querySelector('input[name="r-ticket-mode"]:checked')?.value || 'all';
  const platformsDiv = document.getElementById('r-ticket-platforms');
  if (platformsDiv) {
    platformsDiv.style.display = mode === 'specific' ? '' : 'none';
  }
}

// 创建与编辑共用：按 _roleEditingId 决定走 POST 还是 PUT
async function submitRoleForm() {
  const name         = document.getElementById('r-name').value.trim();
  const display_name = document.getElementById('r-display').value.trim();
  const description  = document.getElementById('r-desc').value.trim();
  const can_operate  = document.getElementById('r-can-operate').checked;
  const accessible_groups = [...document.querySelectorAll('input[name="r-group"]:checked')].map(el => el.value);

  // 工单平台权限
  const ticketMode = document.querySelector('input[name="r-ticket-mode"]:checked')?.value || 'all';
  let ticket_platforms = null;
  if (ticketMode === 'all') {
    ticket_platforms = ['all'];
  } else if (ticketMode === 'none') {
    ticket_platforms = [];
  } else {
    ticket_platforms = [...document.querySelectorAll('input[name="r-ticket-platform"]:checked')].map(el => el.value);
  }

  const err = document.getElementById('role-create-err');
  err.textContent = '';
  if (!name || !display_name) { err.textContent = '请填写角色标识和显示名'; return; }

  const editing = !!_roleEditingId;
  // 编辑时不传 name（后端 PUT 也不接受改标识）
  const body = editing
    ? { display_name, description, accessible_groups, ticket_platforms, can_operate }
    : { name, display_name, description, accessible_groups, ticket_platforms, can_operate };
  const r = editing
    ? await put(`/roles/${_roleEditingId}`, body)
    : await post('/roles', body);

  if (r.ok) {
    toast(editing ? '角色已更新' : '角色创建成功', 'ok');
    closeRoleCreateModal();
    await loadRoles();
    // 刷新角色缓存（下次打开创建账号弹窗时生效）
    const rr = await get('/roles');
    if (rr.ok) _allRoles = rr.data.roles;
    // 改的可能是当前登录者自己的角色，重算一次自己的菜单与操作权限
    if (editing && typeof loadAndApplyPermissions === 'function' && _myRoleData
        && _allRoles.some(x => x.id === _roleEditingId && x.name === me.role)) {
      await loadAndApplyPermissions();
    }
  } else {
    err.textContent = r.data.error || (editing ? '保存失败' : '创建失败');
  }
}

async function deleteRole(id, name) {
  if (!confirm(`确认删除角色「${name}」？`)) return;
  const r = await del(`/roles/${id}`);
  if (r.ok) {
    toast('角色已删除', 'ok');
    loadRoles();
  } else {
    toast(r.data.error || '删除失败', 'err');
  }
}



// ── Logo 管理 ──
