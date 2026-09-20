// ─────────────────────────────────────────
// 存储资源（磁盘）
// ─────────────────────────────────────────

// ─────────────────────────────────────────
// 存储资源（磁盘）
// ─────────────────────────────────────────
let _diskFilter   = 'all';
let _diskAllItems = [];
let _diskFiltered = [];
let _diskPage     = 1;
let _diskPageSize = 20;

const DISK_SEARCH_FIELDS = ['disk_id', 'disk_name', 'instance_id', 'region'];

function setDiskFilter(plat, el) {
  _diskFilter = plat;
  document.querySelectorAll('#sec-disks .filter-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  _diskPage = 1;
  _filterDisks();
}

async function loadDisks() {
  const r = await get('/storage/disks');
  const wrap = document.getElementById('disks-table-wrap');
  if (!r.ok) { wrap.innerHTML = `<div class="empty-tip">加载失败: ${esc(r.data?.error || '')}</div>`; return; }
  _diskAllItems = r.data.disks || [];
  _diskPage = 1;
  _filterDisks();
}

function _filterDisks() {
  const col     = document.getElementById('disk-search-col')?.value || 'all';
  const keyword = document.getElementById('disk-keyword')?.value.trim().toLowerCase() || '';
  let items = _diskFilter === 'all' ? _diskAllItems : _diskAllItems.filter(d => d.platform === _diskFilter);
  if (keyword) {
    items = items.filter(d => {
      const targets = col === 'all' ? DISK_SEARCH_FIELDS : [col];
      return targets.some(f => String(d[f] || '').toLowerCase().includes(keyword));
    });
  }
  _diskFiltered = items;
  _renderDisksPage();
}

function _renderDisksPage() {
  const wrap = document.getElementById('disks-table-wrap');
  if (!wrap) return;
  const total     = _diskFiltered.length;
  const start     = (_diskPage - 1) * _diskPageSize;
  const pageItems = _diskFiltered.slice(start, start + _diskPageSize);

  const STATUS_TAG = { available: 'tag-user', 'in-use': 'tag-dev', creating: 'tag-ops', deleting: 'tag-ops', deleted: 'tag-admin' };

  if (!total) {
    wrap.innerHTML = `<div class="empty-tip">暂无磁盘数据，请点击右上角「同步」从云平台拉取</div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="sync-table-container"><table class="sync-table" style="min-width:1050px">
      <thead><tr>
        <th style="width:80px">云平台</th><th style="width:180px">磁盘 ID</th><th style="width:140px">名称</th><th style="width:90px">状态</th><th style="width:90px">大小 (GB)</th><th style="width:100px">类型</th><th style="width:120px">可用区</th><th style="width:180px">挂载实例</th><th style="width:120px">地域</th>
      </tr></thead>
      <tbody>
        ${pageItems.map(d => `<tr>
          <td>${_platPill(d.platform)}</td>
          <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(d.disk_id)}"><code style="font-size:12px">${esc(d.disk_id)}</code></td>
          <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(d.disk_name||'')}">${esc(d.disk_name || '-')}</td>
          <td><span class="tag ${STATUS_TAG[d.status] || 'tag-user'}">${esc(d.status || '-')}</span></td>
          <td>${d.size_gb || 0}</td>
          <td>${esc(d.disk_type || '-')}</td>
          <td style="white-space:nowrap">${esc(d.zone || '-')}</td>
          <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(d.instance_id||'')}">${d.instance_id ? `<code style="font-size:12px">${esc(d.instance_id)}</code>` : '<span style="color:var(--g400)">未挂载</span>'}</td>
          <td style="white-space:nowrap">${esc(d.region || '-')}</td>
        </tr>`).join('')}
      </tbody>
    </table></div>
    ${_buildPagination(total, _diskPage, _diskPageSize, '_goDiskPage', '_setDiskPageSize')}`;
}

function _goDiskPage(n) {
  const maxPage = Math.ceil(_diskFiltered.length / _diskPageSize) || 1;
  _diskPage = Math.max(1, Math.min(n, maxPage));
  _renderDisksPage();
}

function _setDiskPageSize(size) {
  _diskPageSize = parseInt(size);
  _diskPage = 1;
  _renderDisksPage();
}

async function syncDisks(platform) {
  const loadingEl = document.getElementById('disks-loading');
  const btns = document.querySelectorAll('#sec-disks .perm-operate button');
  loadingEl.classList.remove('hidden');
  btns.forEach(b => b.disabled = true);

  const r = await post(`/storage/sync/${platform}`, {});
  loadingEl.classList.add('hidden');
  btns.forEach(b => b.disabled = false);

  if (!r.ok) { toast('同步失败: ' + (r.data?.error || ''), 'err'); return; }
  const results = r.data.results || [];
  const msg = results.map(res => `${res.platform}: ${res.success ? `同步 ${res.count} 条` : res.message}`).join('  ');
  toast(msg || '同步完成', 'ok');
  loadDisks();
}

// ─────────────────────────────────────────
