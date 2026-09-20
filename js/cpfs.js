// ══════════════════════════════════════════════════
// CPFS 存储（fileset 列表 + 配额）
// ══════════════════════════════════════════════════

let _cpfsAll = [], _cpfsFiltered = [];
let _cpfsPage = 1, _cpfsPageSize = 20;
let _cpfsPlatform = 'aliyun';
// 阿里云两层视图：'fs' 文件系统列表 / 'fileset' 某文件系统下的 fileset
let _cpfsView = 'fs';
let _cpfsCurrentFs = null;   // 当前进入的文件系统 {id, name}

function setCpfsPlatform(p, el) {
  _cpfsPlatform = p;
  _cpfsView = 'fs';
  _cpfsCurrentFs = null;
  document.querySelectorAll('#sec-cpfs .filter-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  loadCpfs();
}

async function loadCpfs() {
  const wrap = document.getElementById('cpfs-table-wrap');
  const loading = document.getElementById('cpfs-loading');
  const sub = document.getElementById('cpfs-fs-sub');

  // AWS FSx 尚未接入
  if (_cpfsPlatform === 'aws') {
    _cpfsAll = [];
    wrap.innerHTML = '<div class="empty-tip">AWS FSx 尚未接入，敬请期待</div>';
    if (sub) sub.textContent = '管理各云平台并行文件存储（阿里云 CPFS / AWS FSx / 百度云 CFS）';
    return;
  }

  loading.classList.remove('hidden');
  wrap.innerHTML = '';

  // 阿里云：文件系统列表(fs) 或 进入某文件系统看 fileset(fileset)；百度：直接文件系统列表
  let url;
  if (_cpfsPlatform === 'baidu') url = '/pai/baidu-cfs';
  else if (_cpfsView === 'fileset') url = `/pai/filesets?fs=${encodeURIComponent(_cpfsCurrentFs.id)}`;
  else url = '/pai/cpfs-filesystems';

  const r = await get(url);
  loading.classList.add('hidden');
  if (!r.ok) { wrap.innerHTML = `<div class="empty-tip">加载失败: ${esc(r.data?.error || '')}</div>`; return; }
  _cpfsAll = r.data.items || [];
  if (sub) {
    if (_cpfsPlatform === 'baidu') sub.textContent = `百度云 CFS 文件存储（共 ${_cpfsAll.length} 个）`;
    else if (_cpfsView === 'fileset') sub.textContent = `阿里云 CPFS · ${_cpfsCurrentFs.name}（共 ${_cpfsAll.length} 个 fileset）`;
    else sub.textContent = `阿里云 CPFS 文件系统（共 ${_cpfsAll.length} 个）`;
  }
  _cpfsPage = 1;
  _filterCpfs();
}

// 进入某个 CPFS 文件系统，查看其 fileset
function enterCpfsFs(id, name) {
  _cpfsCurrentFs = { id, name };
  _cpfsView = 'fileset';
  const kw = document.getElementById('cpfs-keyword'); if (kw) kw.value = '';
  loadCpfs();
}
// 返回文件系统列表
function backToCpfsFs() {
  _cpfsView = 'fs';
  _cpfsCurrentFs = null;
  const kw = document.getElementById('cpfs-keyword'); if (kw) kw.value = '';
  loadCpfs();
}

function _filterCpfs() {
  const kw = (document.getElementById('cpfs-keyword')?.value || '').trim().toLowerCase();
  _cpfsFiltered = _cpfsAll.filter(f =>
    !kw || (f.name || '').toLowerCase().includes(kw)
        || (f.path || '').toLowerCase().includes(kw)
        || (f.fsId || '').toLowerCase().includes(kw));
  _cpfsPage = 1;
  _renderCpfsPage();
}

// 用量进度条
function _cpfsUsageBar(usedGiB, limitGiB) {
  if (!limitGiB) return '<span style="color:var(--g400);font-size:12px">未限额</span>';
  const pct = Math.min(100, Math.round((usedGiB / limitGiB) * 100));
  const color = pct >= 90 ? 'var(--err,#dc2626)' : (pct >= 70 ? 'var(--warn,#d97706)' : 'var(--primary)');
  return `<div style="display:flex;align-items:center;gap:8px">
    <div style="flex:1;height:6px;background:var(--g100);border-radius:3px;overflow:hidden;min-width:60px">
      <div style="width:${pct}%;height:100%;background:${color}"></div>
    </div>
    <span style="font-size:11.5px;color:var(--g500);white-space:nowrap">${usedGiB} / ${limitGiB} GiB</span>
  </div>`;
}

function _cpfsStatusPill(status) {
  const s = (status || '').toLowerCase();
  const color = s === 'created' ? 'var(--ok,#16a34a)' : (s.includes('delet') ? 'var(--err,#dc2626)' : 'var(--g500)');
  return `<span style="color:${color};font-weight:500;font-size:12px">${esc(status || '-')}</span>`;
}

function _renderCpfsPage() {
  const wrap = document.getElementById('cpfs-table-wrap');
  const total = _cpfsFiltered.length;
  const start = (_cpfsPage - 1) * _cpfsPageSize;
  const pageItems = _cpfsFiltered.slice(start, start + _cpfsPageSize);

  // fileset 视图顶部的返回条（即使无数据也要能返回）
  const backBar = (_cpfsPlatform === 'aliyun' && _cpfsView === 'fileset')
    ? `<div style="padding:10px 14px;border-bottom:1px solid var(--g100)">
         <a onclick="backToCpfsFs()" style="cursor:pointer;color:var(--primary);font-size:13px">‹ 返回文件系统列表</a>
         <span style="color:var(--g500);font-size:13px;margin-left:8px">${esc(_cpfsCurrentFs ? _cpfsCurrentFs.name : '')}</span>
       </div>` : '';

  if (!pageItems.length) {
    wrap.innerHTML = backBar + '<div class="empty-tip">暂无数据</div>';
    return;
  }

  let table;
  if (_cpfsPlatform === 'baidu') table = _renderBaiduRows(pageItems);
  else if (_cpfsView === 'fileset') table = _renderAliyunRows(pageItems);
  else table = _renderCpfsFsRows(pageItems);
  wrap.innerHTML = backBar + table + _buildPagination(total, _cpfsPage, _cpfsPageSize, '_goCpfsPage', '_setCpfsPageSize');
}

// 阿里云 CPFS 文件系统（实例）列表 —— 点击进入看 fileset
function _renderCpfsFsRows(pageItems) {
  const rows = pageItems.map(f => `<tr style="cursor:pointer" onclick="enterCpfsFs('${esc(f.fileSystemId)}','${esc((f.name||'').replace(/'/g,''))}')">
      <td><strong style="color:var(--primary)">${esc(f.name || f.fileSystemId)}</strong><div style="color:var(--g400);font-size:11px;font-family:monospace">${esc(f.fileSystemId)}</div></td>
      <td>${_cpfsStatusPill(f.status)}</td>
      <td style="color:var(--g600);font-size:12px">${esc((f.protocol||'-').toUpperCase())}${f.storageType ? ' / ' + esc(f.storageType) : ''}</td>
      <td style="min-width:200px">${_cpfsUsageBar(f.usedGiB, f.capacityGiB)}</td>
      <td style="color:var(--g500);font-size:12px">${esc(f.zoneId || '-')}</td>
      <td style="text-align:right"><span style="color:var(--primary);font-size:13px">查看 fileset ›</span></td>
    </tr>`).join('');
  return `<div class="sync-table-container"><table class="sync-table" style="min-width:820px">
      <thead><tr>
        <th>文件系统名称 / ID</th><th style="width:90px">状态</th><th style="width:140px">协议/类型</th>
        <th style="width:210px">容量用量</th><th style="width:100px">可用区</th><th style="width:110px"></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// 阿里云 CPFS fileset 表格
function _renderAliyunRows(pageItems) {
  const rows = pageItems.map(f => {
    const files = f.fileCountLimit
      ? `${(f.fileCountUsage || 0).toLocaleString()} / ${f.fileCountLimit.toLocaleString()}`
      : `${(f.fileCountUsage || 0).toLocaleString()} / 未限`;
    const prot = f.deletionProtection
      ? '<span class="badge badge-info" style="font-size:11px;padding:1px 8px">已开启</span>'
      : '<span class="badge badge-gray" style="font-size:11px;padding:1px 8px">关闭</span>';
    return `<tr>
      <td><strong>${esc(f.name || '(未命名)')}</strong><div style="color:var(--g400);font-size:11px;font-family:monospace">${esc(f.path || '')}</div></td>
      <td>${_cpfsStatusPill(f.status)}</td>
      <td style="min-width:180px">${_cpfsUsageBar(f.usedGiB, f.sizeLimitGiB)}</td>
      <td style="color:var(--g600);font-size:12px">${esc(files)}</td>
      <td>${prot}</td>
      <td style="color:var(--g500);font-size:12px">${esc(f.createTime || '-')}</td>
    </tr>`;
  }).join('');
  return `<div class="sync-table-container"><table class="sync-table" style="min-width:900px">
      <thead><tr>
        <th>名称 / 路径</th><th style="width:90px">状态</th><th style="width:200px">容量用量</th>
        <th style="width:150px">文件数(已用/上限)</th><th style="width:90px">删除保护</th><th style="width:160px">创建时间</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

// 百度云 CFS 文件系统表格
function _renderBaiduRows(pageItems) {
  const rows = pageItems.map(f => {
    const ips = (f.mountIps || []).length
      ? f.mountIps.map(ip => `<div style="font-family:monospace;font-size:11.5px">${esc(ip)}</div>`).join('')
      : '<span style="color:var(--g400)">-</span>';
    return `<tr>
      <td><strong>${esc(f.name || '(未命名)')}</strong><div style="color:var(--g400);font-size:11px;font-family:monospace">${esc(f.fsId || '')}</div></td>
      <td>${_cpfsStatusPill(f.status)}</td>
      <td style="color:var(--g600);font-size:12px">${esc((f.type || '-').toUpperCase())} / ${esc(f.protocol || '-')}</td>
      <td style="color:var(--g600);font-size:12px">${esc(String(f.usedGiB))} GiB</td>
      <td>${ips}</td>
      <td style="color:var(--g500);font-size:12px">${esc(f.zone || '-')}</td>
      <td style="color:var(--g500);font-size:12px">${esc((f.createTime || '-').replace('T',' ').replace('Z',''))}</td>
    </tr>`;
  }).join('');
  return `<div class="sync-table-container"><table class="sync-table" style="min-width:900px">
      <thead><tr>
        <th>名称 / ID</th><th style="width:90px">状态</th><th style="width:130px">类型/协议</th>
        <th style="width:100px">已用容量</th><th style="width:150px">挂载 IP</th><th style="width:90px">可用区</th><th style="width:160px">创建时间</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function _goCpfsPage(n) {
  const maxPage = Math.ceil(_cpfsFiltered.length / _cpfsPageSize) || 1;
  _cpfsPage = Math.max(1, Math.min(n, maxPage));
  _renderCpfsPage();
}
function _setCpfsPageSize(size) { _cpfsPageSize = parseInt(size); _cpfsPage = 1; _renderCpfsPage(); }
