// ─────────────────────────────────────────
// 创建账号向导
// ─────────────────────────────────────────
async function initCreate() {
  currentStep = 1;
  selectedPlatforms = new Set();
  // 加载权限策略
  const r = await get('/cloud/policies');
  if (r.ok) POLICIES = r.data.policies;
  // 加载凭据状态（用于显示提示）
  const cr = await get('/cloud/credentials');
  credStatus = {};
  if (cr.ok) cr.data.credentials.forEach(c => credStatus[c.platform] = true);
  // 加载已同步用户组（用于创建时选择分配的组）
  const gr = await get('/sync/groups');
  syncedGroupsData = {};
  if (gr.ok) {
    for (const g of gr.data.groups) {
      if (!syncedGroupsData[g.platform]) syncedGroupsData[g.platform] = [];
      syncedGroupsData[g.platform].push(g);
    }
  }

  // 重置表单
  ['c-name','c-email','c-password','c-dept'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  document.getElementById('c-notes').value = '';
  ['aws','aliyun','baidu','jumpserver'].forEach(p => {
    const chk = document.getElementById(`chk-${p}`);
    if (chk) chk.checked = false;
    const badge = document.getElementById(`badge-${p}`);
    if (badge) { badge.textContent = credStatus[p] ? '' : '未配置凭据'; badge.style.color = credStatus[p] ? '' : 'var(--warn)'; }
  });
  document.getElementById('step1-err').textContent = '';
  document.getElementById('create-result').classList.add('hidden');
  document.getElementById('confirm-actions').classList.remove('hidden');

  renderSteps();
  showStep(1);
}

function goStep(n) {
  if (n > currentStep) {
    if (!validateStep(currentStep)) return;
  }
  if (n === 3) renderPolicyPanels();
  if (n === 4) renderReview();
  currentStep = n;
  renderSteps();
  showStep(n);
}

function validateStep(step) {
  if (step === 1) {
    const name = document.getElementById('c-name').value.trim();
    const email = document.getElementById('c-email').value.trim();
    const pw = document.getElementById('c-password').value;
    const err = document.getElementById('step1-err');
    if (!name) { err.textContent = '请填写姓名'; return false; }
    if (!email || !/\S+@\S+\.\S+/.test(email)) { err.textContent = '请填写有效邮箱'; return false; }
    const pwErr = checkPassword(pw);
    if (pwErr) { err.textContent = pwErr; return false; }
    err.textContent = '';
  }
  return true;
}

function showStep(n) {
  [1,2,3,4].forEach(i => document.getElementById(`step-${i}`).classList.toggle('hidden', i !== n));
}

function renderSteps() {
  for (let i = 1; i <= 4; i++) {
    const dot = document.getElementById(`step-dot-${i}`);
    dot.className = 'step' + (i < currentStep ? ' done' : i === currentStep ? ' active' : '');
  }
}

function onPlatformChange() {
  selectedPlatforms = new Set();
  ['aws','aliyun','baidu','jumpserver'].forEach(p => {
    const el = document.getElementById(`chk-${p}`);
    if (el && el.checked) selectedPlatforms.add(p);
  });
}

function renderPolicyPanels() {
  const container = document.getElementById('policy-panels');
  const noMsg = document.getElementById('no-platform-msg');

  if (!selectedPlatforms.size) {
    container.innerHTML = '';
    noMsg.classList.remove('hidden');
    return;
  }
  noMsg.classList.add('hidden');

  // 初始化每个平台的分页状态
  [...selectedPlatforms].forEach(p => {
    policyState[p] = { items: (POLICIES[p] || []).map(pol => ({...pol})), page: 1, pageSize: 10, query: '' };
    checkedPolicies[p] = new Set();
  });

  container.innerHTML = [...selectedPlatforms].map(p => {
    const logoClass = { aws: 'aws-bg', aliyun: 'ali-bg', baidu: 'bai-bg', bytebase: 'bb-bg' }[p];
    const logoStyle = p === 'jumpserver' ? 'style="background:#e65c00;color:#fff"' : '';
    const shortName = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云', bytebase: 'BB', jumpserver: 'JS' }[p];

    // Bytebase / JumpServer 不需要策略选择和组选择，简化为仅显示账号信息
    if (p === 'bytebase') {
      return `
    <div class="policy-panel">
      <div class="policy-panel-header">
        <div class="panel-logo ${logoClass}">${shortName}</div>
        <div>
          <div style="font-size:15px;font-weight:700">${PNAMES[p]}</div>
          <div style="font-size:12px;color:var(--g400)">数据库 DevOps 平台，创建后分配项目 Developer 角色</div>
        </div>
        ${!credStatus[p] ? `<div style="margin-left:auto;font-size:12px;color:var(--warn);font-weight:600">⚠ 未配置凭据</div>` : ''}
      </div>
      <div class="policy-body">
        <div style="padding:20px 16px;color:var(--g500);font-size:13px;text-align:center">
          Bytebase 账号创建时自动分配 <strong>workspace.projectDeveloper</strong> 角色<br>
          管理员可在 Bytebase 控制台中调整成员角色
        </div>
      </div>
    </div>`;
    }

    if (p === 'jumpserver') {
      return `
    <div class="policy-panel">
      <div class="policy-panel-header">
        <div class="panel-logo" ${logoStyle}>${shortName}</div>
        <div>
          <div style="font-size:15px;font-weight:700">${PNAMES[p]}</div>
          <div style="font-size:12px;color:var(--g400)">堡垒机平台，创建后可在 JumpServer 控制台分配资产权限</div>
        </div>
        ${!credStatus[p] ? `<div style="margin-left:auto;font-size:12px;color:var(--warn);font-weight:600">⚠ 未配置凭据</div>` : ''}
      </div>
      <div class="policy-body">
        <div style="padding:20px 16px;color:var(--g500);font-size:13px;text-align:center">
          JumpServer 账号创建后为普通用户，<br>
          管理员可在 JumpServer 控制台中分配资产和授权规则
        </div>
      </div>
    </div>`;
    }

    return `
    <div class="policy-panel">
      <div class="policy-panel-header">
        <div class="panel-logo ${logoClass}">${shortName}</div>
        <div>
          <div style="font-size:15px;font-weight:700">${PNAMES[p]}</div>
          <div style="font-size:12px;color:var(--g400)">选择授予该用户的权限策略</div>
        </div>
        ${!credStatus[p] ? `<div style="margin-left:auto;font-size:12px;color:var(--warn);font-weight:600">⚠ 未配置主账号凭据</div>` : ''}
      </div>
      <div class="policy-body">
        <div class="policy-left">
          <input type="text" class="policy-search" placeholder="搜索策略名称或描述..." oninput="filterPolicies('${p}', this.value)">
          <div class="policy-grid" data-plat="${p}"></div>
          <div id="policy-pager-${p}" class="policy-pager"></div>
        </div>
        <div class="policy-right">
          ${_groupSectionHtml(p, syncedGroupsData[p] || [])}
        </div>
      </div>
      <div class="console-toggle-row">
        <label class="console-toggle-label">
          <input type="checkbox" id="console-${p}">
          <div>
            <strong>启用控制台登录</strong>
            <span>允许该用户使用本次密码登录 ${shortName} 控制台</span>
          </div>
        </label>
      </div>
    </div>`;
  }).join('');

  [...selectedPlatforms].forEach(p => {
    if (p !== 'bytebase') {
      _renderPolicyGrid(p);
      _appendCustomPolicies(p);
    }
  });
}

async function _appendCustomPolicies(platform) {
  try {
    const r = await get(`/cloud/policies/custom?platform=${platform}`);
    if (!r.ok || !r.data.policies?.length) return;
    if (!policyState[platform]) return;
    for (const pol of r.data.policies) {
      policyState[platform].items.push({ id: pol.id, name: pol.name, desc: pol.desc || '', level: 'normal', custom: true });
    }
    _renderPolicyGrid(platform);
  } catch (_) {}
}

function _renderPolicyGrid(p) {
  const grid = document.querySelector(`.policy-grid[data-plat="${p}"]`);
  const pager = document.getElementById(`policy-pager-${p}`);
  if (!grid || !policyState[p]) return;

  const state = policyState[p];
  const selected = checkedPolicies[p] || new Set();
  const q = (state.query || '').toLowerCase();
  const filtered = q
    ? state.items.filter(pol => pol.name.toLowerCase().includes(q) || (pol.desc || '').toLowerCase().includes(q))
    : state.items;

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  const slice = filtered.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);

  grid.innerHTML = slice.map(pol => `
    <label class="policy-item level-${pol.level || 'normal'}">
      <input type="checkbox" name="policy-${p}" value="${esc(pol.id)}"
        ${selected.has(pol.id) ? 'checked' : ''}
        onchange="_togglePolicy('${p}','${esc(pol.id)}',this.checked)">
      <div class="policy-item-info">
        <div class="policy-item-name"><span class="level-dot"></span>${esc(pol.name)}${pol.custom ? ' <span style="font-size:10px;color:var(--g400)">(自定义)</span>' : ''}</div>
        <div class="policy-item-desc">${esc(pol.desc || '')}</div>
      </div>
    </label>`).join('');

  if (pager) {
    if (totalPages <= 1) {
      pager.innerHTML = `<span class="pol-pager-info">${total > 0 ? `共 ${total} 个策略` : '无匹配策略'}</span>`;
    } else {
      pager.innerHTML = `
        <button class="pol-page-btn" onclick="_goPolPage('${p}',-1)" ${state.page <= 1 ? 'disabled' : ''}>‹ 上一页</button>
        <span class="pol-pager-info">第 ${state.page} / ${totalPages} 页（共 ${total} 个）</span>
        <button class="pol-page-btn" onclick="_goPolPage('${p}',1)" ${state.page >= totalPages ? 'disabled' : ''}>下一页 ›</button>`;
    }
  }
}

function _togglePolicy(p, id, checked) {
  if (!checkedPolicies[p]) checkedPolicies[p] = new Set();
  if (checked) checkedPolicies[p].add(id);
  else checkedPolicies[p].delete(id);
}

function _goPolPage(p, delta) {
  if (!policyState[p]) return;
  policyState[p].page += delta;
  _renderPolicyGrid(p);
}

function filterPolicies(platform, query) {
  if (!policyState[platform]) return;
  policyState[platform].query = query;
  policyState[platform].page = 1;
  _renderPolicyGrid(platform);
}

function _groupSectionHtml(p, groups) {
  const inner = groups.length
    ? `<div class="group-checkbox-list">
        ${groups.map(g => `
          <label class="group-checkbox-item">
            <input type="checkbox" name="group-${p}" value="${g.group_name}">
            <span class="group-checkbox-name">${esc(g.display_name || g.group_name)}</span>
            <span class="group-checkbox-count">${g.member_count} 成员</span>
          </label>`).join('')}
      </div>`
    : `<div class="group-hint">暂无已同步的用户组
        ${credStatus[p]
          ? `<button class="btn-ghost" style="margin-left:10px;padding:2px 10px;font-size:12px;vertical-align:middle" onclick="fetchGroupsForPlatform('${p}')">从云端拉取</button>`
          : '（请先在「云平台配置」中配置凭据）'}
      </div>`;
  return `<div id="group-section-${p}" class="group-section">
    <div class="group-section-title">加入用户组（可选）</div>
    ${inner}
  </div>`;
}

async function fetchGroupsForPlatform(platform) {
  const el = document.getElementById(`group-section-${platform}`);
  if (!el) return;
  el.innerHTML = `<div class="group-section-title">加入用户组（可选）</div>
    <div class="group-hint"><span class="spin" style="display:inline-block;vertical-align:middle;width:13px;height:13px;border-width:2px;margin-right:6px"></span>正在从云端拉取...</div>`;

  const r = await post(`/sync/groups/${platform}`, {});
  if (r.ok) {
    const gr = await get(`/sync/groups?platform=${platform}`);
    if (gr.ok) syncedGroupsData[platform] = gr.data.groups;
    el.outerHTML = _groupSectionHtml(platform, syncedGroupsData[platform] || []);
  } else {
    el.innerHTML = `<div class="group-section-title">加入用户组（可选）</div>
      <div class="group-hint">拉取失败：${esc(r.data?.error || '未知错误')}
        <button class="btn-ghost" style="margin-left:10px;padding:2px 10px;font-size:12px;vertical-align:middle" onclick="fetchGroupsForPlatform('${platform}')">重试</button>
      </div>`;
  }
}

function renderReview() {
  const name  = document.getElementById('c-name').value.trim();
  const email = document.getElementById('c-email').value.trim();
  const dept  = document.getElementById('c-dept').value.trim();
  const notes = document.getElementById('c-notes').value.trim();

  const platformData = [...selectedPlatforms].map(p => {
    const checked       = [...(checkedPolicies[p] || new Set())];
    const groups        = [...document.querySelectorAll(`input[name="group-${p}"]:checked`)].map(el => el.value);
    const enable_console = document.getElementById(`console-${p}`)?.checked || false;
    return { platform: p, policies: checked, groups, enable_console };
  });

  document.getElementById('review-content').innerHTML = `
    <div class="review-section">
      <div class="review-label">基本信息</div>
      <div class="review-info-grid">
        <div class="review-info-item"><div class="review-info-key">姓名</div><div class="review-info-val">${esc(name)}</div></div>
        <div class="review-info-item"><div class="review-info-key">邮箱</div><div class="review-info-val">${esc(email)}</div></div>
        <div class="review-info-item"><div class="review-info-key">部门</div><div class="review-info-val">${esc(dept || '未设置')}</div></div>
        ${notes ? `<div class="review-info-item" style="grid-column:1/-1"><div class="review-info-key">备注</div><div class="review-info-val">${esc(notes)}</div></div>` : ''}
      </div>
    </div>
    ${platformData.length ? `
    <div class="review-section">
      <div class="review-label">云平台权限</div>
      ${platformData.map(({ platform: p, policies, groups, enable_console }) => `
        <div class="review-cloud-item">
          <div class="review-cloud-header">
            <div class="review-mini-logo ${p === 'aws' ? 'aws-bg' : p === 'aliyun' ? 'ali-bg' : p === 'bytebase' ? 'bb-bg' : p === 'jumpserver' || p === 'kuboard' ? '' : 'bai-bg'}" ${p === 'jumpserver' ? 'style="background:#e65c00;color:#fff"' : p === 'kuboard' ? 'style="background:#0052cc;color:#fff"' : ''}>${{aws:'AWS',aliyun:'阿里',baidu:'百度',bytebase:'BB',jumpserver:'JS',kuboard:'KB'}[p]||p}</div>
            <div class="review-cloud-name">${PNAMES[p]}</div>
            ${!credStatus[p] && p !== 'kuboard' ? `<span style="margin-left:auto;font-size:12px;color:var(--warn);font-weight:600">将以模拟模式创建</span>` : ''}
          </div>
          <div class="policy-tags">
            ${policies.length ? policies.map(pol => `<span class="policy-tag">${esc(pol)}</span>`).join('') : '<span style="color:var(--g400);font-size:12px">未选择任何权限（将创建无策略子账号）</span>'}
          </div>
          ${groups.length ? `<div style="margin-top:8px"><div style="font-size:11.5px;color:var(--g400);margin-bottom:4px">加入用户组</div><div class="policy-tags">${groups.map(g => `<span class="policy-tag" style="background:#EEF2FF;border-color:var(--primary);color:var(--primary)">${esc(g)}</span>`).join('')}</div></div>` : ''}
          <div style="margin-top:8px;font-size:12.5px;color:${enable_console ? 'var(--success)' : 'var(--g400)'}">
            ${enable_console ? '✅ 启用控制台登录' : '○ 不启用控制台登录'}
          </div>
        </div>`).join('')}
    </div>` : '<div style="color:var(--g400);margin-bottom:16px">不关联任何云平台，仅创建本地账号</div>'}`;
}

async function submitCreate() {
  const name       = document.getElementById('c-name').value.trim();
  const email      = document.getElementById('c-email').value.trim();
  const password   = document.getElementById('c-password').value;
  const department = document.getElementById('c-dept').value.trim();
  const notes      = document.getElementById('c-notes').value.trim();

  const cloud_accounts = [...selectedPlatforms].map(p => {
    const policies      = [...(checkedPolicies[p] || new Set())];
    const groups        = [...document.querySelectorAll(`input[name="group-${p}"]:checked`)].map(el => el.value);
    const enable_console = document.getElementById(`console-${p}`)?.checked || false;
    return { platform: p, policies, groups, enable_console };
  });

  document.getElementById('btn-submit').disabled = true;
  document.getElementById('btn-submit').textContent = '创建中...';

  const r = await post('/accounts/create', { name, email, password, department, notes, cloud_accounts });

  document.getElementById('btn-submit').disabled = false;
  document.getElementById('btn-submit').textContent = '确认创建';
  document.getElementById('confirm-actions').classList.add('hidden');

  const resultEl = document.getElementById('create-result');
  resultEl.classList.remove('hidden');

  if (r.ok) {
    const { user, cloud_results } = r.data;
    let html = '';

    for (const cr of (cloud_results || [])) {
      const ok = cr.status === 'active';
      const icon = ok ? '✅' : cr.status === 'no_credential' ? '⚠️' : '❌';
      const cls = ok ? 'success' : cr.status === 'no_credential' ? 'warn' : 'error';
      html += `<div class="result-item ${cls}">
        <div class="result-icon">${icon}</div>
        <div class="result-text">
          <strong>${PNAMES[cr.platform]} 子账号</strong>
          <p>${cr.message || ''}</p>
          ${ok && cr.cloud_access_key ? `<div class="cred-box"><span>子账号：${esc(cr.cloud_username)}</span><span>Access Key: ${esc(cr.cloud_access_key)}</span><span>Secret Key: ${esc(cr.cloud_secret_key)}</span></div>` : ''}
          ${cr.policies?.length ? `<div class="policy-tags" style="margin-top:8px">${cr.policies.map(p => `<span class="policy-tag">${esc(p)}</span>`).join('')}</div>` : ''}
        </div>
      </div>`;
    }

    html += `<button class="btn-primary" style="margin-top:16px" onclick="navTo('cloud-accounts')">查看账号列表</button>
             <button class="btn-ghost" style="margin-top:16px;margin-left:10px" onclick="initCreate()">再创建一个</button>`;
    resultEl.innerHTML = html;
    toast('账号创建成功', 'ok');
  } else {
    resultEl.innerHTML = `<div class="result-item error"><div class="result-icon">❌</div><div class="result-text"><strong>创建失败</strong><p>${esc(r.data.error || '未知错误')}</p></div></div>
      <button class="btn-ghost" style="margin-top:16px" onclick="document.getElementById('confirm-actions').classList.remove('hidden');document.getElementById('create-result').classList.add('hidden')">返回修改</button>`;
    toast(r.data.error || '创建失败', 'err');
  }
}

// ─────────────────────────────────────────
// 云平台配置
