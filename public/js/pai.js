// ══════════════════════════════════════════════════
// 阿里云 PAI DSW 实例管理
// ══════════════════════════════════════════════════

// PAI 仅阿里云可用区域（DSW 常用地域）
const PAI_REGIONS = ['cn-shanghai', 'cn-hangzhou', 'cn-beijing', 'cn-shenzhen', 'cn-hongkong'];

let _paiAllItems = [], _paiFiltered = [];
let _paiPage = 1, _paiPageSize = 20;

// ── 列表 ──────────────────────────────────────────────

async function loadPaiDsw() {
  const wrap = document.getElementById('pai-table-wrap');
  const loading = document.getElementById('pai-loading');
  loading.classList.remove('hidden');
  wrap.innerHTML = '';
  const r = await get('/pai/dsw');
  loading.classList.add('hidden');
  if (!r.ok) { wrap.innerHTML = `<div class="empty-tip">加载失败: ${esc(r.data?.error || '')}</div>`; return; }
  _paiAllItems = r.data.instances || [];
  _paiPage = 1;
  _filterPai();
}

async function syncPaiDsw() {
  const loading = document.getElementById('pai-loading');
  loading.classList.remove('hidden');
  const r = await post('/pai/dsw/sync/aliyun', {});
  loading.classList.add('hidden');
  if (!r.ok) { toast(r.data?.error || '同步失败', 'err'); return; }
  const c = (r.data.results || [])[0]?.count ?? 0;
  toast(`同步成功，共 ${c} 个实例`, 'ok');
  loadPaiDsw();
}

function onPaiSearch() { _paiPage = 1; _filterPai(); }

function _filterPai() {
  const kw = (document.getElementById('pai-keyword')?.value || '').trim().toLowerCase();
  _paiFiltered = _paiAllItems.filter(it =>
    !kw || (it.instance_name || '').toLowerCase().includes(kw) || (it.instance_id || '').toLowerCase().includes(kw));
  _renderPaiPage();
}

function _paiStatusPill(status) {
  const s = (status || '').toLowerCase();
  let color = 'var(--g500)';
  if (s === 'running')  color = 'var(--ok, #16a34a)';
  else if (s.includes('creating') || s.includes('starting')) color = 'var(--warn, #d97706)';
  else if (s === 'stopped' || s.includes('stopping'))        color = 'var(--g400)';
  else if (s.includes('fail') || s.includes('error'))        color = 'var(--err, #dc2626)';
  return `<span style="color:${color};font-weight:500">${esc(status || '-')}</span>`;
}

// 解析实例规格文本：优先用 config.RequestedResource（CPU/内存/GPU/共享内存），回退 ecs_spec
function _paiSpecText(it) {
  try {
    const cfg = typeof it.config === 'string' ? JSON.parse(it.config || '{}') : (it.config || {});
    const rr = cfg.RequestedResource;
    if (rr && (rr.CPU || rr.Memory || rr.GPU)) {
      const parts = [];
      if (rr.CPU) parts.push(`${rr.CPU} 核`);
      if (rr.Memory) parts.push(`${String(rr.Memory).replace(/GB$/i, '')} GiB`);
      if (rr.GPU && Number(rr.GPU) > 0) parts.push(`${rr.GPU} GPU`);
      if (rr.SharedMemory) parts.push(`共享内存 ${String(rr.SharedMemory).replace(/GB$/i, '')} GiB`);
      let text = parts.join(' / ');
      if (it.ecs_spec) text += `（${it.ecs_spec}）`;
      return text || (it.ecs_spec || '-');
    }
  } catch (_) { /* 解析失败回退 */ }
  return it.ecs_spec || '-';
}

function _renderPaiPage() {
  const wrap = document.getElementById('pai-table-wrap');
  const total = _paiFiltered.length;
  const start = (_paiPage - 1) * _paiPageSize;
  const pageItems = _paiFiltered.slice(start, start + _paiPageSize);

  if (!pageItems.length) {
    wrap.innerHTML = '<div class="empty-tip">暂无 DSW 实例，请先点击创建或同步</div>';
    return;
  }

  const rows = pageItems.map(it => {
    const s = (it.status || '').toLowerCase();
    const running = s === 'running';
    const stopped = s === 'stopped';
    const jupyter = it.jupyter_url
      ? `<a href="${esc(it.jupyter_url)}" target="_blank" class="btn-ghost" style="padding:3px 10px;font-size:12px">打开</a>`
      : '<span style="color:var(--g400);font-size:12px">-</span>';
    const specText = _paiSpecText(it);
    return `<tr>
      <td><strong>${esc(it.instance_name || '-')}</strong><div style="color:var(--g400);font-size:11px;font-family:monospace">${esc(it.instance_id || '')}</div></td>
      <td style="color:var(--g600);font-size:12px">${esc(it.owner_name || '-')}</td>
      <td>${_paiStatusPill(it.status)}</td>
      <td style="color:var(--g600);font-size:12px">${esc(specText)}</td>
      <td style="color:var(--g600);font-size:12px;font-family:monospace">${esc(it.private_ip || '-')}</td>
      <td style="color:var(--g600);font-size:12px">${esc(it.region || '-')}</td>
      <td>${jupyter}</td>
      <td class="perm-operate" style="white-space:nowrap">
        <button class="btn-ghost" style="padding:3px 8px;font-size:12px" onclick="paiStart('${esc(it.id)}')" ${running ? 'disabled' : ''}>启动</button>
        <button class="btn-ghost" style="padding:3px 8px;font-size:12px" onclick="paiStop('${esc(it.id)}')" ${stopped ? 'disabled' : ''}>停止</button>
        <button class="btn-ghost" style="padding:3px 8px;font-size:12px;color:var(--err,#dc2626)" onclick="paiDelete('${esc(it.id)}','${esc(it.instance_name || it.instance_id)}')">删除</button>
      </td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="sync-table-container"><table class="sync-table" style="min-width:1130px">
      <thead><tr>
        <th>实例名称 / ID</th><th style="width:110px">归属人</th><th style="width:100px">状态</th><th style="width:150px">规格</th>
        <th style="width:120px">内网IP</th><th style="width:120px">地域</th><th style="width:80px">Jupyter</th><th style="width:200px">操作</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${_buildPagination(total, _paiPage, _paiPageSize, '_goPaiPage', '_setPaiPageSize')}`;
}

function _goPaiPage(n) {
  const maxPage = Math.ceil(_paiFiltered.length / _paiPageSize) || 1;
  _paiPage = Math.max(1, Math.min(n, maxPage));
  _renderPaiPage();
}
function _setPaiPageSize(size) { _paiPageSize = parseInt(size); _paiPage = 1; _renderPaiPage(); }

// ── 启动 / 停止 / 删除 ────────────────────────────────

async function paiStart(id) {
  const r = await post(`/pai/dsw/${id}/start`, {});
  if (!r.ok) { toast(r.data?.error || '启动失败', 'err'); return; }
  toast('启动指令已下发', 'ok'); loadPaiDsw();
}
async function paiStop(id) {
  const r = await post(`/pai/dsw/${id}/stop`, {});
  if (!r.ok) { toast(r.data?.error || '停止失败', 'err'); return; }
  toast('停止指令已下发', 'ok'); loadPaiDsw();
}
async function paiDelete(id, name) {
  if (!confirm(`确定删除 DSW 实例「${name}」？此操作不可恢复，实例数据将被清除。`)) return;
  const r = await del(`/pai/dsw/${id}`);
  if (!r.ok) { toast(r.data?.error || '删除失败', 'err'); return; }
  toast('删除成功', 'ok'); loadPaiDsw();
}

// ── 创建弹窗（级联加载：地域 → 工作区/规格/数据集） ────

function showPaiCreateModal() {
  document.getElementById('pai-name').value = '';
  document.getElementById('pai-rs-gpu').value = '';
  // 带默认值的字段：CPU 2核、内存 8G、共享内存 8G、系统盘 100G、CPFS 容量 10000G、文件数 1000万
  document.getElementById('pai-rs-cpu').value = '2';
  document.getElementById('pai-rs-mem').value = '8';
  document.getElementById('pai-rs-shm').value = '8';
  document.getElementById('pai-disk').value = '100';
  document.getElementById('pai-cpfs-size').value = '10000';
  document.getElementById('pai-cpfs-filecount').value = '10000000';
  document.getElementById('pai-cpfs-enabled').checked = false;
  document.getElementById('pai-cpfs-box').style.display = 'none';
  document.getElementById('pai-oss-enabled').checked = false;
  document.getElementById('pai-oss-box').style.display = 'none';
  const rwRadio = document.querySelector('input[name="pai-oss-access"][value="RW"]');
  if (rwRadio) rwRadio.checked = true;
  // Bucket 与路径前缀填真实默认值（不只是 placeholder），用户可直接改
  const ossBucket = document.getElementById('pai-oss-bucket');
  if (ossBucket) ossBucket.value = PAI_OSS_DEFAULT_BUCKET;
  const ossPrefix = document.getElementById('pai-oss-prefix');
  if (ossPrefix) ossPrefix.value = PAI_OSS_DEFAULT_PREFIX;
  // 挂载路径也填真实默认值 /mnt/share/（不再让用户手输）
  const ossMount = document.getElementById('pai-oss-mount-path');
  if (ossMount) {
    ossMount.value = `/mnt/${PAI_OSS_DEFAULT_PREFIX}/`;
    // 标记"仍是自动值"：用户没手改过时，改前缀会让挂载路径跟着同步
    ossMount.dataset.auto = '1';
  }
  // 重置高级参数
  const ossArn = document.getElementById('pai-oss-role-arn');
  if (ossArn) ossArn.value = '';
  const ossOpts = document.getElementById('pai-oss-options-json');
  if (ossOpts) ossOpts.value = '';
  const advBox = document.getElementById('pai-oss-adv-box');
  if (advBox) advBox.style.display = 'none';
  const advTog = document.getElementById('pai-oss-adv-toggle');
  if (advTog) advTog.textContent = '▸ 挂载高级参数（可选）';
  // 清空上一次残留的「已有数据集挂载参数」
  _paiDsOptions = {};
  // 重置 SSH 字段
  const sshEnabled = document.getElementById('pai-ssh-enabled');
  if (sshEnabled) sshEnabled.checked = false;
  document.getElementById('pai-ssh-key') && (document.getElementById('pai-ssh-key').value = '');
  document.getElementById('pai-ssh-key-wrap')?.classList.add('hidden');
  const startScript = document.getElementById('pai-start-script');
  if (startScript) startScript.value = '';
  const startScriptCount = document.getElementById('pai-start-script-count');
  if (startScriptCount) startScriptCount.textContent = '已输入：0 个字符';
  document.getElementById('pai-priority').value = '1';
  document.getElementById('pai-priority-val').textContent = '1';
  document.getElementById('pai-node').innerHTML = '<option value="">自动调度（不指定）</option>';
  document.getElementById('pai-err').textContent = '';
  const regionSel = document.getElementById('pai-region');
  regionSel.innerHTML = PAI_REGIONS.map(r => `<option value="${r}">${r}</option>`).join('');
  document.getElementById('modal-pai-create').classList.remove('hidden');
  onPaiRegionChange();
}

// 勾选 CPFS 时展开配置并确认有可用 CPFS
async function onPaiCpfsToggle() {
  const on = document.getElementById('pai-cpfs-enabled').checked;
  const box = document.getElementById('pai-cpfs-box');
  box.style.display = on ? '' : 'none';
  if (!on) return;
  const info = document.getElementById('pai-cpfs-info');
  info.textContent = '检查可用 CPFS...';
  const r = await get(`/pai/cpfs?region=${encodeURIComponent(_paiRegion())}`);
  if (!r.ok || !(r.data.items || []).length) {
    info.textContent = '该地域无可用 CPFS 文件系统，无法挂载';
    info.style.color = 'var(--err,#dc2626)';
    document.getElementById('pai-cpfs-enabled').checked = false;
    box.style.display = 'none';
    return;
  }
  const cpfs = r.data.items[0];
  info.style.color = 'var(--g400)';
  info.textContent = `文件系统：${cpfs.description || cpfs.fileSystemId}`;
}

// OSS 参数默认值（与 routes/pai.js 的 OSS_DATASET_BUCKET / OSS_DATASET_PREFIX 保持一致）
const PAI_OSS_DEFAULT_BUCKET = 'sh-algo-pub-rw';
const PAI_OSS_DEFAULT_PREFIX = 'share';

// 三个取值函数：留空即回落默认，与后端 normalize 规则一致
function _paiOssBucket() {
  return (document.getElementById('pai-oss-bucket')?.value || '').trim() || PAI_OSS_DEFAULT_BUCKET;
}
function _paiOssPrefix() {
  const v = (document.getElementById('pai-oss-prefix')?.value || '').trim().replace(/^\/+|\/+$/g, '');
  return v || PAI_OSS_DEFAULT_PREFIX;
}
function _paiOssMountPath() {
  let v = (document.getElementById('pai-oss-mount-path')?.value || '').trim();
  if (!v) v = `/mnt/${_paiOssPrefix()}`;
  if (!v.startsWith('/')) v = '/' + v;
  if (!v.endsWith('/'))   v = v + '/';
  return v.replace(/\/{2,}/g, '/');
}

// 勾选"新建 OSS 数据集"时展开配置
function onPaiOssToggle() {
  const on = document.getElementById('pai-oss-enabled').checked;
  document.getElementById('pai-oss-box').style.display = on ? '' : 'none';
  if (on) { loadPaiOssBuckets(); onPaiOssParamChange(); }
}

// 挂载高级参数折叠区
function togglePaiOssAdv() {
  const box = document.getElementById('pai-oss-adv-box');
  const tog = document.getElementById('pai-oss-adv-toggle');
  const open = box.style.display === 'none';
  box.style.display = open ? '' : 'none';
  tog.textContent = (open ? '▾' : '▸') + ' 挂载高级参数（可选）';
}

// 实时显示最终生效的 OSS 路径与挂载点，避免用户猜留空会变成什么
function onPaiOssParamChange() {
  const el = document.getElementById('pai-oss-effect');
  if (!el) return;
  const name = (document.getElementById('pai-name')?.value || '').trim() || '{实例名}';
  el.textContent = `oss://${_paiOssBucket()}/${_paiOssPrefix()}/${name}/ → ${_paiOssMountPath()}`;
}

// 改「OSS 路径前缀」时，若挂载路径还是自动值（用户没手改过），让它跟着同步。
// 否则默认填了 /mnt/share/ 之后改前缀为 data，挂载点仍停在 /mnt/share/ 容易出错。
function onPaiOssPrefixChange() {
  const mp = document.getElementById('pai-oss-mount-path');
  if (mp && mp.dataset.auto === '1') {
    mp.value = `/mnt/${_paiOssPrefix()}/`;
  }
  onPaiOssParamChange();
}

// 用户手动编辑挂载路径后就不再自动同步（清空则恢复自动）
function onPaiOssMountPathInput() {
  const mp = document.getElementById('pai-oss-mount-path');
  if (mp) mp.dataset.auto = mp.value.trim() === '' ? '1' : '0';
  onPaiOssParamChange();
}

// Bucket 候选：复用存储桶列表接口填 datalist，仍可手动输入任意值
let _paiOssBucketsLoaded = false;
async function loadPaiOssBuckets() {
  if (_paiOssBucketsLoaded) return;
  const dl = document.getElementById('pai-oss-bucket-list');
  if (!dl) return;
  const r = await get('/storage/buckets?platform=aliyun');
  if (!r.ok) return;                       // 拉不到不影响手动输入
  _paiOssBucketsLoaded = true;
  const names = (r.data.buckets || r.data.items || [])
    .map(b => b.name || b.bucket_name).filter(Boolean);
  dl.innerHTML = names.map(n => `<option value="${esc(n)}"></option>`).join('');
}

function closePaiCreateModal() {
  document.getElementById('modal-pai-create').classList.add('hidden');
}

// 默认工作区名称
const PAI_DEFAULT_WORKSPACE = 'vast_workspace';

// 地域变更 → 刷新工作区（其后由工作区变更联动 owner / 资源池），以及数据集、官方镜像
function onPaiRegionChange() {
  loadPaiWorkspaces();
  loadPaiDatasets();
  loadPaiImages();
}

function _paiRegion() { return document.getElementById('pai-region').value; }

async function loadPaiWorkspaces() {
  const sel = document.getElementById('pai-workspace');
  sel.innerHTML = '<option value="">加载中...</option>';
  const r = await get(`/pai/workspaces?region=${encodeURIComponent(_paiRegion())}`);
  if (!r.ok) { sel.innerHTML = '<option value="">加载失败</option>'; return; }
  const items = r.data.items || [];
  if (!items.length) { sel.innerHTML = '<option value="">该地域无工作区，请先在 PAI 控制台开通</option>'; onPaiWorkspaceChange(); return; }
  sel.innerHTML = items.map(w => `<option value="${esc(w.workspaceId)}">${esc(w.workspaceName || w.workspaceId)}</option>`).join('');
  // 默认选中 vast_workspace（存在则选它，否则第一个）
  const def = items.find(w => (w.workspaceName || '') === PAI_DEFAULT_WORKSPACE);
  if (def) sel.value = def.workspaceId;
  onPaiWorkspaceChange();
}

// 工作区变更 → 联动刷新 owner（该工作区成员）+ 资源池（绑定该工作区的配额）+ 镜像
function onPaiWorkspaceChange() {
  loadPaiOwners();
  loadPaiResources();
}

// 官方镜像缓存（供搜索框过滤）
let _paiImages = [];
// 默认镜像（按名称匹配，加载后自动选中）
const PAI_DEFAULT_IMAGE = 'python:3.14.0-cpu-ubuntu22.04';

// 加载官方 DSW 镜像（与工作区无关，按地域）
async function loadPaiImages() {
  const sel = document.getElementById('pai-image');
  sel.innerHTML = '<option value="">加载中...</option>';
  const r = await get(`/pai/images?region=${encodeURIComponent(_paiRegion())}`);
  if (!r.ok) { sel.innerHTML = '<option value="">加载失败</option>'; _paiImages = []; return; }
  _paiImages = r.data.items || [];
  const search = document.getElementById('pai-image-search');
  if (search) search.value = '';
  _renderPaiImageOptions('');
}

// 按关键字渲染镜像下拉
function _renderPaiImageOptions(keyword) {
  const sel = document.getElementById('pai-image');
  if (!_paiImages.length) { sel.innerHTML = '<option value="">无可用镜像</option>'; return; }
  const kw = (keyword || '').trim().toLowerCase();
  const filtered = kw ? _paiImages.filter(im => (im.name || '').toLowerCase().includes(kw)) : _paiImages;
  sel.innerHTML = filtered.length
    ? filtered.map(im => `<option value="${esc(im.imageId)}">${esc(im.name)}</option>`).join('')
    : '<option value="" disabled>无匹配镜像</option>';
  // 无搜索关键词时默认选中指定镜像（存在则选）
  if (!kw) {
    const def = _paiImages.find(im => im.name === PAI_DEFAULT_IMAGE);
    if (def) sel.value = def.imageId;
  }
  _updatePaiImageCurrent();
}

// 更新"当前选择"显示
function _updatePaiImageCurrent() {
  const box = document.getElementById('pai-image-current');
  if (!box) return;
  const sel = document.getElementById('pai-image');
  const id = sel.value;
  const im = _paiImages.find(x => x.imageId === id);
  box.innerHTML = im
    ? `当前选择：<span style="color:var(--primary);font-weight:500">${esc(im.name)}</span>`
    : '当前选择：<span style="color:var(--g400)">未选择</span>';
}

function onPaiImageChange() { _updatePaiImageCurrent(); }

function onPaiImageSearch() {
  _renderPaiImageOptions(document.getElementById('pai-image-search').value);
}

// owner 成员缓存（供搜索框过滤）
let _paiOwners = [];

async function loadPaiOwners() {
  const sel = document.getElementById('pai-owner');
  const wsId = document.getElementById('pai-workspace').value;
  if (!wsId) { sel.innerHTML = '<option value="">请先选择工作区</option>'; _paiOwners = []; return; }
  sel.innerHTML = '<option value="">加载中...</option>';
  const r = await get(`/pai/workspaces/${encodeURIComponent(wsId)}/members?region=${encodeURIComponent(_paiRegion())}`);
  if (!r.ok) { sel.innerHTML = '<option value="">加载失败</option>'; _paiOwners = []; return; }
  _paiOwners = r.data.items || [];
  const search = document.getElementById('pai-owner-search');
  if (search) search.value = '';
  _renderPaiOwnerOptions('');
}

// 按关键字渲染 owner 下拉
function _renderPaiOwnerOptions(keyword) {
  const sel = document.getElementById('pai-owner');
  if (!_paiOwners.length) {
    sel.innerHTML = '<option value="">该工作区无成员，请先用「成员管理」添加</option>';
    return;
  }
  const kw = (keyword || '').trim().toLowerCase();
  const filtered = kw
    ? _paiOwners.filter(m => (m.displayName || m.userId).toLowerCase().includes(kw))
    : _paiOwners;
  sel.innerHTML = filtered.length
    ? filtered.map(m => {
        const labels = (m.roleLabels && m.roleLabels.length ? m.roleLabels : m.roles || []);
        return `<option value="${esc(m.userId)}">${esc(m.displayName || m.userId)}${labels.length ? ' — ' + esc(labels.join('/')) : ''}</option>`;
      }).join('')
    : '<option value="" disabled>无匹配成员</option>';
}

function onPaiOwnerSearch() {
  _renderPaiOwnerOptions(document.getElementById('pai-owner-search').value);
}

// 加载绑定到当前工作区的资源配额（灵骏/通用计算）
async function loadPaiResources() {
  const sel = document.getElementById('pai-resource');
  const wsId = document.getElementById('pai-workspace').value;
  if (!wsId) { sel.innerHTML = '<option value="">请先选择工作区</option>'; return; }
  sel.innerHTML = '<option value="">加载中...</option>';
  const r = await get(`/pai/quotas?region=${encodeURIComponent(_paiRegion())}&workspace_id=${encodeURIComponent(wsId)}`);
  if (!r.ok) { sel.innerHTML = '<option value="">加载失败</option>'; return; }
  const items = r.data.items || [];
  if (!items.length) { sel.innerHTML = '<option value="">该工作区无资源配额，请先在 PAI 控制台分配</option>'; return; }
  sel.innerHTML = items.map(q => {
    const gpu = q.gpuType ? ` · ${esc(q.gpuType)}` : '';
    const specs = q.nodeSpecs ? ` · ${esc(q.nodeSpecs)}` : '';
    return `<option value="${esc(q.resourceId)}" data-name="${esc(q.name)}">${esc(q.name)} [${esc(q.typeLabel)}]${gpu}${specs}</option>`;
  }).join('');
  // 默认选中通用计算（ECS）配额，无则退回第一个
  const ecs = items.find(q => q.resourceType === 'ECS');
  if (ecs) sel.value = ecs.resourceId;
  // 资源池确定后加载其节点列表
  loadPaiNodes();
}

// 加载当前资源池下的节点（供指定节点调度，可选）
// 资源已满、不可创建的节点（nodeName / 实例ID），下拉里标记并禁用选择
const PAI_FULL_NODES = [];

async function loadPaiNodes() {
  const sel = document.getElementById('pai-node');
  const quotaId = document.getElementById('pai-resource').value;
  if (!quotaId) { sel.innerHTML = '<option value="">自动调度（不指定）</option>'; return; }
  sel.innerHTML = '<option value="">加载中...</option>';
  const r = await get(`/pai/nodes?region=${encodeURIComponent(_paiRegion())}&quota_id=${encodeURIComponent(quotaId)}`);
  if (!r.ok) { sel.innerHTML = '<option value="">自动调度（节点加载失败）</option>'; return; }
  const items = r.data.items || [];
  const opts = items.map(n => {
    const gpuType = n.gpuType || 'GPU';
    // 用量展示对齐控制台：「已用/总量」+ 括号剩余，形如「CPU 22/24核(剩2) · 内存 88/96G(剩8)」
    const parts = [];
    if (n.gpuRes) parts.push(`${gpuType} ${_fmtRes(n.gpuRes.used)}/${_fmtRes(n.gpuRes.total)}(剩${_fmtRes(n.gpuRes.free)})`);
    else if (Number(n.gpu) > 0) parts.push(`${n.gpu}×${gpuType}`);
    if (n.cpuRes) parts.push(`CPU ${_fmtRes(n.cpuRes.used)}/${_fmtRes(n.cpuRes.total)}核(剩${_fmtRes(n.cpuRes.free)})`);
    if (n.memRes) parts.push(`内存 ${_fmtRes(n.memRes.used)}/${_fmtRes(n.memRes.total)}G(剩${_fmtRes(n.memRes.free)})`);
    const resText = parts.length ? ` · ${parts.join(' · ')}` : '';
    const st = n.status && n.status !== 'Ready' ? ` (${esc(n.status)})` : '';
    // 剩余资源为 0（GPU 节点看 GPU，无 GPU 看 CPU）视为已满；叠加静态黑名单
    const noGpuFree = n.gpuRes && n.gpuRes.total > 0 && n.gpuRes.free <= 0;
    const noCpuFree = !n.gpuRes && n.cpuRes && n.cpuRes.free <= 0;
    const isFull = PAI_FULL_NODES.includes(n.nodeName) || noGpuFree || noCpuFree;
    const fullTag = isFull ? '（资源已满，不可创建）' : '';
    return `<option value="${esc(n.nodeName)}"${isFull ? ' disabled' : ''}>${esc(n.nodeName)} [${esc(n.nodeType || '')}]${esc(resText)}${st}${fullTag}</option>`;
  }).join('');
  sel.innerHTML = '<option value="">自动调度（不指定）</option>' + opts;
}

// 资源数值格式化：整数去小数，非整数保留一位
function _fmtRes(v) {
  if (v == null) return '?';
  return Number.isInteger(v) ? String(v) : (Math.round(v * 10) / 10).toString();
}

// 数据集缓存（供搜索框过滤）
let _paiDatasets = [];

async function loadPaiDatasets() {
  const box = document.getElementById('pai-datasets');
  box.innerHTML = '<div style="color:var(--g400);font-size:12px">加载中...</div>';
  const r = await get(`/pai/datasets?region=${encodeURIComponent(_paiRegion())}`);
  if (!r.ok) { box.innerHTML = '<div style="color:var(--err,#dc2626);font-size:12px">加载失败</div>'; _paiDatasets = []; return; }
  _paiDatasets = r.data.items || [];
  const search = document.getElementById('pai-dataset-search');
  if (search) search.value = '';
  delete box.dataset.dsDefaulted;  // 重新加载后允许再次应用默认勾选
  _renderPaiDatasets('');
}

// 按关键字渲染数据集勾选列表（保留已勾选项）
function _renderPaiDatasets(keyword) {
  const box = document.getElementById('pai-datasets');
  if (!_paiDatasets.length) { box.innerHTML = '<div style="color:var(--g400);font-size:12px">该地域暂无数据集</div>'; return; }
  // 记住当前已勾选，过滤重渲染后恢复
  const checked = new Set(Array.from(box.querySelectorAll('.pai-ds-cb:checked')).map(cb => cb.value));
  // 首次渲染（尚无勾选）默认选中 dataset-oss-pub_ro，并预填它的 ossfs 挂载参数
  if (!checked.size && !box.dataset.dsDefaulted) {
    const def = _paiDatasets.find(d => (d.datasetName || '') === 'dataset-oss-pub_ro');
    if (def) {
      checked.add(def.datasetId);
      box.dataset.dsDefaulted = '1';
      // 默认勾选的数据集自动带上 ossfs 配置，不需要手动点「填入」
      if (!_paiDsOptions[def.datasetId]) {
        _paiDsOptions[def.datasetId] = JSON.stringify(PAI_OSSFS_DEFAULT_OPTIONS, null, 2);
      }
    }
  }
  const kw = (keyword || '').trim().toLowerCase();
  const filtered = kw
    ? _paiDatasets.filter(d => (d.datasetName || d.datasetId || '').toLowerCase().includes(kw))
    : _paiDatasets;
  box.innerHTML = filtered.length ? filtered.map(d => {
    const isOss = /^oss:\/\//i.test(d.uri || '');
    const on = checked.has(d.datasetId);
    // 已填过的 Options 在重渲染后要保留
    const savedOpt = _paiDsOptions[d.datasetId] || '';
    return `
    <div style="padding:4px 0;border-bottom:1px solid var(--g100)">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
        <input type="checkbox" class="pai-ds-cb" value="${esc(d.datasetId)}" ${on ? 'checked' : ''}
               onchange="onPaiDsToggle('${esc(d.datasetId)}')">
        <span style="font-weight:500">${esc(d.datasetName || d.datasetId)}</span>
        <span style="color:var(--g400);font-size:11px">${esc(d.sourceType || '')}</span>
        <span style="color:var(--g400);font-size:11px;font-family:monospace">${esc((d.uri || '').slice(0, 40))}</span>
        ${isOss ? `<span style="margin-left:auto;font-size:11px;color:var(--primary);cursor:pointer"
             onclick="event.preventDefault();event.stopPropagation();toggleDsAdv('${esc(d.datasetId)}')"
             id="dsadv-tog-${esc(d.datasetId)}">▸ 挂载参数</span>` : ''}
      </label>
      ${isOss ? `
      <div id="dsadv-box-${esc(d.datasetId)}" style="display:none;margin:6px 0 8px 26px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span style="font-size:11.5px;color:var(--g600)">高级配置 JSON (Options)</span>
          <button type="button" class="btn-ghost" style="padding:2px 8px;font-size:11px"
                  onclick="fillDsOssfsDefault('${esc(d.datasetId)}')">填入 ossfs 默认配置</button>
          <button type="button" class="btn-ghost" style="padding:2px 8px;font-size:11px"
                  onclick="clearDsOptions('${esc(d.datasetId)}')">清空</button>
        </div>
        <textarea class="pai-ds-opt" data-dsid="${esc(d.datasetId)}" rows="3"
                  oninput="onDsOptionInput('${esc(d.datasetId)}')"
                  placeholder='留空则不传，走云端默认'
                  style="width:100%;font-family:monospace;font-size:11.5px;padding:6px 8px;border:1.5px solid var(--g200);border-radius:6px;resize:vertical">${esc(savedOpt)}</textarea>
        <div id="dsadv-err-${esc(d.datasetId)}" style="font-size:11px;color:var(--err,#dc2626);min-height:14px"></div>
      </div>` : ''}
    </div>`;
  }).join('') : '<div style="color:var(--g400);font-size:12px">无匹配数据集</div>';
}

// 每个已有数据集的 Options（datasetId → JSON 字符串），跨重渲染保留
let _paiDsOptions = {};

// 现网 96 个挂载项里有 11 个带 Options，且取值 100% 一致 —— 即这份 ossfs 配置。
// 做成一键填入的模板而非写死：不同数据集可能要调 mem.limit / image.tag。
const PAI_OSSFS_DEFAULT_OPTIONS = {
  'fs.oss.fuse.pod.image.tag': '2.0.6',
  'mountType': 'ossfs',
  'fs.oss.fuse.pod.mem.limit': '6Gi',
  'fs.ossfs.args': '-oinode_cache_eviction_threshold=1000000',
};

function toggleDsAdv(dsId) {
  const box = document.getElementById(`dsadv-box-${dsId}`);
  const tog = document.getElementById(`dsadv-tog-${dsId}`);
  if (!box) return;
  const open = box.style.display === 'none';
  box.style.display = open ? '' : 'none';
  if (tog) tog.textContent = (open ? '▾' : '▸') + ' 挂载参数';
}

function fillDsOssfsDefault(dsId) {
  const ta = document.querySelector(`.pai-ds-opt[data-dsid="${dsId}"]`);
  if (!ta) return;
  ta.value = JSON.stringify(PAI_OSSFS_DEFAULT_OPTIONS, null, 2);
  onDsOptionInput(dsId);
}

function clearDsOptions(dsId) {
  const ta = document.querySelector(`.pai-ds-opt[data-dsid="${dsId}"]`);
  if (!ta) return;
  ta.value = '';
  onDsOptionInput(dsId);
}

// 即时校验并记住（必须是 JSON 对象，数组/标量会让云端解析异常）
function onDsOptionInput(dsId) {
  const ta = document.querySelector(`.pai-ds-opt[data-dsid="${dsId}"]`);
  const err = document.getElementById(`dsadv-err-${dsId}`);
  if (!ta) return;
  const v = ta.value.trim();
  _paiDsOptions[dsId] = v;
  if (err) err.textContent = v ? (_dsOptionError(v) || '') : '';
}

// 返回错误文案，合法则返回 null
function _dsOptionError(v) {
  let parsed;
  try { parsed = JSON.parse(v); }
  catch (e) { return '不是合法 JSON：' + e.message; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return '需为 JSON 对象';
  }
  return null;
}

// 勾选状态变化时，未勾选的数据集不必保留其 Options
function onPaiDsToggle(dsId) {
  const cb = document.querySelector(`.pai-ds-cb[value="${dsId}"]`);
  if (cb && !cb.checked) {
    const box = document.getElementById(`dsadv-box-${dsId}`);
    if (box) box.style.display = 'none';
    const tog = document.getElementById(`dsadv-tog-${dsId}`);
    if (tog) tog.textContent = '▸ 挂载参数';
  }
}

function onPaiDatasetSearch() {
  _renderPaiDatasets(document.getElementById('pai-dataset-search').value);
}

// 待创建的配置（预览确认后提交）
let _paiPending = null;

// 收集并校验表单 → 通过则弹出预览确认层
function showPaiPreview() {
  const errEl = document.getElementById('pai-err');
  errEl.textContent = '';
  const region       = _paiRegion();
  const workspace_id = document.getElementById('pai-workspace').value;
  const workspace_name = document.getElementById('pai-workspace').selectedOptions[0]?.textContent || '';
  const owner_user_id = document.getElementById('pai-owner').value;
  const owner_name   = document.getElementById('pai-owner').selectedOptions[0]?.textContent || '';
  const instance_name = document.getElementById('pai-name').value.trim();
  const resourceSel  = document.getElementById('pai-resource');
  const resource_id  = resourceSel.value;
  const resource_name = resourceSel.selectedOptions[0]?.dataset.name || '';
  const resource_label = resourceSel.selectedOptions[0]?.textContent || '';
  const gpu          = document.getElementById('pai-rs-gpu').value;
  const cpu          = document.getElementById('pai-rs-cpu').value;
  const memory       = document.getElementById('pai-rs-mem').value;
  const shared_memory = document.getElementById('pai-rs-shm').value;
  const image_id     = document.getElementById('pai-image').value;
  const image_label  = document.getElementById('pai-image').selectedOptions[0]?.textContent || '';
  const system_disk_size = document.getElementById('pai-disk').value;
  const priority = document.getElementById('pai-priority').value;
  const nodeSel = document.getElementById('pai-node');
  const node_name = nodeSel.value;
  const node_label = node_name ? (nodeSel.selectedOptions[0]?.textContent || node_name) : '自动调度';
  const dsCbs = Array.from(document.querySelectorAll('.pai-ds-cb:checked'));
  const dataset_ids  = dsCbs.map(cb => cb.value);
  const dataset_labels = dsCbs.map(cb => cb.closest('label')?.querySelector('span')?.textContent || cb.value);
  // 每个已勾选数据集的 Options（只收集填了内容的），datasetId → JSON 字符串
  const dataset_options = {};
  for (const id of dataset_ids) {
    const v = (_paiDsOptions[id] || '').trim();
    if (v) dataset_options[id] = v;
  }
  const cpfs_enabled = document.getElementById('pai-cpfs-enabled').checked;
  const cpfs_size_gib = document.getElementById('pai-cpfs-size').value;
  const cpfs_file_count = document.getElementById('pai-cpfs-filecount').value;
  const oss_dataset_enabled = document.getElementById('pai-oss-enabled').checked;
  const oss_dataset_access = (document.querySelector('input[name="pai-oss-access"]:checked') || {}).value || 'RW';
  // OSS 参数手动输入，留空则由后端回落默认值
  const oss_bucket     = (document.getElementById('pai-oss-bucket')?.value || '').trim();
  const oss_prefix     = (document.getElementById('pai-oss-prefix')?.value || '').trim();
  const oss_mount_path = (document.getElementById('pai-oss-mount-path')?.value || '').trim();
  // 挂载高级参数（留空则不传，走云端默认）
  const oss_role_arn     = (document.getElementById('pai-oss-role-arn')?.value || '').trim();
  const oss_options_json = (document.getElementById('pai-oss-options-json')?.value || '').trim();
  const enable_ssh = document.getElementById('pai-ssh-enabled')?.checked || false;
  const ssh_public_key = (document.getElementById('pai-ssh-key')?.value || '').trim();
  const start_script = (document.getElementById('pai-start-script')?.value || '').trim();

  if (!workspace_id)  { errEl.textContent = '请选择工作区'; return; }
  if (!owner_user_id)  { errEl.textContent = '请选择实例归属人'; return; }
  if (!instance_name)  { errEl.textContent = '请填写实例名称'; return; }
  if (!resource_id)    { errEl.textContent = '请选择资源池'; return; }
  if (!image_id)       { errEl.textContent = '请选择镜像'; return; }
  if (!cpu || !memory) { errEl.textContent = '请填写 CPU 核数和内存(GiB)'; return; }
  if (enable_ssh && !ssh_public_key) { errEl.textContent = '启用 SSH 需填写 SSH 公钥'; return; }
  if (start_script.length > 8192) { errEl.textContent = '自定义启动脚本不能超过 8192 个字符'; return; }
  if (cpfs_enabled) {
    if (!cpfs_size_gib || !cpfs_file_count) { errEl.textContent = '挂载 CPFS 需填写容量(GiB)和文件数上限'; return; }
    if (Number(cpfs_size_gib) < 10) { errEl.textContent = 'CPFS 容量最小为 10 GiB'; return; }
    if (Number(cpfs_file_count) < 10000 || Number(cpfs_file_count) > 10000000000) { errEl.textContent = 'CPFS 文件数需在 1万 ~ 100亿之间'; return; }
  }
  // 已有数据集的 Options 校验（逐个报出是哪个数据集有问题）
  for (const [dsId, v] of Object.entries(dataset_options)) {
    const e = _dsOptionError(v);
    if (e) {
      const nm = (_paiDatasets.find(d => d.datasetId === dsId) || {}).datasetName || dsId;
      errEl.textContent = `数据集「${nm}」的挂载参数${e}`;
      return;
    }
  }
  // OSS 参数校验（与后端同规则，提前拦住少一次往返）
  if (oss_dataset_enabled) {
    if (oss_bucket && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(oss_bucket)) {
      errEl.textContent = 'OSS Bucket 名称不合法：只能小写字母、数字、短横线，3-63 位，且不以短横线开头或结尾'; return;
    }
    if (oss_prefix && (/\.\./.test(oss_prefix) || /\s/.test(oss_prefix))) {
      errEl.textContent = 'OSS 路径前缀不能包含 .. 或空格'; return;
    }
    if (oss_mount_path) {
      if (/\.\./.test(oss_mount_path) || /\s/.test(oss_mount_path)) {
        errEl.textContent = '挂载路径不能包含 .. 或空格'; return;
      }
      const mpn = oss_mount_path.replace(/\/+$/, '');
      if (mpn === '' || mpn === '/mnt') { errEl.textContent = '挂载路径不能是 / 或 /mnt，请指定子目录'; return; }
    }
    // 高级参数校验（与后端同规则）
    if (oss_role_arn && !/^acs:ram::\d+:role\/[\w+=,.@-]+$/.test(oss_role_arn)) {
      errEl.textContent = 'RAM 角色 ARN 格式不正确，应形如 acs:ram::1234567890:role/your-role'; return;
    }
    if (oss_options_json) {
      let parsed;
      try { parsed = JSON.parse(oss_options_json); }
      catch (e) { errEl.textContent = '高级配置不是合法 JSON：' + e.message; return; }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errEl.textContent = '高级配置需为 JSON 对象，例如 {"fs.oss.download.thread.concurrency":16}'; return;
      }
    }
  }

  // 存下提交用的 payload
  _paiPending = { region, workspace_id, owner_user_id, instance_name, image_id, dataset_ids, dataset_options, resource_id, resource_name, cpu, memory, gpu, shared_memory, system_disk_size, priority, node_name, cpfs_enabled, cpfs_size_gib, cpfs_file_count, oss_dataset_enabled, oss_dataset_access, oss_bucket, oss_prefix, oss_mount_path, oss_role_arn, oss_options_json, enable_ssh, ssh_public_key, start_script };

  // 渲染预览
  const spec = `${cpu} 核 / ${memory} GiB${gpu && Number(gpu) > 0 ? ' / ' + gpu + ' GPU' : ''}${shared_memory ? ' / 共享内存 ' + shared_memory + ' GiB' : ''}`;
  const rows = [
    ['地域', region],
    ['工作区', workspace_name],
    ['实例名称', instance_name],
    ['归属人', owner_name],
    ['资源池', resource_label],
    ['资源规格', spec],
    ['优先级', priority],
    ['指定节点', node_label],
    ['镜像', image_label],
    ['系统盘', system_disk_size ? `${system_disk_size} GiB` : '默认'],
    ['关联数据集', dataset_labels.length ? dataset_labels.join('、') : '无'],
    ...(Object.keys(dataset_options).length
      ? [['数据集挂载参数', Object.entries(dataset_options).map(([id, v]) => {
          const nm = (_paiDatasets.find(d => d.datasetId === id) || {}).datasetName || id;
          // 预览里压成一行，避免多行 JSON 把表格撑开
          return `${nm}: ${v.replace(/\s+/g, ' ')}`;
        }).join(' | ')]]
      : []),
    ['CPFS 工作目录', cpfs_enabled ? `创建并挂载（${cpfs_size_gib} GiB / ${cpfs_file_count} 文件）→ /mnt/pfs/users/${instance_name}` : '否'],
    ['新建 OSS 数据集', oss_dataset_enabled
      ? `是（${oss_dataset_access}） oss://${_paiOssBucket()}/${_paiOssPrefix()}/${instance_name}/ → ${_paiOssMountPath()}`
      : '否'],
    ...(oss_dataset_enabled && (oss_role_arn || oss_options_json)
      ? [['OSS 高级参数', [
          oss_role_arn ? `RoleArn=${oss_role_arn}` : '',
          oss_options_json ? `Options=${oss_options_json}` : '',
        ].filter(Boolean).join('；')]]
      : []),
    ['SSH 访问', enable_ssh ? `启用（内网 IP:22 直连）` : '否'],
    ['自定义启动脚本', start_script || '无'],
  ];
  document.getElementById('pai-preview-body').innerHTML =
    '<div style="border:1px solid var(--g200);border-radius:8px;overflow:hidden">' +
    rows.map((r, i) => `
      <div style="display:flex;padding:8px 12px;font-size:13px;${i % 2 ? 'background:var(--g50)' : ''}">
        <div style="width:110px;color:var(--g500);flex-shrink:0">${esc(r[0])}</div>
        <div style="flex:1;color:var(--g800);word-break:break-all;white-space:pre-wrap">${esc(String(r[1]))}</div>
      </div>`).join('') + '</div>';
  document.getElementById('modal-pai-preview').classList.remove('hidden');
}

function closePaiPreview() {
  document.getElementById('modal-pai-preview').classList.add('hidden');
}

async function submitPaiCreate() {
  if (!_paiPending) return;
  const btn = document.getElementById('pai-confirm-btn');
  btn.disabled = true; btn.textContent = '创建中...';
  const r = await post('/pai/dsw', _paiPending);
  btn.disabled = false; btn.textContent = '确认创建';

  if (!r.ok) {
    // 失败：关预览，错误显示在创建表单上
    closePaiPreview();
    document.getElementById('pai-err').textContent = r.data?.error || '创建失败';
    return;
  }
  toast('DSW 实例创建成功', 'ok');
  _paiPending = null;
  closePaiPreview();
  closePaiCreateModal();
  loadPaiDsw();
}

// ══════════════════════════════════════════════════
// 工作区成员管理
// ══════════════════════════════════════════════════

function _pmRegion() { return document.getElementById('pm-region').value; }
function _pmWsId()   { return document.getElementById('pm-workspace').value; }

async function showPaiMembersModal() {
  document.getElementById('pm-err').textContent = '';
  const regionSel = document.getElementById('pm-region');
  regionSel.innerHTML = PAI_REGIONS.map(r => `<option value="${r}">${r}</option>`).join('');
  document.getElementById('modal-pai-members').classList.remove('hidden');
  onPmRegionChange();
}

function closePaiMembersModal() {
  document.getElementById('modal-pai-members').classList.add('hidden');
}

// 候选用户缓存（用于搜索框过滤）
let _pmCandidates = [];

// 地域变更 → 刷新工作区下拉
async function onPmRegionChange() {
  const sel = document.getElementById('pm-workspace');
  sel.innerHTML = '<option value="">加载中...</option>';
  const r = await get(`/pai/workspaces?region=${encodeURIComponent(_pmRegion())}`);
  if (!r.ok) { sel.innerHTML = '<option value="">加载失败</option>'; return; }
  const items = r.data.items || [];
  if (!items.length) { sel.innerHTML = '<option value="">该地域无工作区</option>'; loadPmWorkspaceData(); return; }
  sel.innerHTML = items.map(w => `<option value="${esc(w.workspaceId)}">${esc(w.workspaceName || w.workspaceId)}</option>`).join('');
  // 默认选中 vast_workspace
  const def = items.find(w => (w.workspaceName || '') === PAI_DEFAULT_WORKSPACE);
  if (def) sel.value = def.workspaceId;
  loadPmWorkspaceData();
}

// 工作区变更 → 同时刷新成员、候选用户、角色清单
function loadPmWorkspaceData() {
  loadPmMembers();
  loadPmRoles();
}

// 加载该 workspace 的可分配角色（内置 + 自定义），渲染为多选 checkbox
async function loadPmRoles() {
  const box = document.getElementById('pm-add-roles');
  const wsId = _pmWsId();
  if (!wsId) { box.innerHTML = '<div style="color:var(--g400);font-size:12px">请先选择工作区</div>'; return; }
  box.innerHTML = '<div style="color:var(--g400);font-size:12px">加载中...</div>';
  const r = await get(`/pai/workspaces/${encodeURIComponent(wsId)}/roles?region=${encodeURIComponent(_pmRegion())}`);
  if (!r.ok) { box.innerHTML = `<div style="color:var(--err,#dc2626);font-size:12px">${esc(r.data?.error || '加载失败')}</div>`; return; }
  const builtin = r.data.builtin || [];
  const custom  = r.data.custom || [];
  const grp = (title, arr) => arr.length ? `
    <div style="font-size:11px;color:var(--g500);font-weight:600;margin:8px 0 6px">${title}</div>
    <div style="display:flex;flex-wrap:wrap;gap:8px">`
    + arr.map(role => `
      <label style="display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border:1.5px solid var(--g200);border-radius:20px;cursor:pointer;font-size:12.5px;background:#fff;transition:.15s"
             onmouseover="this.style.borderColor='var(--primary)'" onmouseout="this.style.borderColor=this.querySelector('input').checked?'var(--primary)':'var(--g200)'">
        <input type="checkbox" class="pm-role-cb" value="${esc(role.value)}" style="width:auto;margin:0"
               onchange="this.closest('label').style.borderColor=this.checked?'var(--primary)':'var(--g200)';this.closest('label').style.background=this.checked?'var(--primary-l)':'#fff'">
        ${esc(role.label)}${role.custom ? '<span style="color:var(--g400);font-size:10.5px">自定义</span>' : ''}
      </label>`).join('') + '</div>' : '';
  box.innerHTML = grp('内置角色', builtin) + grp('自定义角色', custom)
    || '<div style="color:var(--g400);font-size:12px">无可用角色</div>';
}

// 加载成员列表 + 候选用户
async function loadPmMembers() {
  const wsId = _pmWsId();
  const listEl = document.getElementById('pm-members-list');
  const userSel = document.getElementById('pm-add-user');
  if (!wsId) {
    listEl.innerHTML = '<div style="color:var(--g400);font-size:12px;padding:10px">请先选择工作区</div>';
    userSel.innerHTML = '<option value="">选择 RAM 用户</option>';
    return;
  }
  listEl.innerHTML = '<div style="color:var(--g400);font-size:12px;padding:10px">加载中...</div>';

  const region = encodeURIComponent(_pmRegion());
  const [mr, ur] = await Promise.all([
    get(`/pai/workspaces/${encodeURIComponent(wsId)}/members?region=${region}`),
    get(`/pai/workspaces/${encodeURIComponent(wsId)}/candidate-users?region=${region}`),
  ]);

  // 成员列表（用后端映射好的 roleLabels 显示）
  if (!mr.ok) {
    listEl.innerHTML = `<div style="color:var(--err,#dc2626);font-size:12px;padding:10px">${esc(mr.data?.error || '加载失败')}</div>`;
  } else {
    const members = mr.data.items || [];
    listEl.innerHTML = members.length ? members.map(m => {
      const name = m.displayName || m.userId;
      const initial = esc((name || '?').trim().charAt(0).toUpperCase());
      const labels = (m.roleLabels && m.roleLabels.length ? m.roleLabels : m.roles || []);
      const isOwner = (m.roles || []).includes('PAI.WorkspaceOwner');
      const badges = labels.map(l => {
        const cls = /所有者|Owner/.test(l) ? 'badge-warn' : (/管理员|Admin/.test(l) ? 'badge-info' : 'badge-gray');
        return `<span class="badge ${cls}" style="font-size:11px;padding:1px 8px">${esc(l)}</span>`;
      }).join(' ') || '<span style="color:var(--g400);font-size:12px">无角色</span>';
      const delBtn = isOwner
        ? '<span class="badge badge-gray" style="font-size:11px">所有者</span>'
        : `<button class="btn-ghost perm-operate" style="padding:3px 12px;font-size:12px;color:var(--err,#dc2626);border-color:var(--g200)" onclick="pmRemoveMember('${esc(m.memberId)}','${esc(name)}')">移除</button>`;
      return `<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--g100)">
        <div class="avatar" style="width:34px;height:34px;font-size:14px">${initial}</div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;color:var(--g800);font-size:13.5px">${esc(name)}</div>
          <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px">${badges}</div>
        </div>
        ${delBtn}
      </div>`;
    }).join('') : '<div style="color:var(--g400);font-size:12px;padding:16px;text-align:center">该工作区暂无成员</div>';
    const cntEl = document.getElementById('pm-members-count');
    if (cntEl) cntEl.textContent = `共 ${members.length} 人`;
  }

  // 候选用户（排除已是成员的），缓存供搜索框过滤
  if (ur.ok) {
    const memberIds = new Set((mr.data?.items || []).map(m => m.userId));
    _pmCandidates = (ur.data.items || []).filter(u => !memberIds.has(u.userId));
  } else {
    _pmCandidates = [];
  }
  document.getElementById('pm-user-search').value = '';
  _renderPmUserOptions('');
}

// 按关键字渲染候选用户下拉
function _renderPmUserOptions(keyword) {
  const userSel = document.getElementById('pm-add-user');
  const kw = (keyword || '').trim().toLowerCase();
  const filtered = kw
    ? _pmCandidates.filter(u => (u.userName || u.userId).toLowerCase().includes(kw))
    : _pmCandidates;
  userSel.innerHTML = filtered.length
    ? filtered.map(u => `<option value="${esc(u.userId)}">${esc(u.userName || u.userId)}</option>`).join('')
    : '<option value="" disabled>无匹配用户</option>';
}

function onPmUserSearch() {
  _renderPmUserOptions(document.getElementById('pm-user-search').value);
}

async function submitPmAddMember() {
  const errEl = document.getElementById('pm-err');
  errEl.textContent = '';
  const wsId    = _pmWsId();
  const user_id = document.getElementById('pm-add-user').value;
  const roles   = Array.from(document.querySelectorAll('.pm-role-cb:checked')).map(cb => cb.value);
  if (!wsId)          { errEl.textContent = '请选择工作区'; return; }
  if (!user_id)       { errEl.textContent = '请选择 RAM 用户'; return; }
  if (!roles.length)  { errEl.textContent = '请至少选择一个角色'; return; }

  const r = await post(`/pai/workspaces/${encodeURIComponent(wsId)}/members`, {
    region: _pmRegion(), user_id, roles,
  });
  if (!r.ok) { errEl.textContent = r.data?.error || '添加失败'; return; }
  toast('成员添加成功', 'ok');
  loadPmMembers();
}

async function pmRemoveMember(memberId, name) {
  if (!confirm(`确定将成员「${name}」移出该工作区？移出后其在此工作区的资源访问权限将被回收。`)) return;
  const r = await del(`/pai/workspaces/${encodeURIComponent(_pmWsId())}/members/${encodeURIComponent(memberId)}?region=${encodeURIComponent(_pmRegion())}`);
  if (!r.ok) { toast(r.data?.error || '移除失败', 'err'); return; }
  toast('成员已移除', 'ok');
  loadPmMembers();
}

async function pmRemoveMember(memberId, name) {
  if (!confirm(`确定将成员「${name}」移出该工作区？移出后其在此工作区的资源访问权限将被回收。`)) return;
  const r = await del(`/pai/workspaces/${encodeURIComponent(_pmWsId())}/members/${encodeURIComponent(memberId)}?region=${encodeURIComponent(_pmRegion())}`);
  if (!r.ok) { toast(r.data?.error || '移除失败', 'err'); return; }
  toast('成员已移除', 'ok');
  loadPmMembers();
}
