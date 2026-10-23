// ═══════════════════════════════════════════════════════════════
// 导航模块
// ═══════════════════════════════════════════════════════════════

function navTo(section) {
  if (section === 'third-accounts') section = 'cloud-accounts';
  if (section === 'jumpserver') section = 'instances';
  if (section === 'apply-config') section = 'settings';
  if (section === 'feedback') section = 'my-profile';
  if (section !== 'overview' && section !== 'my-profile' && section !== 'perm-query' && _myRoleData) {
    if (!roleHasSection(_myRoleData, section)) {
      section = 'my-profile';
    }
  }
  // 管理员关闭的功能入口不可直达（hash / lastSection 也拦掉）
  if (FEATURE_SECTIONS[section] && !isFeatureVisible(section)) {
    section = 'my-profile';
  }
  // 概览是资源统计页，无任何资源类权限的角色（如仅账单、仅工单）不可访问
  if (section === 'overview' && _myRoleData && !canViewOverview()) {
    section = defaultSection() === 'overview' ? 'my-profile' : defaultSection();
  }
  localStorage.setItem('lastSection', section);
  location.hash = `section=${section}`;
  const secId = SEC_ID_MAP[section] || section;
  document.querySelectorAll('.sec').forEach(s => s.classList.add('hidden'));
  document.querySelectorAll('.nav-link, .nav-sub-link').forEach(l => l.classList.remove('active'));
  document.getElementById(`sec-${secId}`).classList.remove('hidden');
  document.querySelector(`[data-section="${section}"]`)?.classList.add('active');

  document.querySelectorAll('.nav-group').forEach(g => g.classList.remove('has-active', 'open'));
  const group = SECTION_GROUP[section];
  if (group) {
    const groupEl = document.getElementById(`ng-${group}`);
    if (groupEl) {
      groupEl.classList.add('open', 'has-active');
      _saveNavGroupState(group, true);
    }
  }

  if (section === 'overview') loadOverview();
  else if (section === 'cloud-accounts') loadAccounts();
  else if (section === 'create') initCreate();
  else if (section === 'groups') loadGroups();
  else if (section === 'instances') loadInstances();
  else if (section === 'clusters') loadClusters();
  else if (section === 'pai-dsw') loadPaiDsw();
  else if (section === 'rds-mysql') loadRdsInstances();
  else if (section === 'rds-postgres') loadRdsInstances();
  else if (section === 'rds-redis') loadRdsInstances();
  else if (section === 'security-groups') loadSecurityGroups();
  else if (section === 'vpcs') loadVpcs();
  else if (section === 'subnets') loadSubnets();
  else if (section === 'vpn-clients') loadVpnClients();
  else if (section === 'settings') loadSettings();
  else if (section === 'audit') loadAudit();
  else if (section === 'admin-accounts') loadAdminAccounts();
  else if (section === 'roles') loadRoles();
  else if (section === 'approval-tickets') loadTickets();
  else if (section === 'my-tickets') loadMyTickets();
  else if (section === 'apply-account') initApplyAccount();
  else if (section === 'apply-resource') initApplyResource();
  else if (section === 'my-profile') loadMyProfile();
  else if (section === 'perm-query') loadPermQuery();
  else if (section === 'feishu-config') { switchIntegrationTab('feishu'); loadFeishuConfig(); }
  else if (section === 'ssl-certs') loadCerts();
  else if (section === 'dns-records') loadDnsRecords();
  else if (section === 'disks') loadDisks();
  else if (section === 'buckets') loadBuckets();
  else if (section === 'cpfs') loadCpfs();
  else if (section === 'policies') loadPolicies();
  else if (section.startsWith('billing-')) {
    _billingPlatform = section.split('-')[1];
    loadBilling();
  }
}

function toggleNavGroup(name) {
  // 折叠态下点击分组图标：先展开侧边栏，子项才可见
  if (document.body.classList.contains('sidebar-collapsed')) {
    toggleSidebar();
  }
  const el = document.getElementById(`ng-${name}`);
  if (!el) return;
  const opening = !el.classList.contains('open');
  document.querySelectorAll('.nav-group').forEach(g => {
    g.classList.remove('open');
    _saveNavGroupState(g.id.replace('ng-', ''), false);
  });
  if (opening) {
    el.classList.add('open');
    _saveNavGroupState(name, true);
  }
}

function toggleSidebar() {
  const collapsed = document.body.classList.toggle('sidebar-collapsed');
  localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0');
  const btn = document.querySelector('.sidebar-toggle');
  if (btn) btn.textContent = collapsed ? '»' : '«';
}

function _restoreSidebarCollapsed() {
  if (localStorage.getItem('sidebarCollapsed') === '1') {
    document.body.classList.add('sidebar-collapsed');
    const btn = document.querySelector('.sidebar-toggle');
    if (btn) btn.textContent = '»';
  }
}

function _saveNavGroupState(name, open) {
  const state = JSON.parse(localStorage.getItem('navGroupState') || '{}');
  state[name] = open;
  localStorage.setItem('navGroupState', JSON.stringify(state));
}

function _restoreNavGroups() {
  const state = JSON.parse(localStorage.getItem('navGroupState') || '{}');
  ['accounts', 'compute', 'database', 'network', 'storage', 'billing', 'system'].forEach(name => {
    if (state[name]) document.getElementById(`ng-${name}`)?.classList.add('open');
  });
}
