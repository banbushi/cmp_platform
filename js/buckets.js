// ══════════════════════════════════════════════════
// 对象存储 Bucket 管理
// ══════════════════════════════════════════════════

const BUCKET_REGIONS = {
  aws:    ['us-east-1','us-east-2','us-west-1','us-west-2','ap-northeast-1','ap-southeast-1','eu-west-1','eu-central-1'],
  aliyun: ['cn-hangzhou','cn-shanghai','cn-beijing','cn-shenzhen','cn-hongkong','ap-southeast-1'],
  baidu:  ['bj','gz','su','hkg']
};

let _bucketAllItems = [], _bucketFiltered = [];
let _bucketFilter = 'all', _bucketPage = 1, _bucketPageSize = 20;

async function loadBuckets() {
  const wrap = document.getElementById('buckets-table-wrap');
  const loading = document.getElementById('buckets-loading');
  loading.classList.remove('hidden');
  wrap.innerHTML = '';
  const r = await get('/storage/buckets');
  loading.classList.add('hidden');
  if (!r.ok) { wrap.innerHTML = `<div class="empty-tip">加载失败: ${esc(r.data?.error || '')}</div>`; return; }
  _bucketAllItems = r.data.buckets || [];
  _bucketPage = 1;
  _filterBuckets();
}

async function syncBuckets(platform) {
  const loading = document.getElementById('buckets-loading');
  loading.classList.remove('hidden');
  const r = await post(`/storage/sync-buckets/${platform}`, {});
  loading.classList.add('hidden');
  if (!r.ok) { toast(r.data?.error || '同步失败', 'err'); return; }
  toast(`${r.data.message}`, 'ok');
  loadBuckets();
}

function setBucketFilter(p, el) {
  _bucketFilter = p;
  document.querySelectorAll('#sec-buckets .filter-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _bucketPage = 1;
  _filterBuckets();
}

function _filterBuckets() {
  const keyword = (document.getElementById('bucket-keyword')?.value || '').trim().toLowerCase();
  _bucketFiltered = _bucketAllItems.filter(b => {
    if (_bucketFilter !== 'all' && b.platform !== _bucketFilter) return false;
    return !keyword || b.name.toLowerCase().includes(keyword) || (b.region || '').toLowerCase().includes(keyword);
  });
  _renderBucketsPage();
}

function _renderBucketsPage() {
  const wrap  = document.getElementById('buckets-table-wrap');
  const total = _bucketFiltered.length;
  const start = (_bucketPage - 1) * _bucketPageSize;
  const pageItems = _bucketFiltered.slice(start, start + _bucketPageSize);

  if (!pageItems.length) {
    wrap.innerHTML = '<div class="empty-tip">暂无 Bucket 数据，请先点击同步</div>';
    return;
  }

  const rows = pageItems.map(b => `<tr>
    <td>${_platPill(b.platform)}</td>
    <td><strong>${esc(b.name)}</strong></td>
    <td style="color:var(--g600);font-size:12px">${esc(b.region || b.location || '-')}</td>
    <td style="color:var(--g500);font-size:12px">${esc((b.synced_at || '').toString().slice(0,19).replace('T',' '))}</td>
    <td class="perm-admin-only"><button class="btn-ghost" style="padding:3px 10px;font-size:12px" onclick="showBucketGrantModal('${esc(b.platform)}','${esc(b.name)}')">授权策略</button></td>
  </tr>`).join('');

  wrap.innerHTML = `
    <div class="sync-table-container"><table class="sync-table" style="min-width:800px">
      <thead><tr><th style="width:80px">云平台</th><th>Bucket 名称</th><th style="width:130px">地域</th><th style="width:140px;white-space:nowrap">同步时间</th><th style="width:100px"></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${_buildPagination(total, _bucketPage, _bucketPageSize, '_goBucketPage', '_setBucketPageSize')}`;
}

function _goBucketPage(n) {
  const maxPage = Math.ceil(_bucketFiltered.length / _bucketPageSize) || 1;
  _bucketPage = Math.max(1, Math.min(n, maxPage));
  _renderBucketsPage();
}

function _setBucketPageSize(size) {
  _bucketPageSize = parseInt(size);
  _bucketPage = 1;
  _renderBucketsPage();
}

// ── Bucket 授权弹窗 ─────────────────────────────────────────────────────────

let _bgPlatform = '', _bgBucket = '';

async function showBucketGrantModal(platform, bucketName) {
  _bgPlatform = platform;
  _bgBucket   = bucketName;
  const PLABEL = { aws: 'AWS S3', aliyun: '阿里云 OSS', baidu: '百度云 BOS' };
  document.getElementById('bg-platform-label').textContent = PLABEL[platform] || platform;
  document.getElementById('bg-bucket-label').textContent   = bucketName;
  document.getElementById('bg-path').value                 = '*';
  document.getElementById('bg-policy-name').value          = '';
  document.getElementById('bg-err').textContent            = '';
  document.querySelector('input[name="bg-perm"][value="read"]').checked = true;
  document.getElementById('bg-new-policy-section').classList.remove('hidden');
  document.getElementById('bg-existing-policy-section').classList.add('hidden');

  // 自动建议策略名称
  const productMap = { aws: 's3', aliyun: 'oss', baidu: 'bos' };
  const product = productMap[platform] || platform;
  const sep = platform === 'baidu' ? '_' : '-';
  const safeBucket = bucketName.replace(/[^a-zA-Z0-9]/g, sep).slice(0, 30);
  document.getElementById('bg-policy-name').value = `cmp${sep}${product}${sep}${safeBucket}${sep}all${sep}ro`;

  // 加载本地用户列表
  const localUserSel = document.getElementById('bg-local-user');
  localUserSel.innerHTML = '<option value="">-- 请选择用户 --</option>';
  const lr = await get('/storage/local-users');
  if (lr.ok) {
    for (const u of (lr.data.users || [])) {
      const label = u.name ? `${esc(u.name)} (${esc(u.email)})` : esc(u.email);
      localUserSel.insertAdjacentHTML('beforeend', `<option value="${esc(u.id)}">${label}</option>`);
    }
  }

  // 重置云子账号下拉
  const userSel = document.getElementById('bg-cloud-user');
  userSel.innerHTML = '<option value="">-- 请先选择用户 --</option>';

  // 显示已授权用户列表
  loadGrantedUsers(platform, bucketName);

  document.getElementById('modal-bucket-grant').classList.remove('hidden');
}

// 选择本地用户后，筛选对应的云子账号
async function onBgLocalUserChange() {
  const localUserId = document.getElementById('bg-local-user').value;
  const userSel = document.getElementById('bg-cloud-user');
  userSel.innerHTML = '<option value="">加载中...</option>';

  const ur = await get(`/storage/grant-users?platform=${_bgPlatform}&userId=${encodeURIComponent(localUserId)}`);
  if (ur.ok) {
    const users = ur.data.users || [];
    if (users.length === 0) {
      // 如果该用户没有关联的云子账号，显示所有云子账号供选择
      userSel.innerHTML = '<option value="">-- 请选择云子账号 --</option>';
      const ar = await get(`/storage/grant-users?platform=${_bgPlatform}`);
      if (ar.ok) {
        for (const u of (ar.data.users || [])) {
          userSel.insertAdjacentHTML('beforeend', `<option value="${esc(u.cloud_username)}">${esc(u.cloud_username)}</option>`);
        }
      }
    } else {
      userSel.innerHTML = '<option value="">-- 请选择云子账号 --</option>';
      for (const u of users) {
        userSel.insertAdjacentHTML('beforeend', `<option value="${esc(u.cloud_username)}">${esc(u.cloud_username)}</option>`);
      }
    }
  } else {
    userSel.innerHTML = '<option value="">加载失败</option>';
  }
}

// 加载已授权用户列表
async function loadGrantedUsers(platform, bucketName) {
  const listEl = document.getElementById('bg-granted-list');
  listEl.textContent = '加载中...';
  const r = await get(`/storage/bucket-grants?platform=${platform}&bucket=${encodeURIComponent(bucketName)}`);
  if (r.ok && (r.data.grants || []).length > 0) {
    const html = r.data.grants.map(g => {
      const perm = g.permission === 'readwrite' ? '读写' : '只读';
      return `<div style="padding:4px 0;border-bottom:1px solid var(--g200)">
        <span style="font-weight:500">${esc(g.user_name || g.user_id)}</span>
        <span style="color:var(--g400);margin-left:8px">${perm}</span>
        <span style="color:var(--g400);margin-left:8px;font-family:monospace">${esc(g.cloud_username)}</span>
      </div>`;
    }).join('');
    listEl.innerHTML = html;
  } else {
    listEl.textContent = '暂无授权记录';
  }
}

function closeBucketGrantModal() {
  document.getElementById('modal-bucket-grant').classList.add('hidden');
}

async function onBgPermChange() {
  const perm = document.querySelector('input[name="bg-perm"]:checked')?.value;
  const newSection      = document.getElementById('bg-new-policy-section');
  const existingSection = document.getElementById('bg-existing-policy-section');
  const nameInput       = document.getElementById('bg-policy-name');
  const btn             = document.getElementById('bg-btn-submit');

  if (perm === 'existing') {
    newSection.classList.add('hidden');
    existingSection.classList.remove('hidden');
    btn.textContent = '创建并授权';
    // 加载已有策略
    const sel = document.getElementById('bg-existing-policy');
    sel.innerHTML = '<option value="">加载中...</option>';
    const r = await get(`/cloud/policies/custom?platform=${_bgPlatform}`);
    if (r.ok) {
      const policies = r.data.policies || [];
      sel.innerHTML = '<option value="">-- 请选择策略 --</option>'
        + policies.map(p => `<option value="${esc(p.id)}" data-name="${esc(p.name)}">${esc(p.name)}${p.desc ? ' — ' + esc(p.desc.slice(0,40)) : ''}</option>`).join('');
    } else {
      sel.innerHTML = '<option value="">加载失败</option>';
    }
  } else {
    newSection.classList.remove('hidden');
    existingSection.classList.add('hidden');
    btn.textContent = '创建授权策略';
    // 更新策略名称建议
    const productMap = { aws: 's3', aliyun: 'oss', baidu: 'bos' };
    const product = productMap[_bgPlatform] || _bgPlatform;
    const sep = _bgPlatform === 'baidu' ? '_' : '-';
    const safeBucket = _bgBucket.replace(/[^a-zA-Z0-9]/g, sep).slice(0, 30);
    nameInput.value = `cmp${sep}${product}${sep}${safeBucket}${sep}all${sep}${perm === 'readwrite' ? 'rw' : 'ro'}`;
  }
}

async function submitBucketGrant() {
  const btn    = document.getElementById('bg-btn-submit');
  const errEl  = document.getElementById('bg-err');
  errEl.textContent = '';
  const perm          = document.querySelector('input[name="bg-perm"]:checked')?.value;
  const path          = document.getElementById('bg-path').value.trim() || '*';
  const policyName    = document.getElementById('bg-policy-name').value.trim();
  const cloudUsername = document.getElementById('bg-cloud-user').value || '';
  const localUserId   = document.getElementById('bg-local-user').value || '';

  if (!localUserId)     { errEl.textContent = '请选择要授权的本地用户'; return; }
  if (!cloudUsername)   { errEl.textContent = '请选择要授权的云账号用户'; return; }
  let existingPolicyName = '', existingPolicyArn = '';
  if (perm === 'existing') {
    const sel = document.getElementById('bg-existing-policy');
    existingPolicyArn  = sel.value;
    existingPolicyName = sel.options[sel.selectedIndex]?.dataset.name || sel.value;
    if (!existingPolicyArn) { errEl.textContent = '请选择一条已有策略'; return; }
  } else {
    if (!policyName) { errEl.textContent = '请填写策略名称'; return; }
  }

  btn.disabled = true; btn.textContent = '处理中...';
  const r = await post('/storage/grant', {
    platform: _bgPlatform, bucket: _bgBucket, path, permission: perm,
    policyName: perm !== 'existing' ? policyName : undefined,
    existingPolicyName: perm === 'existing' ? existingPolicyName : undefined,
    existingPolicyArn:  perm === 'existing' ? existingPolicyArn  : undefined,
    cloudUsername: cloudUsername || undefined,
    userId: localUserId || undefined,
  });
  btn.disabled = false;
  btn.textContent = perm === 'existing' ? '附加到用户' : '创建并授权';

  if (r.ok) {
    const msg = `已将 ${r.data.policyName} 授权给用户 ${cloudUsername}`;
    toast(msg, 'ok');
    closeBucketGrantModal();
    // 刷新授权列表
    if (typeof loadGrantedUsers === 'function') loadGrantedUsers(_bgPlatform, _bgBucket);
  } else {
    errEl.textContent = r.data?.error || '操作失败';
  }
}

function showBucketCreateModal() {
  document.querySelectorAll('input[name="bc-platform"]').forEach(r => r.checked = false);
  document.getElementById('bc-name').value = '';
  document.getElementById('bc-region').innerHTML = '<option value="">请先选择云平台</option>';
  document.getElementById('bc-region').disabled = true;
  document.getElementById('bc-err').textContent = '';
  document.getElementById('modal-bucket-create').classList.remove('hidden');
}

function closeBucketCreateModal() {
  document.getElementById('modal-bucket-create').classList.add('hidden');
}

function onBucketPlatformChange() {
  const plat = document.querySelector('input[name="bc-platform"]:checked')?.value;
  const sel = document.getElementById('bc-region');
  sel.disabled = false;
  const regions = BUCKET_REGIONS[plat] || [];
  sel.innerHTML = regions.map(r => `<option value="${r}">${r}</option>`).join('');
}

async function submitBucketCreate() {
  const plat   = document.querySelector('input[name="bc-platform"]:checked')?.value;
  const name   = document.getElementById('bc-name').value.trim();
  const region = document.getElementById('bc-region').value;
  const errEl  = document.getElementById('bc-err');
  errEl.textContent = '';
  if (!plat)   { errEl.textContent = '请选择云平台'; return; }
  if (!name)   { errEl.textContent = '请填写 Bucket 名称'; return; }
  if (!/^[a-z0-9][a-z0-9\-]{1,61}[a-z0-9]$/.test(name)) {
    errEl.textContent = '名称格式不正确：仅允许小写字母、数字和连字符（-），长度 3~63 字符，不能以连字符开头或结尾';
    return;
  }
  if (!region) { errEl.textContent = '请选择地域'; return; }

  const r = await post('/storage/buckets', { platform: plat, name, region });
  if (!r.ok) { errEl.textContent = r.data?.error || '创建失败'; return; }
  toast('Bucket 创建成功', 'ok');
  closeBucketCreateModal();
  loadBuckets();
}

// ══════════════════════════════════════════════════
// 自定义策略管理
// ══════════════════════════════════════════════════

let _policyPlatform = 'all';

async function loadPolicies() {
  const wrap    = document.getElementById('policies-table-wrap');
  const loading = document.getElementById('policies-loading');
  loading.classList.remove('hidden');
  wrap.innerHTML = '';

  const platforms = _policyPlatform === 'all' ? ['aws', 'aliyun', 'baidu'] : [_policyPlatform];
  const allPolicies = [];

  await Promise.allSettled(platforms.map(async p => {
    const r = await get(`/cloud/policies/custom?platform=${p}`);
    if (r.ok) (r.data.policies || []).forEach(pol => allPolicies.push({ ...pol, platform: p }));
  }));

  loading.classList.add('hidden');
  _renderPoliciesTable(allPolicies);
}

function setPolicyPlatform(p, el) {
  _policyPlatform = p;
  document.querySelectorAll('#sec-policies .filter-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  loadPolicies();
}

function _renderPoliciesTable(items) {
  const wrap = document.getElementById('policies-table-wrap');
  if (!items.length) {
    wrap.innerHTML = '<div class="empty-tip">暂无自定义策略</div>';
    return;
  }
  const rows = items.map(p => `<tr>
    <td>${_platPill(p.platform)}</td>
    <td><strong>${esc(p.name)}</strong></td>
    <td style="color:var(--g500);font-size:12px">${esc(p.desc || '-')}</td>
    <td style="color:var(--g500);font-size:12px;font-family:monospace;font-size:11px">${esc(p.id || '')}</td>
  </tr>`).join('');
  wrap.innerHTML = `
    <div class="sync-table-container"><table class="sync-table" style="min-width:700px">
      <thead><tr><th style="width:80px">云平台</th><th style="width:200px">策略名称</th><th>描述</th><th style="width:220px">策略 ID / ARN</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function showPolicyCreateModal() {
  document.querySelectorAll('input[name="pc-platform"]').forEach(r => r.checked = false);
  document.getElementById('pc-name').value = '';
  document.getElementById('pc-desc').value = '';
  document.getElementById('pc-document').value = '';
  document.getElementById('pc-err').textContent = '';
  document.getElementById('modal-policy-create').classList.remove('hidden');
}

function closePolicyCreateModal() {
  document.getElementById('modal-policy-create').classList.add('hidden');
}

async function submitPolicyCreate() {
  const platform  = document.querySelector('input[name="pc-platform"]:checked')?.value;
  const name      = document.getElementById('pc-name').value.trim();
  const description = document.getElementById('pc-desc').value.trim();
  const document_ = document.getElementById('pc-document').value.trim();
  const errEl     = document.getElementById('pc-err');
  errEl.textContent = '';

  if (!platform)  { errEl.textContent = '请选择云平台'; return; }
  if (!name)      { errEl.textContent = '请填写策略名称'; return; }
  if (!document_) { errEl.textContent = '请填写策略文档'; return; }
  try { JSON.parse(document_); } catch { errEl.textContent = '策略文档不是合法 JSON'; return; }

  const r = await post('/cloud/policies/custom', { platform, name, description, document: document_ });
  if (!r.ok) { errEl.textContent = r.data?.error || '创建失败'; return; }
  toast('策略创建成功', 'ok');
  closePolicyCreateModal();
  loadPolicies();
}

// ─────────────────────────────────────────
