// ─────────────────────────────────────────
// 网络资源（安全组 / VPC / 子网）
// ─────────────────────────────────────────
const netFilter = { sg: 'all', vpc: 'all', subnet: 'all', cert: 'all', dns: 'all' };
const _netData     = { sg: [],   vpc: [],   subnet: [],   cert: [],   dns: []  };
const _netFiltered = { sg: [],   vpc: [],   subnet: [],   cert: [],   dns: []  };
const _netPage     = { sg: 1,    vpc: 1,    subnet: 1,    cert: 1,    dns: 1   };
const _netPageSize = { sg: 20,   vpc: 20,   subnet: 20,   cert: 20,   dns: 20  };
// SSL 证书「过期时间」列排序方向：null=未排序 / 'asc'=最早在前 / 'desc'=最晚在前
let _certExpSort = null;
// SSL 证书「即将过期」筛选窗口：null=不筛选 / 30=30天内 / 60=60天内（含已过期不算，只看未来 N 天内）
let _certExpiringDays = null;

const NET_SEARCH_FIELDS = {
  sg:     ['sg_id', 'sg_name', 'description', 'region'],
  vpc:    ['vpc_id', 'vpc_name', 'description', 'cidr', 'region'],
  subnet: ['subnet_id', 'subnet_name', 'vpc_id', 'cidr', 'zone'],
  cert:   ['domain', 'cert_name', 'status', 'region'],
  dns:    ['zone_name', 'record_name', 'record_type', 'record_value'],
};

const NET_CFG = {
  sg: {
    api:      '/sync/security-groups',
    syncApi:  (p) => `/sync/security-groups/${p}`,
    loading:  'sg-loading',
    wrap:     'sg-table-wrap',
    resultKey:'security_groups',
    label:    '安全组',
  },
  vpc: {
    api:      '/sync/vpcs',
    syncApi:  (p) => `/sync/vpcs/${p}`,
    loading:  'vpc-loading',
    wrap:     'vpc-table-wrap',
    resultKey:'vpcs',
    label:    'VPC',
  },
  subnet: {
    api:      '/sync/subnets',
    syncApi:  (p) => `/sync/subnets/${p}`,
    loading:  'subnet-loading',
    wrap:     'subnet-table-wrap',
    resultKey:'subnets',
    label:    '子网',
  },
  cert: {
    api:      '/sync/certs',
    syncApi:  (p) => `/sync/certs/${p}`,
    loading:  'cert-loading',
    wrap:     'cert-table-wrap',
    resultKey:'certs',
    label:    'SSL证书',
  },
  dns: {
    api:      '/sync/dns-records',
    syncApi:  (p) => `/sync/dns-records/${p}`,
    loading:  'dns-loading',
    wrap:     'dns-table-wrap',
    resultKey:'records',
    label:    'DNS记录',
  },
};


async function _loadNetPage(type) {
  const cfg = NET_CFG[type];
  const platform = netFilter[type] === 'all' ? '' : netFilter[type];
  const params = platform ? `?platform=${platform}` : '';
  const r = await get(`${cfg.api}${params}`);
  if (!r.ok) return;
  _netData[type] = r.data[cfg.resultKey] || [];
  _netPage[type] = 1;
  _filterAndRenderNet(type);
}

// 客户端过滤 + 渲染
function _filterAndRenderNet(type) {
  const col     = document.getElementById(`${type}-search-col`)?.value || 'all';
  const keyword = document.getElementById(`${type}-keyword`)?.value.trim().toLowerCase() || '';
  const fields  = NET_SEARCH_FIELDS[type];
  _netFiltered[type] = keyword
    ? _netData[type].filter(r => {
        const targets = col === 'all' ? fields : [col];
        return targets.some(f => String(r[f] || '').toLowerCase().includes(keyword));
      })
    : [..._netData[type]];
  // SSL 证书：仅看 N 天内即将过期（未来 N 天内，不含已过期）
  if (type === 'cert' && _certExpiringDays) {
    const now = Date.now();
    _netFiltered[type] = _netFiltered[type].filter(r => {
      if (!r.expires_at) return false;
      const days = Math.ceil((new Date(r.expires_at).getTime() - now) / 86400000);
      return days >= 0 && days < _certExpiringDays;
    });
  }
  // SSL 证书：按过期时间排序
  if (type === 'cert' && _certExpSort) {
    const dir = _certExpSort === 'asc' ? 1 : -1;
    _netFiltered[type].sort((a, b) => {
      const ta = a.expires_at ? new Date(a.expires_at).getTime() : Infinity;
      const tb = b.expires_at ? new Date(b.expires_at).getTime() : Infinity;
      return (ta - tb) * dir;
    });
  }
  _renderNetTable(type);
}

function onNetSearch(type) { _netPage[type] = 1; _filterAndRenderNet(type); }

// SSL 证书「过期时间」列排序：点击在 未排序 → 最早在前 → 最晚在前 之间循环
function _toggleCertExpSort() {
  _certExpSort = _certExpSort === null ? 'asc' : _certExpSort === 'asc' ? 'desc' : null;
  _netPage.cert = 1;
  _filterAndRenderNet('cert');
}

// SSL 证书「N 天内过期」筛选按钮：再次点击同一按钮取消；30/60 互斥
function toggleCertExpiringOnly(btn, days) {
  _certExpiringDays = (_certExpiringDays === days) ? null : days;
  // 更新两个按钮高亮
  const sec = btn.closest('section') || document;
  sec.querySelectorAll('.cert-expiring-btn').forEach(b => {
    b.classList.toggle('active', _certExpiringDays !== null && Number(b.dataset.days) === _certExpiringDays);
  });
  _netPage.cert = 1;
  _filterAndRenderNet('cert');
}

function _renderNetTable(type) {
  const wrap = document.getElementById(NET_CFG[type].wrap);
  const total = _netFiltered[type].length;
  if (!total) {
    wrap.innerHTML = `<div class="empty-tip">暂无数据，请点击右上角「同步」从云平台拉取</div>`;
    return;
  }
  const pageSize = _netPageSize[type];
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (_netPage[type] > totalPages) _netPage[type] = totalPages;
  const start = (_netPage[type] - 1) * pageSize;
  const rows  = _netFiltered[type].slice(start, start + pageSize);

  let head, rowsFn, minWidth;
  if (type === 'sg') {
    minWidth = '960px';
    head = '<th style="width:80px">云平台</th><th style="width:130px">地域</th><th style="width:200px">安全组 ID</th><th style="width:200px">名称</th><th>描述</th><th style="width:120px;white-space:nowrap">同步时间</th>';
    rowsFn = r => `<td>${_platPill(r.platform)}</td>
      <td style="color:var(--g600);white-space:nowrap">${esc(r.region||'')}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.sg_id)}"><code style="font-size:12px">${esc(r.sg_id)}</code></td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.sg_name||'')}"><strong>${esc(r.sg_name||'')}</strong></td>
      <td style="color:var(--g600);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.description||'')}">${esc(r.description||'-')}</td>
      <td style="white-space:nowrap">${_syncTime(r.synced_at)}</td>`;
  } else if (type === 'vpc') {
    minWidth = '1000px';
    head = '<th style="width:80px">云平台</th><th style="width:130px">地域</th><th style="width:200px">VPC ID</th><th style="width:160px">名称</th><th style="width:140px">CIDR</th><th>描述</th><th style="width:120px;white-space:nowrap">同步时间</th>';
    rowsFn = r => `<td>${_platPill(r.platform)}</td>
      <td style="color:var(--g600);white-space:nowrap">${esc(r.region||'')}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.vpc_id)}"><code style="font-size:12px">${esc(r.vpc_id)}</code></td>
      <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.vpc_name||'')}"><strong>${esc(r.vpc_name||'')}</strong></td>
      <td><span style="font-family:monospace;font-size:12px;color:var(--g600)">${esc(r.cidr||'-')}</span></td>
      <td style="color:var(--g600);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.description||'')}">${esc(r.description||'-')}</td>
      <td style="white-space:nowrap">${_syncTime(r.synced_at)}</td>`;
  } else if (type === 'subnet') {
    minWidth = '1100px';
    head = '<th style="width:80px">云平台</th><th style="width:130px">地域</th><th style="width:180px">子网 ID</th><th style="width:140px">名称</th><th style="width:180px">VPC ID</th><th style="width:130px">CIDR</th><th style="width:120px">可用区</th><th style="width:120px;white-space:nowrap">同步时间</th>';
    rowsFn = r => `<td>${_platPill(r.platform)}</td>
      <td style="color:var(--g600);white-space:nowrap">${esc(r.region||'')}</td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.subnet_id)}"><code style="font-size:12px">${esc(r.subnet_id)}</code></td>
      <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.subnet_name||'')}"><strong>${esc(r.subnet_name||'')}</strong></td>
      <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.vpc_id||'')}"><code style="font-size:11px;color:var(--g400)">${esc(r.vpc_id||'-')}</code></td>
      <td><span style="font-family:monospace;font-size:12px;color:var(--g600)">${esc(r.cidr||'-')}</span></td>
      <td style="color:var(--g600);white-space:nowrap">${esc(r.zone||'-')}</td>
      <td style="white-space:nowrap">${_syncTime(r.synced_at)}</td>`;
  } else if (type === 'cert') {
    minWidth = '900px';
    const sortArrow = _certExpSort === 'asc' ? '↑' : _certExpSort === 'desc' ? '↓' : '↕';
    const sortColor = _certExpSort ? 'var(--primary)' : 'var(--g400)';
    head = `<th style="width:80px">云平台</th><th style="width:130px">地域</th><th>域名</th><th style="width:180px">证书名称</th><th style="width:80px">状态</th><th style="width:160px;cursor:pointer;user-select:none" onclick="_toggleCertExpSort()" title="点击按过期时间排序">过期时间 <span style="color:${sortColor};font-weight:700">${sortArrow}</span></th><th style="width:120px;white-space:nowrap">同步时间</th>`;
    rowsFn = r => {
      const exp = r.expires_at ? new Date(r.expires_at) : null;
      const now = new Date();
      const daysLeft = exp ? Math.ceil((exp - now) / 86400000) : null;
      let expColor = 'var(--g600)';
      if (daysLeft !== null) {
        if (daysLeft < 0) expColor = 'var(--danger)';
        else if (daysLeft < 30) expColor = '#F59E0B';
      }
      const expText = exp ? exp.toLocaleDateString('zh-CN') + (daysLeft !== null ? ` (${daysLeft < 0 ? '已过期' : daysLeft + '天后'})` : '') : '-';
      const statusColor = r.status === 'ISSUED' || r.status === 'normal' || r.status === '已签发' ? 'var(--success)' : 'var(--g400)';
      return `<td>${_platPill(r.platform)}</td>
        <td style="color:var(--g600);white-space:nowrap">${esc(r.region||'')}</td>
        <td><strong>${esc(r.domain||'-')}</strong></td>
        <td style="color:var(--g600);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.cert_name||'')}">${esc(r.cert_name||'-')}</td>
        <td><span style="color:${statusColor}">${esc(r.status||'-')}</span></td>
        <td style="color:${expColor};white-space:nowrap">${expText}</td>
        <td style="white-space:nowrap">${_syncTime(r.synced_at)}</td>`;
    };
  } else {
    // dns
    minWidth = '900px';
    const TYPE_COLORS = { A:'#3B82F6', AAAA:'#6366F1', CNAME:'#10B981', MX:'#F59E0B', TXT:'#8B5CF6', NS:'#6B7280', SRV:'#EC4899', CAA:'#14B8A6' };
    head = '<th style="width:80px">云平台</th><th style="width:180px">域名</th><th style="width:160px">记录名</th><th style="width:70px">类型</th><th>记录值</th><th style="width:70px">TTL</th><th style="width:120px;white-space:nowrap">同步时间</th>';
    rowsFn = r => {
      const tc = TYPE_COLORS[r.record_type] || '#6B7280';
      const val = r.record_value || '-';
      const shortVal = val.length > 60 ? val.slice(0, 60) + '…' : val;
      return `<td>${_platPill(r.platform)}</td>
        <td style="color:var(--g600);max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.zone_name||'')}">${esc(r.zone_name||'-')}</td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.record_name||'')}"><strong>${esc(r.record_name||'-')}</strong></td>
        <td><span style="display:inline-block;padding:1px 7px;border-radius:4px;font-size:11px;font-weight:700;background:${tc}20;color:${tc}">${esc(r.record_type||'-')}</span></td>
        <td style="font-family:monospace;font-size:12px;color:var(--g600);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(val)}">${esc(shortVal)}</td>
        <td style="color:var(--g400)">${r.ttl||'-'}</td>
        <td style="white-space:nowrap">${_syncTime(r.synced_at)}</td>`;
    };
  }
  wrap.innerHTML = `<div class="sync-table-container"><table class="sync-table" style="min-width:${minWidth}">
    <thead><tr>${head}</tr></thead>
    <tbody>${rows.map(r => `<tr>${rowsFn(r)}</tr>`).join('')}</tbody>
  </table></div>
  ${_buildPagination(total, _netPage[type], pageSize, '_goNetPage', '_setNetPageSize', `'${type}'`)}`;
}

function _goNetPage(type, n) {
  const total = _netFiltered[type].length;
  const totalPages = Math.max(1, Math.ceil(total / _netPageSize[type]));
  _netPage[type] = Math.min(Math.max(1, n), totalPages);
  _renderNetTable(type);
}
function _setNetPageSize(type, size) {
  _netPageSize[type] = size;
  _netPage[type] = 1;
  _renderNetTable(type);
}

async function syncNetResource(type, platform) {
  const cfg = NET_CFG[type];
  const loadingEl = document.getElementById(cfg.loading);
  const wrapEl    = document.getElementById(cfg.wrap);
  if (loadingEl) loadingEl.classList.remove('hidden');
  if (wrapEl)    wrapEl.innerHTML = '';
  toast(`正在同步 ${PSHORT[platform] || '全部平台'} ${cfg.label}...`);
  const r = await post(cfg.syncApi(platform), {});
  if (loadingEl) loadingEl.classList.add('hidden');
  if (r.ok) {
    const msgs = (r.data.results || []).map(res =>
      res.success ? `${PSHORT[res.platform]}: ${res.count} 条` : `${PSHORT[res.platform]}: ${res.message}`
    );
    toast(msgs.join(' | '), (r.data.results||[]).every(x => x.success) ? 'ok' : 'err');
    await _loadNetPage(type);   // 同步完成后重新加载并过滤
  } else {
    toast('同步失败: ' + (r.data?.error || '未知错误'), 'err');
  }
}

function setNetFilter(type, filter, btn) {
  netFilter[type] = filter;
  const sec = btn.closest('.sec');
  sec.querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  // 证书页「N 天内过期」是独立开关，重置平台 tab 后需按状态回填其高亮
  if (type === 'cert' && _certExpiringDays) {
    sec.querySelectorAll('.cert-expiring-btn').forEach(b => {
      b.classList.toggle('active', Number(b.dataset.days) === _certExpiringDays);
    });
  }
  _loadNetPage(type);
}

function loadSecurityGroups() { _loadNetPage('sg'); }
function loadVpcs()           { _loadNetPage('vpc'); }
function loadSubnets()        { _loadNetPage('subnet'); }
async function loadCerts()    { await _loadNetPage('cert'); _renderCertExpiryBar(); }

// SSL 证书页顶部到期汇总条（基于已加载的 _netData['cert']，只提醒未来 30 天内即将过期，已过期不显示）
function _renderCertExpiryBar() {
  const bar = document.getElementById('cert-expiry-bar');
  if (!bar) return;
  const now = Date.now();
  let expiring = 0;
  for (const c of _netData.cert || []) {
    if (!c.expires_at) continue;
    const days = Math.ceil((new Date(c.expires_at).getTime() - now) / 86400000);
    if (days >= 0 && days < 30) expiring++;
  }
  if (!expiring) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }

  bar.classList.remove('hidden');
  bar.innerHTML = `<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;background:#FFFBEB;border:1px solid #FDE68A;border-radius:8px;font-size:13px;color:var(--g700)">
    <span style="font-size:15px">⚠</span>
    <span>SSL 证书即将过期：<strong style="color:#B45309">${expiring}</strong> 个将在 30 天内到期，请及时续期。</span>
    <a onclick="_sortCertByExpiry()" style="margin-left:auto;color:var(--primary);cursor:pointer;font-weight:600">按到期排序</a>
  </div>`;
}

// 汇总条「按到期排序」：强制升序（最早在前）并回到第一页
function _sortCertByExpiry() {
  _certExpSort = 'asc';
  _netPage.cert = 1;
  _filterAndRenderNet('cert');
}
function loadDnsRecords()     { _loadNetPage('dns'); }

async function showGroupMembers(platform, groupName, displayName) {
  const PNAMES_SHORT = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
  document.getElementById('gm-title').textContent =
    `${PNAMES_SHORT[platform] || platform} · ${displayName || groupName} 的成员`;
  const body = document.getElementById('gm-body');
  body.innerHTML = '<div style="padding:32px 0;text-align:center;color:var(--g400)"><div class="spin" style="margin:0 auto 8px"></div>正在从云端获取...</div>';
  document.getElementById('modal-group-members').classList.remove('hidden');

  const r = await get(`/sync/groups/${platform}/${encodeURIComponent(groupName)}/members`);
  if (r.ok && r.data.members?.length) {
    body.innerHTML = r.data.members.map(name =>
      `<div class="gm-member-row"><span class="gm-avatar">${esc(name).charAt(0).toUpperCase()}</span><span class="gm-name">${esc(name)}</span></div>`
    ).join('');
  } else if (r.ok) {
    body.innerHTML = '<div class="empty-tip" style="padding:24px 0">该组暂无成员</div>';
  } else {
    body.innerHTML = `<div class="empty-tip" style="padding:24px 0;color:var(--danger)">获取失败：${esc(r.data.error || '请检查凭据配置')}</div>`;
  }
}

function closeGroupMembersModal() {
  document.getElementById('modal-group-members').classList.add('hidden');
}


// ─────────────────────────────────────────
async function loadInstances() {
  // 厂商与状态两组独立筛选，可叠加
  const params   = new URLSearchParams();
  if (instPlatformFilter && instPlatformFilter !== 'all') params.set('platform', instPlatformFilter);
  if (instStatusFilter && instStatusFilter !== 'all')     params.set('status', instStatusFilter);
  const r = await get(`/instances?${params}`);
  if (!r.ok) return;
  _instAllData = r.data.instances;
  ['aws', 'aliyun', 'baidu'].forEach(p => {
    const el = document.getElementById(`inst-count-${p}`);
    if (el) el.textContent = _instAllData.filter(i => i.platform === p).length;
  });
  _filterAndRenderInst();
}

// 客户端关键字过滤
const INST_SEARCH_FIELDS = ['instance_name', 'instance_id', 'public_ip', 'private_ip', 'instance_type'];

function _filterAndRenderInst(resetPage = false) {
  const col     = document.getElementById('inst-search-col')?.value || 'all';
  const keyword = document.getElementById('inst-keyword')?.value.trim().toLowerCase() || '';
  _instFilteredData = keyword
    ? _instAllData.filter(i => {
        const targets = col === 'all' ? INST_SEARCH_FIELDS : [col];
        return targets.some(f => String(i[f] || '').toLowerCase().includes(keyword));
      })
    : _instAllData;
  if (resetPage) _instCurrentPage = 1;
  renderInstancesTable();
}

function onInstSearch() { _filterAndRenderInst(true); }

function renderInstancesTable() {
  const wrap = document.getElementById('inst-table-wrap');
  const total      = _instFilteredData.length;
  const totalPages = Math.max(1, Math.ceil(total / _instPageSize));
  if (_instCurrentPage > totalPages) _instCurrentPage = totalPages;
  const start    = (_instCurrentPage - 1) * _instPageSize;
  const pageData = _instFilteredData.slice(start, start + _instPageSize);

  if (!total) {
    wrap.innerHTML = '<div class="empty-tip">暂无云主机，点击右上角「创建云主机」开始</div>';
    return;
  }

  const PCOLORS = { aws: '#FF9900', aliyun: '#FF6A00', baidu: '#2932E1' };
  const PSHORT  = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
  const STATUS  = { running: ['运行中', 'var(--success)'], stopped: ['已停止', 'var(--g400)'], pending: ['启动中', 'var(--warn)'], stopping: ['停止中', 'var(--warn)'], terminated: ['已终止', 'var(--error)'] };

  wrap.innerHTML = `
    <div class="sync-table-container"><table class="sync-table" style="min-width:1230px">
      <thead><tr>
        <th style="width:80px">云平台</th><th style="width:120px">区域</th><th style="width:160px">实例名</th><th style="width:180px">实例 ID</th><th style="width:80px">状态</th><th style="width:120px">规格</th><th style="width:130px">公网 IP</th><th style="width:130px">内网 IP</th><th style="width:140px;white-space:nowrap">创建时间</th><th style="width:100px">操作</th>
      </tr></thead>
      <tbody>${pageData.map(i => {
        const [sText, sColor] = STATUS[i.status] || [i.status, 'var(--g600)'];
        return `<tr>
          <td><span class="platform-pill" style="background:${PCOLORS[i.platform] || '#6B7280'}">${PSHORT[i.platform] || i.platform}</span></td>
          <td style="font-size:12px;color:var(--g500);white-space:nowrap">${esc(i.region || '-')}</td>
          <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(i.instance_name||'')}"><strong>${esc(i.instance_name || '-')}</strong></td>
          <td style="font-size:12px;color:var(--g400);font-family:monospace;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(i.instance_id)}">${esc(i.instance_id)}</td>
          <td><span class="inst-status-dot" style="background:${sColor}"></span><span style="font-size:12.5px;font-weight:600;color:${sColor}">${sText}</span></td>
          <td style="font-size:12.5px;color:var(--g600);white-space:nowrap">${esc(i.instance_type || '-')}</td>
          <td style="font-size:12.5px;font-family:monospace">${esc(i.public_ip || '-')}</td>
          <td style="font-size:12.5px;font-family:monospace">${esc(i.private_ip || '-')}</td>
          <td style="color:var(--g400);font-size:12px;white-space:nowrap">${i.created_at ? new Date(i.created_at).toLocaleString('zh-CN') : '-'}</td>
          <td style="white-space:nowrap">
            ${canOperate() && i.status === 'stopped' ? `<button class="btn-ghost btn-sm" onclick="startInstance('${i.id}')">启动</button>` : ''}
            ${canOperate() && i.status === 'running' ? `<button class="btn-ghost btn-sm" onclick="stopInstance('${i.id}')">停止</button>` : ''}
            ${canOperate() ? `<button class="btn-danger btn-sm" style="margin-left:4px" onclick="deleteInstance('${i.id}','${esc(i.instance_name || i.instance_id)}')">删除</button>` : ''}
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    ${_renderInstPagination(total, totalPages)}`;
}

function _renderInstPagination(total, totalPages) {
  const p = _instCurrentPage;
  // 生成页码数组（最多显示 7 个，超出用省略号）
  let pages = [];
  if (totalPages <= 7) {
    pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else {
    if (p <= 4) {
      pages = [1, 2, 3, 4, 5, '…', totalPages];
    } else if (p >= totalPages - 3) {
      pages = [1, '…', totalPages-4, totalPages-3, totalPages-2, totalPages-1, totalPages];
    } else {
      pages = [1, '…', p-1, p, p+1, '…', totalPages];
    }
  }

  const pageBtns = pages.map(n =>
    n === '…'
      ? `<span class="pg-btn" style="cursor:default;border:none">…</span>`
      : `<button class="pg-btn ${n === p ? 'active' : ''}" onclick="goInstPage(${n})">${n}</button>`
  ).join('');

  const sizeOpts = [10, 20, 50, 100].map(s =>
    `<option value="${s}" ${s === _instPageSize ? 'selected' : ''}>${s} 条/页</option>`
  ).join('');

  return `
    <div class="pagination">
      <span class="pagination-info">共 ${total} 条，第 ${p} / ${totalPages} 页</span>
      <div class="pagination-btns">
        <button class="pg-btn" onclick="goInstPage(${p-1})" ${p <= 1 ? 'disabled' : ''}>‹ 上一页</button>
        ${pageBtns}
        <button class="pg-btn" onclick="goInstPage(${p+1})" ${p >= totalPages ? 'disabled' : ''}>下一页 ›</button>
        <select class="pg-size-select" onchange="setInstPageSize(+this.value)">${sizeOpts}</select>
      </div>
    </div>`;
}

function goInstPage(n) {
  const totalPages = Math.max(1, Math.ceil(_instFilteredData.length / _instPageSize));
  _instCurrentPage = Math.min(Math.max(1, n), totalPages);
  renderInstancesTable();
  document.getElementById('inst-table-wrap').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setInstPageSize(size) {
  _instPageSize    = size;
  _instCurrentPage = 1;
  renderInstancesTable();
}

async function syncInstances(platform) {
  toast('正在同步云主机状态...');
  const r = await post(`/instances/sync/${platform}`, {});
  if (r.ok) {
    const results = r.data.results || [];
    const total = results.reduce((s, res) => s + (res.count || 0), 0);
    const removed = results.reduce((s, res) => s + (res.removed || 0), 0);
    toast(`同步完成，共 ${total} 台实例${removed ? `，清理 ${removed} 台已删除` : ''}`, 'ok');
    await loadInstances();
  } else {
    toast('同步失败: ' + (r.data.error || '未知错误'), 'err');
  }
}

// 厂商筛选（组内单选，与状态组可叠加）
function setInstPlatformFilter(val, btn) {
  instPlatformFilter = val;
  _instCurrentPage = 1;
  btn.closest('.sync-filter-tabs').querySelectorAll('[data-instgroup="platform"]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadInstances();
}

// 状态筛选（组内单选，与厂商组可叠加）
function setInstStatusFilter(val, btn) {
  instStatusFilter = val;
  _instCurrentPage = 1;
  btn.closest('.sync-filter-tabs').querySelectorAll('[data-instgroup="status"]').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadInstances();
}

// ── 创建云主机（新版，带规格下拉 & 平台专属表单） ──
let instApiCache = {};
let _instAllData = [];    // 当前过滤条件下从服务器拉到的全量数据，用于客户端搜索
let sgCache = {};          // key: `${platform}:${region}` → security_groups[]
let vpcCache = {};         // key: `${platform}:${region}` → vpcs[]
let subnetCache = {};      // key: `${platform}:${region}:${vpcId}` → subnets[]
let INST_ZONES_DATA = {};
let currentInstPlatform = 'aws';
let credRegions = {};   // { aws: 'us-east-1', aliyun: 'cn-hangzhou', baidu: 'bj' }

const REGION_LABELS = {
  'us-east-1': '美国东部 (弗吉尼亚)', 'us-west-2': '美国西部 (俄勒冈)',
  'cn-north-1': '中国 (北京)', 'cn-northwest-1': '中国 (宁夏)',
  'ap-northeast-1': '亚太 (东京)', 'ap-southeast-1': '亚太 (新加坡)',
  'cn-hangzhou': '华东1 杭州', 'cn-shanghai': '华东2 上海',
  'cn-beijing': '华北2 北京', 'cn-shenzhen': '华南1 深圳', 'cn-hongkong': '中国香港',
  'bj': '华北-北京', 'gz': '华南-广州', 'su': '华东-苏州', 'hkg': '港澳台-香港'
};

async function showCreateInstanceModal() {
  // 拉取可用区数据（仅首次）
  if (!Object.keys(INST_ZONES_DATA).length) {
    const r = await get('/cloud/instance-types');
    if (r.ok) { INST_ZONES_DATA = r.data.zones; }
  }
  // 读取已配置的凭据地域
  const cr = await get('/cloud/credentials');
  credRegions = {};
  if (cr.ok) cr.data.credentials.forEach(c => { credRegions[c.platform] = c.region || ''; });

  // 重置表单
  ['ci-name','ci-key-pair','ci-aws-sg','ci-ali-sg','ci-ali-vsw',
   'ci-aws-vpc','ci-ali-vpc','ci-bai-vpc','ci-bai-sg',
   'ci-aws-subnet','ci-bai-subnet','ci-type-search'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('ci-count').value = '1';
  document.getElementById('ci-err').textContent = '';
  // 规格/镜像筛选 + 磁盘/公网 IP 默认值
  ['ci-cpu-filter','ci-mem-filter'].forEach(id => { const el = document.getElementById(id); if (el) el.value = '0'; });
  const osF = document.getElementById('ci-os-filter'); if (osF) osF.value = '';
  const sysd = document.getElementById('ci-sysdisk'); if (sysd) sysd.value = '40';
  const datad = document.getElementById('ci-datadisk'); if (datad) datad.value = '0';
  const pubip = document.getElementById('ci-pubip'); if (pubip) pubip.checked = false;

  // 切换到 AWS 标签
  switchInstPlatform('aws', document.querySelector('.inst-tab[data-p="aws"]'));
  document.getElementById('modal-create-inst').classList.remove('hidden');
}

function closeCreateInstModal() {
  document.getElementById('modal-create-inst').classList.add('hidden');
}

function switchInstPlatform(platform, btn) {
  currentInstPlatform = platform;
  document.querySelectorAll('.inst-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  // 切换平台专属字段
  ['aws','aliyun','baidu'].forEach(p => {
    const el = document.getElementById(`ci-extra-${p}`);
    if (el) el.classList.toggle('hidden', p !== platform);
  });

  _fillRegions(platform);
}

function _fillRegions(platform) {
  const regions = Object.keys(INST_ZONES_DATA[platform] || {});
  const credReg = credRegions[platform] || '';
  const select  = document.getElementById('ci-region');
  select.innerHTML = regions.map(r =>
    `<option value="${r}" ${r === credReg ? 'selected' : ''}>${REGION_LABELS[r] || r}</option>`
  ).join('');
  onInstRegionChange();
}

function onInstRegionChange() {
  const region = document.getElementById('ci-region').value;
  const zones  = (INST_ZONES_DATA[currentInstPlatform] || {})[region] || [];
  document.getElementById('ci-zone').innerHTML =
    `<option value="">不指定</option>` +
    zones.map(z => `<option value="${z}">${z}</option>`).join('');
  _fillInstanceTypesDynamic(currentInstPlatform, region);
  _fillImages(currentInstPlatform, region);
  _fillSecurityGroups(currentInstPlatform, region);
  _fillVpcs(currentInstPlatform, region);
  _fillSubnets(currentInstPlatform, region, '');
}

// 规格数据缓存（原始数组，含 vcpu/memory），供 CPU/内存筛选 + 搜索
let _ciTypesData = [];   // 当前 platform+region 的规格列表
let _ciImagesData = [];  // 当前 platform+region 的镜像列表

async function _fillInstanceTypesDynamic(platform, region) {
  const sel = document.getElementById('ci-type');
  if (!region) { sel.innerHTML = '<option value="">请先选择地域</option>'; return; }
  const cacheKey = `types:${platform}:${region}`;
  if (instApiCache[cacheKey]) {
    _ciTypesData = instApiCache[cacheKey];
    _updateInstTypeFilters();
    _renderInstTypesFiltered();
    return;
  }
  sel.innerHTML = '<option disabled value="">加载中...</option>';
  const r = await get(`/instances/instance-types?platform=${platform}&region=${encodeURIComponent(region)}`);
  if (r.ok && r.data.types?.length) {
    instApiCache[cacheKey] = r.data.types;
    _ciTypesData = r.data.types;
    _updateInstTypeFilters();
    _renderInstTypesFiltered();
  } else {
    _ciTypesData = [];
    sel.innerHTML = '<option value="">（获取失败，请检查凭据配置）</option>';
  }
}

// 依据实际规格数据填充 CPU / 内存 筛选下拉的选项
function _updateInstTypeFilters() {
  const cpuSet = new Set(), memSet = new Set();
  _ciTypesData.forEach(t => {
    if (t.vcpu) cpuSet.add(t.vcpu);
    if (t.memory) memSet.add(Math.round(t.memory / 1024));  // MiB → GiB
  });
  const cpuSel = document.getElementById('ci-cpu-filter');
  const memSel = document.getElementById('ci-mem-filter');
  if (cpuSel) cpuSel.innerHTML = '<option value="0">CPU 不限</option>' +
    [...cpuSet].sort((a, b) => a - b).map(c => `<option value="${c}">${c} 核</option>`).join('');
  if (memSel) memSel.innerHTML = '<option value="0">内存不限</option>' +
    [...memSet].sort((a, b) => a - b).map(m => `<option value="${m}">${m} GiB</option>`).join('');
}

// 按 CPU/内存筛选 + 名称搜索渲染规格下拉
function _renderInstTypesFiltered() {
  const sel = document.getElementById('ci-type');
  if (!sel) return;
  const cpu = parseInt(document.getElementById('ci-cpu-filter')?.value) || 0;
  const memGiB = parseInt(document.getElementById('ci-mem-filter')?.value) || 0;
  const kw = (document.getElementById('ci-type-search')?.value || '').trim().toLowerCase();
  const filtered = _ciTypesData.filter(t => {
    if (cpu && t.vcpu !== cpu) return false;
    if (memGiB && Math.round((t.memory || 0) / 1024) !== memGiB) return false;
    if (kw && !(t.id || '').toLowerCase().includes(kw)) return false;
    return true;
  });
  if (!filtered.length) {
    sel.innerHTML = '<option value="">无匹配规格</option>';
    onInstTypeChange();
    return;
  }
  sel.innerHTML = filtered.map(t => {
    const cpuMem = (t.vcpu || t.memory) ? `${t.vcpu || '?'} 核 / ${t.memory ? Math.round(t.memory / 1024) : '?'} GiB` : (t.desc || '');
    return `<option value="${t.id}">${t.id}（${cpuMem}）</option>`;
  }).join('');
  onInstTypeChange();
}

// 实例规格变更时查询单价
const _priceClientCache = {};   // key: `platform:region:type` → price result
async function onInstTypeChange() {
  const platform     = currentInstPlatform;
  const region       = document.getElementById('ci-region').value;
  const instanceType = document.getElementById('ci-type').value;
  const priceEl      = document.getElementById('ci-type-price');
  if (!priceEl) return;
  if (!instanceType || !region) { priceEl.textContent = ''; return; }

  const cacheKey = `${platform}:${region}:${instanceType}`;
  if (_priceClientCache[cacheKey]) {
    _renderPrice(priceEl, _priceClientCache[cacheKey]);
    return;
  }

  priceEl.innerHTML = '<span style="color:var(--g400)">正在查询价格...</span>';
  const r = await get(`/cloud/price/${platform}?region=${encodeURIComponent(region)}&instanceType=${encodeURIComponent(instanceType)}`);
  if (r.ok) {
    _priceClientCache[cacheKey] = r.data;
    _renderPrice(priceEl, r.data);
  } else {
    priceEl.textContent = '';
  }
}

function _renderPrice(el, data) {
  if (data.price == null) {
    el.textContent = data.note || '暂无公开价格数据';
    return;
  }
  const sym      = data.currency === 'USD' ? '$' : '¥';
  const price    = parseFloat(data.price);
  const perMonth = (price * 730).toFixed(2);
  el.innerHTML =
    `按需计费：<strong style="color:var(--primary)">${sym}${price.toFixed(4)}</strong> / ${data.unit}` +
    `<span style="color:var(--g400);margin-left:12px">≈ ${sym}${perMonth} / 月</span>`;
}

async function _fillImages(platform, region) {
  const sel = document.getElementById('ci-image');
  if (!region) { sel.innerHTML = '<option value="">请先选择地域</option>'; return; }
  const cacheKey = `images:${platform}:${region}`;
  if (instApiCache[cacheKey]) { _ciImagesData = instApiCache[cacheKey]; _renderImagesFiltered(); return; }
  sel.innerHTML = '<option disabled value="">加载中...</option>';
  const r = await get(`/instances/images?platform=${platform}&region=${encodeURIComponent(region)}`);
  if (r.ok && r.data.images?.length) {
    instApiCache[cacheKey] = r.data.images;
    _ciImagesData = r.data.images;
    _renderImagesFiltered();
  } else {
    _ciImagesData = [];
    sel.innerHTML = '<option value="">（获取镜像失败，请检查凭据配置）</option>';
  }
}

// 按操作系统筛选渲染镜像下拉
function _renderImagesFiltered() {
  const sel = document.getElementById('ci-image');
  if (!sel) return;
  const os = (document.getElementById('ci-os-filter')?.value || '').toLowerCase();
  const filtered = os
    ? _ciImagesData.filter(img => {
        const hay = `${img.name || ''} ${img.id || ''} ${img.desc || ''}`.toLowerCase();
        return hay.includes(os);
      })
    : _ciImagesData;
  sel.innerHTML = filtered.length
    ? filtered.map(img => `<option value="${img.id}" title="${img.desc || ''}">${img.name || img.id}（${img.id}）</option>`).join('')
    : '<option value="">无匹配镜像</option>';
}

// 从 DB 加载安全组到当前平台的 select
async function _fillSecurityGroups(platform, region) {
  const selId = { aws: 'ci-aws-sg', aliyun: 'ci-ali-sg', baidu: 'ci-bai-sg' }[platform];
  const sel = document.getElementById(selId);
  if (!sel) return;

  const cacheKey = `${platform}:${region}`;
  if (sgCache[cacheKey]) { _renderSGOptions(sel, sgCache[cacheKey]); return; }

  sel.innerHTML = '<option disabled value="">加载中...</option>';
  const r = await get(`/sync/security-groups?platform=${platform}&region=${encodeURIComponent(region)}`);
  if (r.ok) {
    sgCache[cacheKey] = r.data.security_groups || [];
    _renderSGOptions(sel, sgCache[cacheKey]);
  } else {
    sel.innerHTML = '<option value="">不指定</option>';
  }
}

function _renderSGOptions(sel, sgs) {
  if (!sgs.length) {
    sel.innerHTML = '<option value="">不指定（暂无已同步安全组，可点「同步」）</option>';
    return;
  }
  sel.innerHTML = '<option value="">不指定</option>' +
    sgs.map(sg => `<option value="${sg.sg_id}" title="${sg.description}">${sg.sg_name}（${sg.sg_id}）</option>`).join('');
}

// 点击「同步」按钮：触发云端同步，再刷新 select
async function syncAndFillSG(platform) {
  const selId = { aws: 'ci-aws-sg', aliyun: 'ci-ali-sg', baidu: 'ci-bai-sg' }[platform];
  const sel = document.getElementById(selId);
  if (!sel) return;
  sel.innerHTML = '<option disabled value="">同步中...</option>';

  const r = await post(`/sync/security-groups/${platform}`, {});
  if (r.ok) {
    // 清掉该平台缓存，重新从 DB 拉
    const region = document.getElementById('ci-region').value;
    delete sgCache[`${platform}:${region}`];
    await _fillSecurityGroups(platform, region);
    const res = (r.data.results || []).find(x => x.platform === platform);
    if (res?.success) toast(`同步安全组成功：${res.count} 条`, 'ok');
    else toast(res?.message || '同步失败', 'err');
  } else {
    sel.innerHTML = '<option value="">不指定</option>';
    toast('安全组同步失败', 'err');
  }
}

// 从 DB 加载 VPC 到当前平台的 select
async function _fillVpcs(platform, region) {
  const selId = { aws: 'ci-aws-vpc', aliyun: 'ci-ali-vpc', baidu: 'ci-bai-vpc' }[platform];
  const sel = document.getElementById(selId);
  if (!sel) return;

  const cacheKey = `${platform}:${region}`;
  if (vpcCache[cacheKey]) { _renderVpcOptions(sel, vpcCache[cacheKey]); return; }

  sel.innerHTML = '<option disabled value="">加载中...</option>';
  const r = await get(`/sync/vpcs?platform=${platform}&region=${encodeURIComponent(region)}`);
  if (r.ok) {
    vpcCache[cacheKey] = r.data.vpcs || [];
    _renderVpcOptions(sel, vpcCache[cacheKey]);
  } else {
    sel.innerHTML = '<option value="">不指定</option>';
  }
}

function _renderVpcOptions(sel, vpcs) {
  if (!vpcs.length) {
    sel.innerHTML = '<option value="">不指定（暂无已同步 VPC，可点「同步」）</option>';
    return;
  }
  sel.innerHTML = '<option value="">不指定</option>' +
    vpcs.map(v => {
      const cidrPart = v.cidr ? ` [${v.cidr}]` : '';
      const descPart = v.description ? ` — ${v.description}` : '';
      const label = `${v.vpc_name || v.vpc_id}（${v.vpc_id}）${cidrPart}${descPart}`;
      return `<option value="${v.vpc_id}" title="${v.description || ''}">${label}</option>`;
    }).join('');
}

// 点击「同步」按钮：触发云端 VPC 同步，再刷新 select
async function syncAndFillVpc(platform) {
  const selId = { aws: 'ci-aws-vpc', aliyun: 'ci-ali-vpc', baidu: 'ci-bai-vpc' }[platform];
  const sel = document.getElementById(selId);
  if (!sel) return;
  sel.innerHTML = '<option disabled value="">同步中...</option>';

  const r = await post(`/sync/vpcs/${platform}`, {});
  if (r.ok) {
    const region = document.getElementById('ci-region').value;
    delete vpcCache[`${platform}:${region}`];
    await _fillVpcs(platform, region);
    const res = (r.data.results || []).find(x => x.platform === platform);
    if (res?.success) toast(`同步 VPC 成功：${res.count} 条`, 'ok');
    else toast(res?.message || '同步失败', 'err');
  } else {
    sel.innerHTML = '<option value="">不指定</option>';
    toast('VPC 同步失败', 'err');
  }
}

// VPC 切换时刷新子网列表
function _onVpcChange(platform) {
  const vpcSelId = { aws: 'ci-aws-vpc', aliyun: 'ci-ali-vpc', baidu: 'ci-bai-vpc' }[platform];
  const vpcId = document.getElementById(vpcSelId)?.value || '';
  const region = document.getElementById('ci-region').value;
  _fillSubnets(platform, region, vpcId);
}

// 从 DB 加载子网到当前平台的 select
async function _fillSubnets(platform, region, vpcId) {
  const selId = { aws: 'ci-aws-subnet', aliyun: 'ci-ali-vsw', baidu: 'ci-bai-subnet' }[platform];
  const sel = document.getElementById(selId);
  if (!sel) return;

  const cacheKey = `${platform}:${region}:${vpcId}`;
  if (subnetCache[cacheKey]) { _renderSubnetOptions(sel, subnetCache[cacheKey]); return; }

  sel.innerHTML = '<option disabled value="">加载中...</option>';
  const params = new URLSearchParams({ platform, region });
  if (vpcId) params.append('vpc_id', vpcId);
  const r = await get(`/sync/subnets?${params}`);
  if (r.ok) {
    subnetCache[cacheKey] = r.data.subnets || [];
    _renderSubnetOptions(sel, subnetCache[cacheKey]);
  } else {
    sel.innerHTML = '<option value="">不指定</option>';
  }
}

function _renderSubnetOptions(sel, subnets) {
  const label = sel.id === 'ci-ali-vsw' ? '交换机' : '子网';
  if (!subnets.length) {
    sel.innerHTML = `<option value="">不指定（暂无已同步${label}，可点「同步」）</option>`;
    return;
  }
  sel.innerHTML = '<option value="">不指定</option>' +
    subnets.map(s => {
      const zonePart = s.zone ? ` [${s.zone}]` : '';
      const cidrPart = s.cidr ? ` ${s.cidr}` : '';
      const name = s.subnet_name || s.subnet_id;
      return `<option value="${s.subnet_id}" title="${s.description || ''}">${name}（${s.subnet_id}）${cidrPart}${zonePart}</option>`;
    }).join('');
}

// 点击「同步」按钮：触发子网同步，再刷新 select
async function syncAndFillSubnets(platform) {
  const selId = { aws: 'ci-aws-subnet', aliyun: 'ci-ali-vsw', baidu: 'ci-bai-subnet' }[platform];
  const sel = document.getElementById(selId);
  if (!sel) return;
  sel.innerHTML = '<option disabled value="">同步中...</option>';

  const r = await post(`/sync/subnets/${platform}`, {});
  if (r.ok) {
    // 清掉该平台+地域所有子网缓存条目
    const region = document.getElementById('ci-region').value;
    Object.keys(subnetCache).forEach(k => {
      if (k.startsWith(`${platform}:${region}:`)) delete subnetCache[k];
    });
    const vpcSelId = { aws: 'ci-aws-vpc', aliyun: 'ci-ali-vpc', baidu: 'ci-bai-vpc' }[platform];
    const vpcId = document.getElementById(vpcSelId)?.value || '';
    await _fillSubnets(platform, region, vpcId);
    const res = (r.data.results || []).find(x => x.platform === platform);
    if (res?.success) toast(`同步子网成功：${res.count} 条`, 'ok');
    else toast(res?.message || '同步失败', 'err');
  } else {
    sel.innerHTML = '<option value="">不指定</option>';
    toast('子网同步失败', 'err');
  }
}

async function submitCreateInstance() {
  const platform      = currentInstPlatform;
  const instance_name = document.getElementById('ci-name').value.trim();
  const instance_type = document.getElementById('ci-type').value;
  const image_id      = document.getElementById('ci-image').value;
  const region        = document.getElementById('ci-region').value;
  const zone          = document.getElementById('ci-zone').value;
  const count         = parseInt(document.getElementById('ci-count').value) || 1;
  const errEl         = document.getElementById('ci-err');

  if (!instance_type) { errEl.textContent = '请选择实例规格'; return; }
  if (!image_id)      { errEl.textContent = '请选择镜像';  return; }

  // 平台专属参数
  const extra = {};
  if (platform === 'aws') {
    const kp     = document.getElementById('ci-key-pair')?.value.trim();
    const sg     = document.getElementById('ci-aws-sg')?.value;
    const vpc    = document.getElementById('ci-aws-vpc')?.value;
    const subnet = document.getElementById('ci-aws-subnet')?.value;
    if (kp)     extra.KeyName = kp;
    if (sg)     extra.SecurityGroupIds = [sg];
    if (vpc)    extra.VpcId = vpc;
    if (subnet) extra.SubnetId = subnet;
  } else if (platform === 'aliyun') {
    const sg  = document.getElementById('ci-ali-sg')?.value;
    const vsw = document.getElementById('ci-ali-vsw')?.value;
    const vpc = document.getElementById('ci-ali-vpc')?.value;
    if (sg)  extra.SecurityGroupId = sg;
    if (vsw) extra.VSwitchId = vsw;
    if (vpc) extra.VpcId = vpc;
  } else if (platform === 'baidu') {
    const sg     = document.getElementById('ci-bai-sg')?.value;
    const subnet = document.getElementById('ci-bai-subnet')?.value;
    const vpc = document.getElementById('ci-bai-vpc')?.value;
    if (sg)     extra.securityGroupId = sg;
    if (subnet) extra.subnetId = subnet;
    if (vpc)    extra.vpcId = vpc;
    extra.billing = { paymentTiming: document.getElementById('ci-bai-billing')?.value || 'Postpaid' };
  }

  const btn = document.getElementById('ci-submit-btn');
  btn.disabled = true; btn.textContent = '创建中...';
  errEl.textContent = '';

  const body = { platform, instance_name, instance_type, image_id, region, count };
  if (zone) body.zone = zone;
  if (Object.keys(extra).length) body.extra = extra;
  // 磁盘 / 公网 IP
  body.public_ip = document.getElementById('ci-pubip')?.checked || false;
  body.system_disk_size = parseInt(document.getElementById('ci-sysdisk')?.value) || 0;
  body.data_disk_size = parseInt(document.getElementById('ci-datadisk')?.value) || 0;

  const r = await post('/instances', body);
  btn.disabled = false; btn.textContent = '确认创建';

  if (r.ok) {
    closeCreateInstModal();
    toast(`云主机创建成功，共 ${r.data.instances.length} 台`, 'ok');
    await loadInstances();
  } else {
    errEl.textContent = r.data.error || '创建失败';
  }
}

async function startInstance(id) {
  const r = await post(`/instances/${id}/start`, {});
  r.ok ? (toast('云主机已启动', 'ok'), loadInstances()) : toast(r.data.error || '启动失败', 'err');
}

async function stopInstance(id) {
  if (!confirm('确认停止该云主机？')) return;
  const r = await post(`/instances/${id}/stop`, {});
  r.ok ? (toast('云主机已停止', 'ok'), loadInstances()) : toast(r.data.error || '停止失败', 'err');
}

async function deleteInstance(id, name) {
  if (!confirm(`确认删除云主机「${name}」？\n此操作将在云平台终止该实例，不可恢复。`)) return;
  const r = await del(`/instances/${id}`);
  r.ok ? (toast('云主机已删除', 'ok'), loadInstances()) : toast(r.data.error || '删除失败', 'err');
}

// ─────────────────────────────────────────
