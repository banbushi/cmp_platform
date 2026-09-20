// ─────────────────────────────────────────
// 账号列表（以账号为中心：展示所有同步/托管到本地的云端账号）
// ─────────────────────────────────────────
let _syncedAccCache = { cloud: [], tool: [] };
let _toolPlatformFilter = 'all';

async function loadAccounts() {
  const wrap = document.getElementById('accounts-table-wrap');
  if (wrap) wrap.innerHTML = '<div class="empty-tip">加载中…</div>';
  if (typeof loadSyncStatus === 'function') loadSyncStatus();  // 刷新顶部同步状态卡
  const r = await get('/accounts/synced-accounts?category=cloud');
  if (!r.ok) { if (wrap) wrap.innerHTML = `<div class="empty-tip">加载失败：${esc(r.data?.error || '')}</div>`; return; }
  _syncedAccCache.cloud = r.data.accounts || [];
  renderSyncedAccounts('cloud', 'accounts-table-wrap');
}

async function loadThirdAccounts() {
  const wrap = document.getElementById('third-accounts-table-wrap');
  if (wrap) wrap.innerHTML = '<div class="empty-tip">加载中…</div>';
  const r = await get('/accounts/synced-accounts?category=tool');
  if (!r.ok) { if (wrap) wrap.innerHTML = `<div class="empty-tip">加载失败：${esc(r.data?.error || '')}</div>`; return; }
  _syncedAccCache.tool = r.data.accounts || [];
  renderSyncedAccounts('tool', 'third-accounts-table-wrap');
}

const PLATFORM_LABEL_ALL = {
  aws: 'AWS', aliyun: '阿里云', baidu: '百度云',
  jumpserver: 'JumpServer', bytebase: 'Bytebase', kuboard: 'Kuboard',
  'grafana-aws': 'Grafana (AWS)', 'grafana-wuwen': 'Grafana (无问)', 'grafana-baidu': 'Grafana (百度)'
};

// 平台工具账号页的平台筛选 tab（全部 + 各三方平台）
const TOOL_FILTER_TABS = [
  { key: 'all', label: '全部' },
  { key: 'jumpserver', label: 'JumpServer' },
  { key: 'grafana', label: 'Grafana' },
  { key: 'kuboard', label: 'Kuboard' },
  { key: 'bytebase', label: 'Bytebase' },
];

function setToolPlatformFilter(key, wrapId) {
  _toolPlatformFilter = key;
  const kw = document.getElementById('synced-search-tool')?.value || '';
  renderSyncedAccounts('tool', wrapId, kw);
}

// 只重建结果区（计数 + 表格），不动搜索框，避免输入时中文输入法被打断
function filterSyncedAccounts(category, wrapId, keyword) {
  const cntEl  = document.getElementById(`synced-count-${category}`);
  const bodyEl = document.getElementById(`synced-results-${category}`);
  if (!bodyEl) return;

  let accounts = _syncedAccCache[category] || [];
  if (category === 'tool' && _toolPlatformFilter !== 'all') {
    accounts = accounts.filter(a =>
      _toolPlatformFilter === 'grafana'
        ? String(a.platform).startsWith('grafana')
        : a.platform === _toolPlatformFilter
    );
  }
  const kw = (keyword || '').toLowerCase().trim();
  if (kw) {
    accounts = accounts.filter(a =>
      (a.cloud_username || '').toLowerCase().includes(kw) ||
      (a.linked_user?.name || '').toLowerCase().includes(kw) ||
      (a.display_name || '').toLowerCase().includes(kw)
    );
  }

  if (cntEl) cntEl.textContent = `共 ${accounts.length} 个账号`;

  if (!accounts.length) {
    const isFiltered = kw || (category === 'tool' && _toolPlatformFilter !== 'all');
    bodyEl.innerHTML = `<div class="empty-tip">${isFiltered ? '没有符合条件的账号' : '暂无账号，请先到「账号同步」拉取'}</div>`;
    return;
  }
  bodyEl.innerHTML = buildSyncedAccountsTable(accounts, category);
}

function renderSyncedAccounts(category, wrapId, keyword) {
  const wrap = document.getElementById(wrapId);
  if (!wrap) return;

  // 平台筛选 tab 栏（仅平台工具账号页显示）
  const filterTabs = category === 'tool'
    ? `<div class="sync-filter-tabs" style="margin-bottom:12px">
        ${TOOL_FILTER_TABS.map(t => `<button class="filter-tab${_toolPlatformFilter === t.key ? ' active' : ''}" onclick="setToolPlatformFilter('${t.key}','${wrapId}')">${t.label}</button>`).join('')}
      </div>`
    : '';

  const searchBox = filterTabs + `<div style="margin-bottom:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span class="search-field" style="flex:1;min-width:220px">
      <input type="text" class="search-input" id="synced-search-${category}" placeholder="搜索云账号名 / 关联用户…" value="${esc(keyword || '')}"
        oninput="filterSyncedAccounts('${category}','${wrapId}',this.value)">
    </span>
    <span id="synced-count-${category}" style="font-size:12px;color:var(--g500)"></span>
  </div>`;

  // 搜索框 + 结果容器：后续输入只更新结果容器，输入框不重建
  wrap.innerHTML = searchBox + `<div id="synced-results-${category}"></div>`;
  filterSyncedAccounts(category, wrapId, keyword);
}

function buildSyncedAccountsTable(accounts, category) {
  const rowsHtml = accounts.map(a => {
    const pname = PLATFORM_LABEL_ALL[a.platform] || a.platform;
    const policies = Array.isArray(a.policies) ? a.policies : [];
    const groups = Array.isArray(a.groups) ? a.groups : [];
    const lu = a.linked_user;

    // 关联用户列
    const linkedHtml = lu
      ? `<a onclick="viewUserProfile('${lu.id}')" style="cursor:pointer;color:var(--primary);font-weight:600">${esc(lu.name)}</a>
         <div style="font-size:11px;color:var(--g400)">${esc(lu.email || '')}</div>`
      : `<span style="color:var(--g400);font-size:12px">未关联</span>`;

    // 状态列
    const statusHtml = a.is_managed
      ? (a.status === 'disabled'
          ? '<span class="badge" style="background:#fce4e4;color:#c62828;font-size:10px;padding:1px 7px;border-radius:10px">已禁用</span>'
          : '<span class="badge badge-ok" style="font-size:10px;padding:1px 7px;border-radius:10px">本平台创建</span>')
      : '<span class="badge" style="background:var(--g100);color:var(--g500);font-size:10px;padding:1px 7px;border-radius:10px">外部账号</span>';

    const policyHtml = policies.length
      ? `<div style="display:flex;flex-wrap:wrap;gap:3px">${policies.slice(0,4).map(p => {
          const short = String(p).replace(/^arn:[^:]+:iam::[^:]*:policy\//, '');
          return `<span style="font-size:10px;background:var(--g100);color:var(--g600);padding:1px 6px;border-radius:8px" title="${esc(p)}">${esc(short)}</span>`;
        }).join('')}${policies.length > 4 ? `<span style="font-size:10px;color:var(--g400)">+${policies.length-4}</span>` : ''}</div>`
      : '<span style="color:var(--g400);font-size:11px">无</span>';
    const groupHtml = groups.length
      ? `<div style="display:flex;flex-wrap:wrap;gap:3px">${groups.slice(0,3).map(g => `<span style="font-size:10px;background:#e3f2fd;color:#1565c0;padding:1px 6px;border-radius:8px">${esc(g)}</span>`).join('')}${groups.length > 3 ? `<span style="font-size:10px;color:var(--g400)">+${groups.length-3}</span>` : ''}</div>`
      : '<span style="color:var(--g400);font-size:11px">无</span>';

    // 操作列
    const uname = String(a.cloud_username).replace(/'/g, "\\'");
    let actions = '';
    if (lu && a.is_managed) {
      // 托管且已关联：走原有按用户 id 的操作
      actions = `<button class="btn-ghost btn-sm" onclick="showAccountDetail('${lu.id}')">详情</button>
        <button class="btn-ghost btn-sm" style="margin-left:4px" onclick="viewUserProfile('${lu.id}')">画像</button>`;
    }
    // 绑定/改绑（所有账号都可绑定或改绑）
    actions += `<button class="btn-ghost btn-sm" style="margin-left:4px" onclick="openBindDialog('${a.platform}','${uname}','${category}')">${lu ? '改绑' : '绑定用户'}</button>`;

    // 平台工具账号：按 平台+账号名 删除（关联对应平台删除远端用户）
    if (category === 'tool') {
      actions += `<button class="btn-ghost btn-sm" style="margin-left:4px;color:var(--danger,#dc2626)" onclick="deleteToolAccount('${a.platform}','${uname}')">删除</button>`;
    }

    return `<tr>
      <td style="white-space:nowrap"><span class="platform-badge platform-${a.platform}">${esc(pname)}</span></td>
      <td><code style="font-size:12px;background:var(--g100);padding:2px 6px;border-radius:4px;white-space:nowrap">${esc(a.cloud_username)}</code></td>
      <td style="white-space:nowrap">${linkedHtml}</td>
      <td style="min-width:180px">${policyHtml}</td>
      <td style="min-width:120px">${groupHtml}</td>
      <td style="white-space:nowrap">${statusHtml}</td>
      <td style="color:var(--g400);font-size:11.5px;white-space:nowrap">${a.synced_at ? String(a.synced_at).slice(0,16).replace('T',' ') : '-'}</td>
      <td style="white-space:nowrap;text-align:right">${actions}</td>
    </tr>`;
  }).join('');

  return `
    <div style="overflow-x:auto">
    <table class="acc-table acc-table-compact" style="min-width:1000px">
      <thead><tr>
        <th>平台</th><th>云账号名</th><th>关联用户</th><th>权限策略</th><th>用户组</th><th>来源/状态</th><th>同步时间</th><th style="text-align:right">操作</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    </div>`;
}

async function showAccountDetail(userId) {
  // 优先从全局缓存取；缓存没有则按 id 查（用 profile 接口，不受 /list 的 role 过滤影响，
  // 否则绑定到 admin/viewer/operator 的账号点详情会静默失败）
  let user = (allUsers || []).find(u => u.id === userId);
  if (!user) {
    const pr = await get(`/accounts/${userId}/profile`);
    if (pr.ok && pr.data?.user) {
      user = pr.data.user;
    } else {
      toast('无法加载该账号详情', 'err');
      return;
    }
  }

  const cr = await get(`/accounts/${userId}/cloud`);
  const allClouds = cr.ok ? cr.data.cloud_accounts : [];
  // 只显示 IAM 平台账号（aws/aliyun/baidu），过滤掉平台工具账号
  const IAM_PLATFORMS = ['aws', 'aliyun', 'baidu'];
  const clouds = allClouds.filter(c => IAM_PLATFORMS.includes(c.platform));

  document.getElementById('modal-title').textContent = `${user.name} 的账号详情`;
  document.getElementById('modal-body').innerHTML = `
    <div class="review-section">
      <div class="review-label">基本信息</div>
      <div class="review-info-grid">
        <div class="review-info-item"><div class="review-info-key">姓名</div><div class="review-info-val">${esc(user.name)}</div></div>
        <div class="review-info-item"><div class="review-info-key">邮箱</div><div class="review-info-val">${esc(user.email)}</div></div>
        <div class="review-info-item"><div class="review-info-key">部门</div><div class="review-info-val">${esc(user.department || '-')}</div></div>
        <div class="review-info-item"><div class="review-info-key">角色</div><div class="review-info-val">${PROLES[user.role] || user.role}</div></div>
        ${user.notes ? `<div class="review-info-item" style="grid-column:1/-1"><div class="review-info-key">备注</div><div class="review-info-val">${esc(user.notes)}</div></div>` : ''}
      </div>
    </div>
    ${clouds.length ? `
    <div class="review-section">
      <div class="review-label">云平台账号</div>
      ${clouds.map(c => {
        const policies = Array.isArray(c.policies) ? c.policies : JSON.parse(c.policies || '[]');
        const isIam = ['aws', 'aliyun', 'baidu'].includes(c.platform);
        const isDisabled = c.status === 'disabled';
        const escapedName = esc(user.name).replace(/'/g, "\\'");
        return `<div class="review-cloud-item" id="cloud-item-${c.platform}" style="${isDisabled ? 'opacity:.7' : ''}">
          <div class="review-cloud-header">
            <div class="review-mini-logo ${c.platform === 'aws' ? 'aws-bg' : c.platform === 'aliyun' ? 'ali-bg' : c.platform === 'bytebase' ? 'bb-bg' : c.platform === 'jumpserver' || c.platform === 'kuboard' ? '' : 'bai-bg'}" ${c.platform === 'jumpserver' ? 'style="background:#e65c00;color:#fff"' : c.platform === 'kuboard' ? 'style="background:#0052cc;color:#fff"' : ''}>${{aws:'AWS',aliyun:'阿里',baidu:'百度',bytebase:'BB',jumpserver:'JS',kuboard:'KB'}[c.platform]||c.platform}</div>
            <div class="review-cloud-name">${PNAMES[c.platform]}</div>
            ${isDisabled ? `<span class="badge" style="background:#fce4e4;color:#c62828;font-size:10px;padding:1px 7px;border-radius:10px;margin-left:6px">已禁用 AK/SK</span>` : ''}
            ${isIam ? `
            <button class="btn-ghost btn-xs" style="margin-left:auto" onclick="toggleCloudStatus('${userId}','${c.platform}','${isDisabled ? 'active' : 'disabled'}','${escapedName}')">${isDisabled ? '启用AK/SK' : '禁用AK/SK'}</button>
            ${c.platform === 'baidu' ? `<button class="btn-ghost btn-xs" style="margin-left:4px" onclick="toggleConsoleLogin('${userId}','${c.platform}','${escapedName}',${c.console_disabled ? 'true' : 'false'})">${c.console_disabled ? '启用控制台' : '禁控制台'}</button>` : ''}
            <button class="btn-danger btn-xs" style="margin-left:4px" onclick="deleteCloudAccount('${userId}','${c.platform}','${escapedName}')">删除</button>
            ` : ''}
          </div>
          <div style="font-size:12.5px;color:var(--g600);margin-bottom:8px">子账号：${esc(c.cloud_username)}</div>
          ${c.cloud_access_key ? `<div class="cred-box"><span>Access Key: ${esc(c.cloud_access_key)}</span><span>Secret Key: ${esc(c.cloud_secret_key)}</span></div>` : ''}
          <div class="policy-tags" style="margin-top:8px">${policies.map(p => `<span class="policy-tag">${esc(p)}</span>`).join('') || '<span style="color:var(--g400);font-size:12px">无策略</span>'}</div>
        </div>`;
      }).join('')}
    </div>` : '<div style="color:var(--g400);font-size:13.5px">未关联任何云平台账号</div>'}`;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

async function toggleCloudStatus(userId, platform, newStatus, userName) {
  const label = newStatus === 'disabled' ? '禁用' : '启用';
  const pname = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' }[platform] || platform;
  if (!confirm(`确认${label}「${userName}」的 ${pname} 子账号？`)) return;
  const r = await patch(`/accounts/${userId}/cloud/${platform}/status`, { status: newStatus });
  if (r.ok) {
    if (r.data?.cloud_warning) {
      toast(`${pname} 本地已${label}，但云端操作失败：${r.data.cloud_warning}`, 'warn');
    } else {
      toast(`${pname} 账号已${label}`, 'ok');
    }
    showAccountDetail(userId);
  } else {
    toast(r.data?.error || `${label}失败`, 'err');
  }
}

async function toggleConsoleLogin(userId, platform, userName, isDisabled) {
  const pname = { baidu: '百度云' }[platform] || platform;
  if (isDisabled) {
    // 当前已禁用 → 启用，需要输入密码
    const password = prompt(`启用「${userName}」的 ${pname} 控制台登录\n请输入控制台密码（留空则使用原密码）：`);
    if (password === null) return; // 点了取消
    const r = await patch(`/accounts/${userId}/cloud/${platform}/console`, { enabled: true, ...(password ? { password } : {}) });
    if (r.ok) {
      if (r.data?.cloud_warning) {
        toast(`控制台启用：${r.data.cloud_warning}`, 'warn');
      } else {
        toast(`${pname} 控制台已启用`, 'ok');
      }
      showAccountDetail(userId);
    } else {
      toast(r.data?.error || '启用失败', 'err');
    }
  } else {
    // 当前已启用 → 禁用
    if (!confirm(`确认禁用「${userName}」的 ${pname} 控制台登录？`)) return;
    const r = await patch(`/accounts/${userId}/cloud/${platform}/console`, { enabled: false });
    if (r.ok) {
      if (r.data?.cloud_warning) {
        toast(`控制台禁用：${r.data.cloud_warning}`, 'warn');
      } else {
        toast(`${pname} 控制台已禁用`, 'ok');
      }
      showAccountDetail(userId);
    } else {
      toast(r.data?.error || '禁用失败', 'err');
    }
  }
}

async function deleteCloudAccount(userId, platform, userName) {
  const pname = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' }[platform] || platform;
  if (!confirm(`确认删除「${userName}」在 ${pname} 上的子账号？\n此操作将同步删除云端 IAM 账号。`)) return;

  // 禁用按钮防止重复点击
  const btn = event?.target;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '删除中...';
  }

  const r = await del(`/accounts/${userId}/cloud/${platform}`);
  if (r.ok) {
    if (r.data?.cloud_warning) {
      toast(`${pname} 本地已删除，但云端操作失败：${r.data.cloud_warning}`, 'warn');
    } else {
      toast(`${pname} 账号已删除`, 'ok');
    }
    showAccountDetail(userId);
    loadAccounts();
  } else {
    toast(r.data?.error || '删除失败', 'err');
    if (btn) {
      btn.disabled = false;
      btn.textContent = '删除';
    }
  }
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

// 绑定/改绑 同步账号到本地用户
let _bindCtx = null;
async function openBindDialog(platform, cloudUsername, category) {
  _bindCtx = { platform, cloudUsername, category };
  const pname = PLATFORM_LABEL_ALL[platform] || platform;
  // 加载本地用户列表
  const r = await get('/accounts/list');
  const users = r.ok ? (r.data.users || []) : [];
  const options = users.map(u => `<option value="${u.id}">${esc(u.name)}（${esc(u.email)}）</option>`).join('');

  document.getElementById('modal-title').textContent = '绑定账号到用户';
  document.getElementById('modal-body').innerHTML = `
    <div style="font-size:13px;color:var(--g600);margin-bottom:14px">
      将 <span class="platform-badge platform-${platform}">${esc(pname)}</span>
      账号 <code style="background:var(--g100);padding:2px 6px;border-radius:4px">${esc(cloudUsername)}</code> 关联到本地用户，关联后可在其资源画像中体现。
    </div>
    <div class="field">
      <label style="font-size:12px;margin-bottom:4px;display:block">选择用户</label>
      <select id="bind-user-select" style="width:100%">
        <option value="">请选择用户</option>
        ${options}
      </select>
    </div>
    <div style="display:flex;gap:8px;margin-top:18px;justify-content:flex-end">
      <button class="btn-ghost btn-sm" onclick="submitBind(true)">解除关联</button>
      <button class="btn-primary btn-sm" onclick="submitBind(false)">确认绑定</button>
    </div>`;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

async function submitBind(unbind) {
  if (!_bindCtx) return;
  const { platform, cloudUsername, category } = _bindCtx;
  const userId = unbind ? null : (document.getElementById('bind-user-select')?.value || '');
  if (!unbind && !userId) { toast('请选择要绑定的用户', 'warn'); return; }

  const r = await post('/accounts/synced/bind', { platform, cloud_username: cloudUsername, user_id: userId || null });
  if (r.ok) {
    toast(unbind ? '已解除关联' : '绑定成功', 'ok');
    closeModal();
    // 重新加载当前分类页
    if (category === 'tool') loadThirdAccounts(); else loadAccounts();
  } else {
    toast(r.data?.error || '操作失败', 'err');
  }
}

async function deleteAccount(id, name) {
  if (!confirm(`确认删除账号「${name}」？\n同时会删除该账号在 AWS / 阿里云 / 百度 上的 IAM/RAM 子账号。`)) return;
  const r = await del(`/accounts/${id}`);
  if (r.ok) {
    const results = r.data.cloud_results || [];
    if (results.length) {
      const lines = results.map(cr => {
        const pname = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' }[cr.platform] || cr.platform;
        return `${cr.success ? '✓' : '✗'} ${pname}：${cr.message}`;
      }).join('\n');
      alert(`账号已删除\n\n云端同步结果：\n${lines}`);
    } else {
      toast('账号已删除', 'ok');
    }
    loadAccounts();
  } else {
    toast(r.data.error || '删除失败', 'err');
  }
}

// ─────────────────────────────────────────
// 平台工具账号列表
// ─────────────────────────────────────────
const THIRD_PLATFORMS = ['bytebase', 'jumpserver', 'kuboard', 'grafana-aws', 'grafana-wuwen', 'grafana-baidu'];
const THIRD_PLATFORM_NAMES = {
  bytebase: 'Bytebase',
  jumpserver: 'JumpServer',
  kuboard: 'Kuboard',
  'grafana-aws': 'Grafana (AWS)',
  'grafana-wuwen': 'Grafana (无问)',
  'grafana-baidu': 'Grafana (百度)'
};

async function showThirdAccountDetail(userId) {
  let user = (allUsers || []).find(u => u.id === userId);
  if (!user) {
    const r = await get('/accounts/list');
    if (!r.ok) return;
    allUsers = r.data.users;
    user = allUsers.find(u => u.id === userId);
    if (!user) return;
  }

  const cr = await get(`/accounts/${userId}/cloud`);
  const clouds = cr.ok ? cr.data.cloud_accounts : [];
  const thirdClouds = clouds.filter(c => THIRD_PLATFORMS.includes(c.platform));

  document.getElementById('modal-title').textContent = `${user.name} 的平台工具账号详情`;
  document.getElementById('modal-body').innerHTML = `
    <div class="review-section">
      <div class="review-label">基本信息</div>
      <div class="review-info-grid">
        <div class="review-info-item"><div class="review-info-key">姓名</div><div class="review-info-val">${esc(user.name)}</div></div>
        <div class="review-info-item"><div class="review-info-key">邮箱</div><div class="review-info-val">${esc(user.email)}</div></div>
        <div class="review-info-item"><div class="review-info-key">部门</div><div class="review-info-val">${esc(user.department || '-')}</div></div>
        <div class="review-info-item"><div class="review-info-key">角色</div><div class="review-info-val">${PROLES[user.role] || user.role}</div></div>
        ${user.notes ? `<div class="review-info-item" style="grid-column:1/-1"><div class="review-info-key">备注</div><div class="review-info-val">${esc(user.notes)}</div></div>` : ''}
      </div>
    </div>
    ${thirdClouds.length ? `
    <div class="review-section">
      <div class="review-label">三方平台账号</div>
      ${thirdClouds.map(c => {
        const statusColor = c.status === 'active' ? 'var(--success)' : c.status === 'failed' ? 'var(--error)' : 'var(--warn)';
        const statusText = { active: '已开通', failed: '开通失败', pending: '待创建' }[c.status] || c.status;
        const escapedName = esc(user.name).replace(/'/g, "\\'");
        return `<div class="review-cloud-item">
          <div class="review-cloud-header">
            <div class="review-mini-logo ${c.platform === 'bytebase' ? 'bb-bg' : ''}" ${c.platform === 'jumpserver' ? 'style="background:#e65c00;color:#fff"' : c.platform === 'kuboard' ? 'style="background:#0052cc;color:#fff"' : ''}>${{bytebase:'BB',jumpserver:'JS',kuboard:'KB'}[c.platform]||c.platform}</div>
            <div class="review-cloud-name">${PNAMES[c.platform] || c.platform}</div>
            <span style="margin-left:auto;font-size:12px;font-weight:600;color:${statusColor}">${statusText}</span>
            <button class="btn-danger btn-xs" style="margin-left:10px" onclick="deleteThirdAccount('${userId}','${c.platform}','${escapedName}')">删除</button>
          </div>
          <div style="font-size:12.5px;color:var(--g600)">账号：${esc(c.cloud_username)}</div>
        </div>`;
      }).join('')}
    </div>` : '<div style="color:var(--g400);font-size:13.5px">未开通任何三方平台账号</div>'}`;
  document.getElementById('modal-overlay').classList.remove('hidden');
}

async function deleteThirdAccount(userId, platform, userName) {
  const pname = THIRD_PLATFORM_NAMES[platform] || platform;
  if (!confirm(`确认删除「${userName}」的 ${pname} 账号？\n此操作将同步删除远端账号。`)) return;
  const r = await del(`/accounts/${userId}/cloud/${platform}`);
  if (r.ok) {
    toast(`${pname} 账号已删除`, 'ok');
    showThirdAccountDetail(userId);
    loadThirdAccounts();
  } else {
    toast(r.data?.error || '删除失败', 'err');
  }
}

// 平台工具账号列表：按 平台+账号名 删除（关联对应平台删除远端用户）
async function deleteToolAccount(platform, username) {
  const pname = PLATFORM_LABEL_ALL[platform] || platform;
  const MANUAL = ['grafana-aws', 'grafana-wuwen', 'grafana-baidu'];
  const extra = MANUAL.includes(platform)
    ? `\n注意：${pname} 不支持接口删除，将只清理本地记录，远端账号需到控制台手动删除。`
    : `\n此操作将同步删除 ${pname} 远端账号。`;
  if (!confirm(`确认删除 ${pname} 账号「${username}」？${extra}`)) return;

  const r = await del(`/accounts/tool-account/${platform}/${encodeURIComponent(username)}`);
  if (r.ok) {
    toast(r.data?.cloud_warning ? `已删除本地记录（${r.data.cloud_warning}）` : `${pname} 账号已删除`, r.data?.cloud_warning ? 'info' : 'ok');
    loadThirdAccounts();
  } else {
    toast(r.data?.error || '删除失败', 'err');
  }
}

// ── 创建 JumpServer 用户（远端创建 + 自动生成密码 + 可选绑定本地用户）──
async function showCreateJsUserModal() {
  let modal = document.getElementById('modal-create-js-user');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-create-js-user';
    modal.className = 'modal-overlay hidden';
    modal.onclick = () => modal.classList.add('hidden');
    modal.innerHTML = `<div class="modal" style="width:460px;max-width:95vw" onclick="event.stopPropagation()">
      <div class="modal-header"><h3>创建 JumpServer 用户</h3><button class="modal-close" onclick="document.getElementById('modal-create-js-user').classList.add('hidden')">✕</button></div>
      <div style="padding:20px 24px;display:flex;flex-direction:column;gap:14px">
        <div class="field"><label>用户名 <span class="req">*</span></label><input type="text" id="cju-username" placeholder="如 zhangsan" style="margin-top:6px"></div>
        <div class="field"><label>姓名</label><input type="text" id="cju-name" placeholder="留空则用用户名" style="margin-top:6px"></div>
        <div class="field"><label>邮箱 <span class="req">*</span></label><input type="email" id="cju-email" placeholder="如 zhangsan@company.com" style="margin-top:6px"></div>
        <div class="field"><label>绑定本地用户（可选）</label>
          <select id="cju-local-user" style="margin-top:6px"><option value="">不绑定</option></select>
          <div style="font-size:11.5px;color:var(--g400);margin-top:4px">绑定后可在该用户资源画像中体现</div>
        </div>
        <div style="font-size:12px;color:var(--g500)">密码由系统自动生成，创建成功后会展示一次，请及时保存。</div>
        <div id="cju-err" class="err-text"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn-ghost" onclick="document.getElementById('modal-create-js-user').classList.add('hidden')">取消</button>
          <button class="btn-primary" id="cju-submit" onclick="submitCreateJsUser()">创建</button>
        </div>
      </div></div>`;
    document.body.appendChild(modal);
  }
  document.getElementById('cju-username').value = '';
  document.getElementById('cju-name').value = '';
  document.getElementById('cju-email').value = '';
  document.getElementById('cju-err').textContent = '';
  modal.classList.remove('hidden');

  // 加载本地用户供绑定
  const sel = document.getElementById('cju-local-user');
  const r = await get('/accounts/list');
  if (r.ok && r.data.users) {
    sel.innerHTML = '<option value="">不绑定</option>' +
      r.data.users.map(u => `<option value="${u.id}">${esc(u.name)}（${esc(u.email)}）</option>`).join('');
  }
}

async function submitCreateJsUser() {
  const errEl = document.getElementById('cju-err');
  errEl.textContent = '';
  const username = document.getElementById('cju-username').value.trim();
  const name = document.getElementById('cju-name').value.trim();
  const email = document.getElementById('cju-email').value.trim();
  const local_user_id = document.getElementById('cju-local-user').value || null;
  if (!username) { errEl.textContent = '请填写用户名'; return; }
  if (!email) { errEl.textContent = '请填写邮箱'; return; }

  const btn = document.getElementById('cju-submit');
  btn.disabled = true; btn.textContent = '创建中...';
  const r = await post('/accounts/jumpserver-user', { username, name, email, local_user_id });
  btn.disabled = false; btn.textContent = '创建';
  if (!r.ok) { errEl.textContent = r.data?.error || '创建失败'; return; }

  document.getElementById('modal-create-js-user').classList.add('hidden');
  // 展示一次性密码（带一键复制）
  showCredResultModal('JumpServer 用户创建成功', [
    { label: '用户名', value: r.data.username },
    { label: '初始密码', value: r.data.password, copy: true },
  ]);
  loadThirdAccounts();
}

// ── 创建 Bytebase 用户（选实例 + 邮箱 + 自动生成密码 + 可选绑定本地用户）──
async function showCreateBbUserModal() {
  let modal = document.getElementById('modal-create-bb-user');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-create-bb-user';
    modal.className = 'modal-overlay hidden';
    modal.onclick = () => modal.classList.add('hidden');
    modal.innerHTML = `<div class="modal" style="width:460px;max-width:95vw" onclick="event.stopPropagation()">
      <div class="modal-header"><h3>创建 Bytebase 用户</h3><button class="modal-close" onclick="document.getElementById('modal-create-bb-user').classList.add('hidden')">✕</button></div>
      <div style="padding:20px 24px;display:flex;flex-direction:column;gap:14px">
        <div class="field"><label>Bytebase 实例 <span class="req">*</span></label>
          <select id="cbu-instance" style="margin-top:6px"><option value="">加载中...</option></select>
        </div>
        <div class="field"><label>邮箱 <span class="req">*</span></label><input type="email" id="cbu-email" placeholder="如 zhangsan@company.com" style="margin-top:6px"></div>
        <div class="field"><label>姓名</label><input type="text" id="cbu-name" placeholder="留空则用邮箱前缀" style="margin-top:6px"></div>
        <div class="field"><label>绑定本地用户（可选）</label>
          <input type="text" id="cbu-local-user-search" list="cbu-local-user-list" placeholder="输入姓名/邮箱搜索，留空=不绑定" autocomplete="off" style="margin-top:6px" oninput="_cbuOnUserInput()">
          <datalist id="cbu-local-user-list"></datalist>
          <input type="hidden" id="cbu-local-user">
          <div style="font-size:11.5px;color:var(--g400);margin-top:4px">绑定后可在该用户资源画像中体现</div>
        </div>
        <div style="font-size:12px;color:var(--g500)">密码由系统自动生成，创建成功后会展示一次，请及时保存。</div>
        <div id="cbu-err" class="err-text"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn-ghost" onclick="document.getElementById('modal-create-bb-user').classList.add('hidden')">取消</button>
          <button class="btn-primary" id="cbu-submit" onclick="submitCreateBbUser()">创建</button>
        </div>
      </div></div>`;
    document.body.appendChild(modal);
  }
  document.getElementById('cbu-email').value = '';
  document.getElementById('cbu-name').value = '';
  document.getElementById('cbu-local-user-search').value = '';
  document.getElementById('cbu-local-user').value = '';
  document.getElementById('cbu-err').textContent = '';
  modal.classList.remove('hidden');

  // 加载启用的 Bytebase 实例
  const instSel = document.getElementById('cbu-instance');
  const ir = await get('/bytebase/instances?enabledOnly=1');
  const insts = (ir.ok && ir.data.instances) ? ir.data.instances : [];
  instSel.innerHTML = insts.length
    ? insts.map(i => `<option value="${i.id}">${esc(i.name)}（${esc(i.base_url)}）</option>`).join('')
    : '<option value="">（暂无可用实例，请先在接入集成中配置）</option>';

  // 加载本地用户供绑定（缓存到 _cbuUsers，datalist 搜索用；option 文本形如 "姓名 (邮箱)"）
  const r = await get('/accounts/list');
  _cbuUsers = (r.ok && r.data.users) ? r.data.users : [];
  const dl = document.getElementById('cbu-local-user-list');
  dl.innerHTML = _cbuUsers.map(u => `<option value="${esc(u.name)} (${esc(u.email)})"></option>`).join('');
}

// datalist 输入时把「姓名 (邮箱)」解析回 user id 存进隐藏域
let _cbuUsers = [];
function _cbuOnUserInput() {
  const val = document.getElementById('cbu-local-user-search').value.trim();
  const hidden = document.getElementById('cbu-local-user');
  if (!val) { hidden.value = ''; return; }
  // 精确匹配 "姓名 (邮箱)"，其次按邮箱/姓名唯一匹配
  const label = u => `${u.name} (${u.email})`;
  let hit = _cbuUsers.find(u => label(u) === val)
         || _cbuUsers.find(u => u.email === val)
         || _cbuUsers.find(u => u.name === val);
  hidden.value = hit ? hit.id : '';
}

async function submitCreateBbUser() {
  const errEl = document.getElementById('cbu-err');
  errEl.textContent = '';
  const instance_id = document.getElementById('cbu-instance').value;
  const email = document.getElementById('cbu-email').value.trim();
  const name = document.getElementById('cbu-name').value.trim();
  const searchVal = document.getElementById('cbu-local-user-search').value.trim();
  const local_user_id = document.getElementById('cbu-local-user').value || null;
  if (!instance_id) { errEl.textContent = '请选择 Bytebase 实例'; return; }
  if (!email) { errEl.textContent = '请填写邮箱'; return; }
  // 填了搜索框但没匹配到用户：提示（避免误以为已绑定）
  if (searchVal && !local_user_id) { errEl.textContent = '未匹配到该本地用户，请从建议列表中选择，或留空不绑定'; return; }

  const btn = document.getElementById('cbu-submit');
  btn.disabled = true; btn.textContent = '创建中...';
  const r = await post('/accounts/bytebase-user', { instance_id, email, name, local_user_id });
  btn.disabled = false; btn.textContent = '创建';
  if (!r.ok) { errEl.textContent = r.data?.error || '创建失败'; return; }

  document.getElementById('modal-create-bb-user').classList.add('hidden');
  showCredResultModal('Bytebase 用户创建成功', [
    { label: '邮箱', value: r.data.email },
    { label: '初始密码', value: r.data.password, copy: true },
  ]);
  loadThirdAccounts();
}

// ── 平台工具账号页顶部「创建/同步」下拉菜单开合（复用 .action-menu 全局关闭逻辑）──
function toggleThirdMenu(e, menuId) {
  e.stopPropagation();
  document.querySelectorAll('.action-menu.show').forEach(m => {
    if (m.id !== menuId) m.classList.remove('show');
  });
  document.getElementById(menuId)?.classList.toggle('show');
}

// ── 创建 Kuboard 用户（远端创建 + 自动生成密码 + 可选绑定本地用户）──
async function showCreateKbUserModal() {
  let modal = document.getElementById('modal-create-kb-user');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-create-kb-user';
    modal.className = 'modal-overlay hidden';
    modal.onclick = () => modal.classList.add('hidden');
    modal.innerHTML = `<div class="modal" style="width:460px;max-width:95vw" onclick="event.stopPropagation()">
      <div class="modal-header"><h3>创建 Kuboard 用户</h3><button class="modal-close" onclick="document.getElementById('modal-create-kb-user').classList.add('hidden')">✕</button></div>
      <div style="padding:20px 24px;display:flex;flex-direction:column;gap:14px">
        <div class="field"><label>用户名 <span class="req">*</span></label><input type="text" id="cku-username" placeholder="如 zhangsan" style="margin-top:6px"></div>
        <div class="field"><label>姓名</label><input type="text" id="cku-name" placeholder="留空则用用户名" style="margin-top:6px"></div>
        <div class="field"><label>邮箱</label><input type="email" id="cku-email" placeholder="可选，如 zhangsan@company.com" style="margin-top:6px"></div>
        <div class="field"><label>绑定本地用户（可选）</label>
          <select id="cku-local-user" style="margin-top:6px"><option value="">不绑定</option></select>
          <div style="font-size:11.5px;color:var(--g400);margin-top:4px">绑定后可在该用户资源画像中体现</div>
        </div>
        <div style="font-size:12px;color:var(--g500)">密码由系统自动生成，创建成功后会展示一次，请及时保存。</div>
        <div id="cku-err" class="err-text"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn-ghost" onclick="document.getElementById('modal-create-kb-user').classList.add('hidden')">取消</button>
          <button class="btn-primary" id="cku-submit" onclick="submitCreateKbUser()">创建</button>
        </div>
      </div></div>`;
    document.body.appendChild(modal);
  }
  document.getElementById('cku-username').value = '';
  document.getElementById('cku-name').value = '';
  document.getElementById('cku-email').value = '';
  document.getElementById('cku-err').textContent = '';
  modal.classList.remove('hidden');

  // 加载本地用户供绑定
  const sel = document.getElementById('cku-local-user');
  const r = await get('/accounts/list');
  if (r.ok && r.data.users) {
    sel.innerHTML = '<option value="">不绑定</option>' +
      r.data.users.map(u => `<option value="${u.id}">${esc(u.name)}（${esc(u.email)}）</option>`).join('');
  }
}

async function submitCreateKbUser() {
  const errEl = document.getElementById('cku-err');
  errEl.textContent = '';
  const username = document.getElementById('cku-username').value.trim();
  const name = document.getElementById('cku-name').value.trim();
  const email = document.getElementById('cku-email').value.trim();
  const local_user_id = document.getElementById('cku-local-user').value || null;
  if (!username) { errEl.textContent = '请填写用户名'; return; }

  const btn = document.getElementById('cku-submit');
  btn.disabled = true; btn.textContent = '创建中...';
  const r = await post('/accounts/kuboard-user', { username, name, email, local_user_id });
  btn.disabled = false; btn.textContent = '创建';
  if (!r.ok) { errEl.textContent = r.data?.error || '创建失败'; return; }

  document.getElementById('modal-create-kb-user').classList.add('hidden');
  showCredResultModal('Kuboard 用户创建成功', [
    { label: '用户名', value: r.data.username },
    { label: '初始密码', value: r.data.password, copy: true },
  ]);
  loadThirdAccounts();
}

// 通用：展示创建结果（邮箱/密码等），密码等敏感值带一键复制。仅展示一次
function showCredResultModal(title, rows) {
  let modal = document.getElementById('modal-cred-result');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-cred-result';
    modal.className = 'modal-overlay hidden';
    modal.onclick = () => modal.classList.add('hidden');
    modal.innerHTML = `<div class="modal" style="width:440px;max-width:95vw" onclick="event.stopPropagation()">
      <div class="modal-header"><h3 id="crm-title">创建成功</h3><button class="modal-close" onclick="document.getElementById('modal-cred-result').classList.add('hidden')">✕</button></div>
      <div style="padding:20px 24px">
        <div id="crm-rows" style="display:flex;flex-direction:column;gap:12px"></div>
        <div style="font-size:12px;color:var(--warn);margin-top:14px">⚠ 密码仅展示一次，请及时复制保存。</div>
        <div style="display:flex;justify-content:flex-end;margin-top:16px">
          <button class="btn-primary" onclick="document.getElementById('modal-cred-result').classList.add('hidden')">我已保存</button>
        </div>
      </div></div>`;
    document.body.appendChild(modal);
  }
  document.getElementById('crm-title').textContent = title;
  document.getElementById('crm-rows').innerHTML = rows.map((row, i) => `
    <div class="field">
      <label>${esc(row.label)}</label>
      <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
        <input type="text" id="crm-val-${i}" value="${esc(row.value)}" readonly
          style="flex:1;font-family:monospace;background:var(--g50,#f9fafb)">
        ${row.copy ? `<button class="btn-ghost btn-sm" onclick="_crmCopy(${i}, this)">复制</button>` : ''}
      </div>
    </div>`).join('');
  modal.classList.remove('hidden');
}

async function _crmCopy(i, btn) {
  const el = document.getElementById(`crm-val-${i}`);
  const text = el ? el.value : '';
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 降级：选中 + execCommand
    if (el) { el.removeAttribute('readonly'); el.select(); document.execCommand('copy'); el.setAttribute('readonly', ''); }
  }
  const old = btn.textContent;
  btn.textContent = '已复制';
  setTimeout(() => { btn.textContent = old; }, 1500);
}

// ─────────────────────────────────────────
// 创建账号向导
