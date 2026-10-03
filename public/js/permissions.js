// ═══════════════════════════════════════════════════════════════
// 权限控制模块
// ═══════════════════════════════════════════════════════════════

let _ticketPlatforms = null; // null 或 ["all"] 表示全部可用，[] 表示不可提交

async function loadAndApplyPermissions() {
  const [r] = await Promise.all([get('/roles'), refreshApplyVisibility()]);
  if (r.ok) {
    _allRoles = r.data.roles;
    _myRoleData = _allRoles.find(ro => ro.name === me.role) || null;
  }
  if (!_myRoleData) {
    _myRoleData = BUILTIN_ROLE_DEFAULTS[me.role] || { accessible_groups: [], can_operate: false };
  }
  _ticketPlatforms = _myRoleData.ticket_platforms;
  applyRolePermissions(_myRoleData);
}

function canOperate() {
  return !!(_myRoleData && _myRoleData.can_operate);
}

function hasGroup(group) {
  return (_myRoleData?.accessible_groups || []).includes(group);
}

// 概览仪表盘展示的是账号/主机/集群/数据库统计，只有账单或只有工单权限的角色进去是一片空数据
function canViewOverview() {
  return ['accounts', 'compute', 'database', 'network', 'storage'].some(hasGroup);
}

function defaultSection() {
  if (canViewOverview()) return 'overview';
  if (hasGroup('tickets')) return 'apply-account';
  if (hasGroup('billing')) return 'billing-aws';
  return 'my-profile';
}

function canSubmitTicketForPlatform(platform) {
  if (!_ticketPlatforms || _ticketPlatforms.includes('all')) return true;
  return _ticketPlatforms.includes(platform);
}

function getTicketAllowedPlatforms() {
  return _ticketPlatforms;
}

function applyRolePermissions(roleData) {
  const body = document.body;
  body.classList.remove('role-admin', 'role-operator', 'role-viewer');
  const groups = roleData.accessible_groups || [];
  if (groups.includes('system') || groups.includes('accounts')) {
    body.classList.add('role-admin');
  } else if (roleData.can_operate) {
    body.classList.add('role-operator');
  } else {
    body.classList.add('role-viewer');
  }
  const _roleNames = { admin: '管理员', operator: '操作员', viewer: '只读用户', applicant: '申请人' };
  const roleEl = document.getElementById('nav-user-role');
  if (roleEl) roleEl.textContent = roleData.display_name || _roleNames[me.role] || me.role || '-';
  ['accounts', 'compute', 'database', 'network', 'storage', 'billing', 'system', 'tickets'].forEach(g => {
    const el = document.getElementById(`ng-${g}`);
    if (el) el.style.display = groups.includes(g) ? '' : 'none';
  });
  // 子菜单级权限：组可见但只勾了部分子菜单时，隐藏未勾选的
  document.querySelectorAll('.nav-sub-link[data-section]').forEach(el => {
    const section = el.dataset.section;
    if (!SECTION_GROUP[section]) return;
    el.style.display = roleHasSection(roleData, section) ? '' : 'none';
  });
  const navOverview = document.getElementById('nav-overview');
  if (navOverview) navOverview.style.display = canViewOverview() ? '' : 'none';
  const ovBilling = document.getElementById('overview-billing-block');
  if (ovBilling) ovBilling.style.display = groups.includes('billing') ? '' : 'none';
  const navProfile = document.getElementById('nav-my-profile');
  if (navProfile) navProfile.style.display = '';
  const navPermQuery = document.getElementById('nav-perm-query');
  if (navPermQuery) navPermQuery.style.display = '';
  const navFeedback = document.getElementById('nav-feedback');
  if (navFeedback) navFeedback.style.display = '';
  const isAdmin = body.classList.contains('role-admin');
  document.querySelectorAll('.perm-admin-nav').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  applyFeatureVisibility();
}

// 管理员关闭的功能入口：隐藏对应菜单项（含管理员自己，所见即用户所见）
function applyFeatureVisibility() {
  Object.keys(FEATURE_SECTIONS).forEach(section => {
    const el = document.querySelector(`.nav-sub-link[data-section="${section}"]`);
    // 角色本身没勾这个子菜单时，功能开关不能把它重新显示出来
    if (el) el.style.display = (roleHasSection(_myRoleData, section) && isFeatureVisible(section)) ? '' : 'none';
  });
}
