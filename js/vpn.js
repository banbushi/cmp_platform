// ─────────────────────────────────────────
// VPN 客户端
// ─────────────────────────────────────────
let _vpnFilter   = 'all';
let _vpnAllItems = [], _vpnFiltered = [];
let _vpnPage = 1, _vpnPageSize = 20;
let _vpnCreateServers = [];
const VPN_SEARCH_FIELDS = ['client_name', 'server_name', 'region'];

async function loadVpnClients() {
  const wrap = document.getElementById('vpn-clients-table-wrap');
  const loading = document.getElementById('vpn-clients-loading');
  loading.classList.remove('hidden');
  wrap.innerHTML = '';
  const r = await get('/vpn/clients');
  loading.classList.add('hidden');
  if (!r.ok) { wrap.innerHTML = `<div class="empty-tip" style="color:var(--danger)">加载失败: ${esc(r.data?.error || '')}</div>`; return; }
  _vpnAllItems = r.data.clients || [];
  _vpnPage = 1;
  _filterVpnClients();
}

function setVpnFilter(plat, el) {
  _vpnFilter = plat;
  document.querySelectorAll('#sec-vpn-clients .filter-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _vpnPage = 1;
  _filterVpnClients();
}

function _filterVpnClients() {
  const keyword = (document.getElementById('vpn-keyword')?.value || '').trim().toLowerCase();
  const col     = document.getElementById('vpn-search-col')?.value || 'all';
  _vpnFiltered  = _vpnAllItems.filter(item => {
    if (_vpnFilter !== 'all' && item.platform !== _vpnFilter) return false;
    if (!keyword) return true;
    const fields = col === 'all' ? VPN_SEARCH_FIELDS : [col];
    return fields.some(f => String(item[f] || '').toLowerCase().includes(keyword));
  });
  _renderVpnPage();
}

function _renderVpnPage() {
  const wrap  = document.getElementById('vpn-clients-table-wrap');
  const total = _vpnFiltered.length;
  const start = (_vpnPage - 1) * _vpnPageSize;
  const pageItems = _vpnFiltered.slice(start, start + _vpnPageSize);

  if (!pageItems.length) {
    wrap.innerHTML = `<div class="empty-tip">暂无 VPN 客户端记录</div>`;
    return;
  }

  const rows = pageItems.map(c => `<tr>
    <td>${_platPill(c.platform)}</td>
    <td>${esc(c.server_name || c.server_id || '-')}</td>
    <td>${esc(c.client_name || '-')}</td>
    <td style="color:var(--g600);font-size:12px">${esc(c.region || '-')}</td>
    <td style="color:var(--g500);font-size:12px">${esc(c.notes || '-')}</td>
    <td style="color:var(--g500);font-size:12px">${esc((c.created_at || '').toString().slice(0,19).replace('T',' '))}</td>
    <td class="perm-operate">
      <div class="action-dropdown">
        <button class="action-menu-btn" onclick="toggleVpnActionMenu(event, '${esc(c.id)}')">⋮</button>
        <div class="action-menu" id="vpn-action-${esc(c.id)}">
          ${c.platform === 'baidu' ? `<div class="action-item" onclick="editVpnClientName('${esc(c.id)}','${esc(c.client_name||'')}')">编辑名称</div>` : ''}
          <div class="action-item" onclick="editVpnNotes('${esc(c.id)}','${esc(c.notes||'')}')">编辑备注</div>
          <div class="action-item danger" onclick="deleteVpnClient('${esc(c.id)}')">删除</div>
        </div>
      </div>
    </td>
  </tr>`).join('');

  wrap.innerHTML = `
    <div class="sync-table-container"><table class="sync-table" style="min-width:900px">
      <thead><tr><th style="width:80px">云平台</th><th style="width:180px">VPN 服务器</th><th style="width:160px">客户端名 / 用户名</th><th style="width:120px">地域</th><th>备注</th><th style="width:140px;white-space:nowrap">创建时间</th><th style="width:50px"></th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${_buildPagination(total, _vpnPage, _vpnPageSize, '_goVpnPage', '_setVpnPageSize')}`;
}

function _goVpnPage(n) {
  const maxPage = Math.ceil(_vpnFiltered.length / _vpnPageSize) || 1;
  _vpnPage = Math.max(1, Math.min(n, maxPage));
  _renderVpnPage();
}

function _setVpnPageSize(size) {
  _vpnPageSize = parseInt(size);
  _vpnPage = 1;
  _renderVpnPage();
}

async function syncVpnClients(platform) {
  if (!platform || platform === 'all') {
    alert('请选择具体的云平台进行同步');
    return;
  }
  const loading = document.getElementById('vpn-clients-loading');
  if (!loading) return;
  loading.innerHTML = '<div class="spin"></div> 正在从云端同步 VPN 客户端，可能需要一些时间...';
  loading.classList.remove('hidden');
  try {
    const r = await post(`/vpn/sync/${platform}`);
    loading.classList.add('hidden');
    if (!r.ok) {
      toast(`同步失败: ${r.data?.error || '未知错误'}`, 'err');
      return;
    }
    toast(r.data.message || `同步完成！共同步 ${(r.data.results || []).length} 个 VPN 客户端`, 'ok');
    loadVpnClients();
  } catch (e) {
    loading.classList.add('hidden');
    toast(`同步异常: ${e.message || '网络错误'}`, 'err');
  }
}

function showVpnCreateModal() {
  document.querySelectorAll('input[name="vc-platform"]').forEach(r => r.checked = false);
  document.getElementById('vc-region').innerHTML = '<option value="">请先选择云平台</option>';
  document.getElementById('vc-region').disabled = true;
  document.getElementById('vc-server').innerHTML = '<option value="">请先选择云平台</option>';
  document.getElementById('vc-server').disabled = true;
  document.getElementById('vc-name').value = '';
  document.getElementById('vc-password').value = '';
  document.getElementById('vc-notes').value = '';
  document.getElementById('vc-password-wrap').classList.add('hidden');
  document.getElementById('vc-name-label').innerHTML = '名称 <span class="req">*</span>';
  document.getElementById('vc-err').textContent = '';
  document.getElementById('vc-submit-btn').disabled = false;
  _vpnCreateServers = [];
  document.getElementById('modal-vpn-create').classList.remove('hidden');
}

function closeVpnCreateModal() {
  document.getElementById('modal-vpn-create').classList.add('hidden');
}

async function onVpnPlatformChange() {
  const plat = document.querySelector('input[name="vc-platform"]:checked')?.value;
  if (!plat) return;

  const isBaidu = plat === 'baidu';
  document.getElementById('vc-password-wrap').classList.toggle('hidden', !isBaidu);
  document.getElementById('vc-name-label').innerHTML = (isBaidu ? '用户名' : '证书名称') + ' <span class="req">*</span>';
  document.getElementById('vc-err').textContent = '';

  const regionSel = document.getElementById('vc-region');
  const serverSel = document.getElementById('vc-server');
  regionSel.disabled = true;
  regionSel.innerHTML = '<option value="">正在加载...</option>';
  serverSel.disabled = true;
  serverSel.innerHTML = '<option value="">请先选择地域</option>';
  _vpnCreateServers = [];

  const r = await get(`/vpn/servers?platform=${plat}`);
  if (!r.ok) {
    regionSel.innerHTML = `<option value="">加载失败: ${esc(r.data?.error || '未知错误')}</option>`;
    serverSel.innerHTML = '<option value="">请先选择地域</option>';
    document.getElementById('vc-err').textContent = r.data?.error || '拉取 VPN 服务器失败';
    return;
  }

  const servers = r.data.servers || [];
  if (!servers.length) {
    regionSel.innerHTML = '<option value="">未发现可用地域（该账号下暂无 SSL VPN 服务器）</option>';
    serverSel.innerHTML = '<option value="">暂无 SSL VPN 服务器</option>';
    return;
  }

  _vpnCreateServers = servers;
  const regions = [...new Set(servers.map(s => String(s.region || '').trim()).filter(Boolean))];
  if (!regions.length) {
    regionSel.innerHTML = '<option value="__all__">默认地域</option>';
    regionSel.disabled = false;
    regionSel.value = '__all__';
    onVpnRegionChange();
    return;
  }

  regionSel.innerHTML = '<option value="">请选择地域</option>' +
    regions.map(region => `<option value="${esc(region)}">${esc(region)}</option>`).join('');
  regionSel.disabled = false;
}

function onVpnRegionChange() {
  const region = document.getElementById('vc-region').value;
  const sel = document.getElementById('vc-server');
  sel.disabled = true;

  if (!region) {
    sel.innerHTML = '<option value="">请先选择地域</option>';
    return;
  }

  const servers = region === '__all__'
    ? _vpnCreateServers
    : _vpnCreateServers.filter(s => String(s.region || '').trim() === region);

  if (!servers.length) {
    sel.innerHTML = '<option value="">该地域暂无 SSL VPN 服务器</option>';
    return;
  }

  sel.innerHTML = '<option value="">请选择服务器</option>' +
    servers.map(s => `<option value="${esc(s.id)}" data-name="${esc(s.name)}" data-region="${esc(s.region || '')}">${esc(s.name)}</option>`).join('');
  sel.disabled = false;
}

async function editVpnClientName(id, current) {
  const clientName = prompt('请输入客户端名称（将同步到百度云 clientName 字段）：', current);
  if (clientName === null) return; // 取消
  const r = await put(`/vpn/clients/${id}`, { clientName: clientName.trim() });
  if (!r.ok) { toast(r.data?.error || '更新失败', 'err'); return; }
  toast('客户端名称已更新', 'ok');
  loadVpnClients();
}

async function editVpnNotes(id, current) {
  const notes = prompt('请输入备注（留空则清除）：', current);
  if (notes === null) return; // 取消
  const r = await put(`/vpn/clients/${id}`, { notes: notes.trim() });
  if (!r.ok) { toast(r.data?.error || '更新失败', 'err'); return; }
  toast('备注已更新', 'ok');
  loadVpnClients();
}

async function deleteVpnClient(id) {
  if (!confirm('确认删除该 VPN 客户端？将同时尝试从云平台删除。')) return;
  const r = await del(`/vpn/clients/${id}`);
  if (!r.ok) { toast(r.data?.error || '删除失败', 'err'); return; }
  toast('删除成功', 'ok');
  loadVpnClients();
}

function toggleVpnActionMenu(e, id) {
  e.stopPropagation();
  document.querySelectorAll('.action-menu.show').forEach(m => {
    if (m.id !== `vpn-action-${id}`) m.classList.remove('show');
  });
  const menu = document.getElementById(`vpn-action-${id}`);
  menu.classList.toggle('show');
}

document.addEventListener('click', () => {
  document.querySelectorAll('.action-menu.show').forEach(m => m.classList.remove('show'));
});

async function submitVpnCreate() {
  const plat       = document.querySelector('input[name="vc-platform"]:checked')?.value;
  const regionSel  = document.getElementById('vc-region');
  const region     = regionSel.value;
  const serverSel  = document.getElementById('vc-server');
  const serverId   = serverSel.value;
  const serverName = serverSel.selectedOptions[0]?.dataset?.name || '';
  const serverRegion = serverSel.selectedOptions[0]?.dataset?.region || '';
  const clientName = document.getElementById('vc-name').value.trim();
  const password   = document.getElementById('vc-password').value;
  const notes      = document.getElementById('vc-notes').value.trim();
  const errEl      = document.getElementById('vc-err');
  errEl.textContent = '';

  if (!plat)        { errEl.textContent = '请选择云平台'; return; }
  if (!region)      { errEl.textContent = '请选择地域'; return; }
  if (!serverId)    { errEl.textContent = '请选择 SSL VPN 服务器'; return; }
  if (!clientName)  { errEl.textContent = '请填写名称'; return; }
  if (plat === 'baidu' && !password) { errEl.textContent = '请填写密码'; return; }

  const btn = document.getElementById('vc-submit-btn');
  btn.disabled = true;
  const r = await post('/vpn/clients', {
    platform: plat,
    serverId,
    serverName,
    clientName,
    password,
    region: region === '__all__' ? (serverRegion || undefined) : region,
    notes: notes || undefined
  });
  btn.disabled = false;

  if (!r.ok) { errEl.textContent = r.data?.error || '创建失败'; return; }
  toast('VPN 客户端创建成功', 'ok');
  closeVpnCreateModal();
  loadVpnClients();
}

// ── Logo 管理 ──
function initLogo() {
  const saved = localStorage.getItem('platform_logo');
  _applyLogo(saved || null);
}

function _applyLogo(dataUrl) {
  const sideImg  = document.getElementById('sidebar-logo-img');
  const sideSvg  = document.getElementById('sidebar-logo-default');
  const prevImg  = document.getElementById('logo-preview-img');
  const prevSvg  = document.getElementById('logo-preview-default');
  const removeBtn = document.getElementById('logo-remove-btn');

  if (dataUrl) {
    sideImg.src = dataUrl; sideImg.style.display = '';
    sideSvg.style.display = 'none';
    if (prevImg)  { prevImg.src = dataUrl; prevImg.style.display = ''; }
    if (prevSvg)  prevSvg.style.display = 'none';
    if (removeBtn) removeBtn.style.display = '';
  } else {
    sideImg.src = ''; sideImg.style.display = 'none';
    sideSvg.style.display = '';
    if (prevImg)  prevImg.style.display = 'none';
    if (prevSvg)  prevSvg.style.display = '';
    if (removeBtn) removeBtn.style.display = 'none';
  }
}

function handleLogoUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    localStorage.setItem('platform_logo', e.target.result);
    _applyLogo(e.target.result);
    toast('Logo 已更新', 'ok');
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function removeLogo() {
  localStorage.removeItem('platform_logo');
  _applyLogo(null);
  toast('已恢复默认 Logo', 'ok');
}

// ══════════════════════════════════════════════════
