// ─────────────────────────────────────────
// 资源查询
// ─────────────────────────────────────────

let _pqTab = 'storage';
let _pqNetTab = 'dns';
let _pqStoTab = 'bucket';

function loadPermQuery() {
  const wrap = document.getElementById('perm-query-wrap');
  if (!wrap) return;

  wrap.innerHTML = `
    <div style="display:flex;gap:0;margin-bottom:16px;border-bottom:2px solid var(--border)">
      <button id="pq-tab-storage" class="filter-tab active" onclick="pqTabSwitch('storage')">存储资源</button>
      <button id="pq-tab-network" class="filter-tab" onclick="pqTabSwitch('network')">网络资源</button>
    </div>
    <div id="pq-tab-content"></div>`;

  pqTabSwitch(_pqTab);
}

function pqTabSwitch(tab) {
  _pqTab = tab;
  ['storage', 'network'].forEach(t => {
    const btn = document.getElementById(`pq-tab-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
  });

  const content = document.getElementById('pq-tab-content');
  if (!content) return;

  if (tab === 'storage') {
    content.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button id="pq-sto-tab-bucket" class="filter-tab active" onclick="pqStoTabSwitch('bucket')">存储桶权限校验</button>
        <button id="pq-sto-tab-cpfs" class="filter-tab" onclick="pqStoTabSwitch('cpfs')">CPFS 用量查询</button>
      </div>
      <div id="pq-sto-content"></div>`;
    pqStoTabSwitch(_pqStoTab || 'bucket');
  } else {
    content.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:16px">
        <button id="pq-net-tab-dns" class="filter-tab active" onclick="pqNetTabSwitch('dns')">DNS 域名查询</button>
        <button id="pq-net-tab-resolve" class="filter-tab" onclick="pqNetTabSwitch('resolve')">DNS 全球解析</button>
        <button id="pq-net-tab-ip" class="filter-tab" onclick="pqNetTabSwitch('ip')">IP 地址查询</button>
      </div>
      <div id="pq-net-content"></div>`;
    pqNetTabSwitch(_pqNetTab || 'dns');
  }
}

// 根据所选云平台填充地域下拉（复用 buckets.js 的 BUCKET_REGIONS）
function pqFillBucketRegions() {
  const platform = document.getElementById('pq-bucket-platform')?.value;
  const sel = document.getElementById('pq-bucket-region');
  if (!sel) return;
  const regions = (typeof BUCKET_REGIONS !== 'undefined' && BUCKET_REGIONS[platform]) || [];
  sel.innerHTML = '<option value="">请选择地域</option>' +
    regions.map(r => `<option value="${r}">${r}</option>`).join('');
}

// ── 存储资源二级 tab 切换 ──
function pqStoTabSwitch(tab) {
  _pqStoTab = tab;
  ['bucket', 'cpfs'].forEach(t => {
    const btn = document.getElementById(`pq-sto-tab-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
  });
  const box = document.getElementById('pq-sto-content');
  if (!box) return;
  if (tab === 'bucket') {
    box.innerHTML = `<div class="card" style="padding:20px">
      <div style="font-size:12px;color:var(--g500);margin-bottom:14px">输入 AK/SK 验证对指定存储桶是否有读写权限</div>
      <div class="field" style="margin-bottom:10px">
        <label style="font-size:12px;margin-bottom:4px;display:block">云平台</label>
        <select id="pq-bucket-platform" style="width:100%" onchange="pqFillBucketRegions()">
          <option value="aws">AWS (S3)</option>
          <option value="aliyun">阿里云 (OSS)</option>
          <option value="baidu">百度云 (BOS)</option>
        </select>
      </div>
      <div class="form-row" style="margin-bottom:10px">
        <div class="field" style="flex:1;margin:0">
          <label style="font-size:12px;margin-bottom:4px;display:block">Access Key</label>
          <input type="text" id="pq-ak" placeholder="Access Key ID" style="font-family:monospace;font-size:12px">
        </div>
        <div class="field" style="flex:1;margin:0">
          <label style="font-size:12px;margin-bottom:4px;display:block">Secret Key</label>
          <input type="password" id="pq-sk" placeholder="Secret Access Key" style="font-family:monospace;font-size:12px">
        </div>
      </div>
      <div class="form-row" style="margin-bottom:12px">
        <div class="field" style="flex:1;margin:0">
          <label style="font-size:12px;margin-bottom:4px;display:block">Bucket 名称</label>
          <input type="text" id="pq-bucket-name" placeholder="输入 Bucket 名称" onkeydown="if(event.key==='Enter')pqCheckBucket()">
        </div>
        <div class="field" style="flex:1;margin:0">
          <label style="font-size:12px;margin-bottom:4px;display:block">地域 <span class="req" style="color:var(--danger)">*</span></label>
          <select id="pq-bucket-region" style="width:100%"></select>
        </div>
      </div>
      <div class="field" style="margin-bottom:12px">
        <label style="font-size:12px;margin-bottom:4px;display:block">路径前缀 <span style="color:var(--g400)">(可选)</span></label>
        <input type="text" id="pq-bucket-path" placeholder="如 uploads/ 或 data/logs/" onkeydown="if(event.key==='Enter')pqCheckBucket()">
      </div>
      <button class="btn-primary btn-sm" onclick="pqCheckBucket()">校验权限</button>
      <div id="pq-bucket-result" style="margin-top:14px"></div>
    </div>`;
    pqFillBucketRegions();
  } else {
    box.innerHTML = '<div class="card" style="padding:20px"><div style="color:var(--g400);font-size:13px">加载 CPFS 用量...</div></div>';
    _pqLoadCpfsUsage();
  }
}

// 查询 CPFS fileset 用量
async function _pqLoadCpfsUsage() {
  const box = document.getElementById('pq-sto-content');
  if (!box) return;
  const r = await get('/pai/filesets');
  if (!r.ok) { box.innerHTML = `<div class="card" style="padding:20px"><div style="color:var(--err,#dc2626);font-size:13px">${esc(r.data?.error || '加载失败')}</div></div>`; return; }
  const items = r.data.items || [];
  const fsInfo = r.data.fileSystem;
  if (!items.length) { box.innerHTML = '<div class="card" style="padding:20px"><div class="empty-tip">暂无 CPFS fileset 数据，请先同步</div></div>'; return; }
  const totalUsed = items.reduce((s, f) => s + (f.usedGiB || 0), 0).toFixed(2);
  const rows = items.map(f => {
    const pct = f.sizeLimitGiB ? Math.min(100, Math.round((f.usedGiB / f.sizeLimitGiB) * 100)) : 0;
    const color = pct >= 90 ? 'var(--err,#dc2626)' : (pct >= 70 ? 'var(--warn,#d97706)' : 'var(--primary)');
    const bar = f.sizeLimitGiB
      ? `<div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:6px;background:var(--g100);border-radius:3px;overflow:hidden;min-width:50px"><div style="width:${pct}%;height:100%;background:${color}"></div></div><span style="font-size:11px;color:var(--g500);white-space:nowrap">${f.usedGiB} / ${f.sizeLimitGiB} GiB</span></div>`
      : `<span style="font-size:12px;color:var(--g400)">${f.usedGiB} GiB（未限额）</span>`;
    return `<tr>
      <td style="font-weight:500">${esc(f.name || '(未命名)')}</td>
      <td style="font-family:monospace;font-size:11px;color:var(--g500)">${esc(f.path || '')}</td>
      <td style="min-width:160px">${bar}</td>
      <td style="font-size:12px;color:var(--g600)">${(f.fileCountUsage||0).toLocaleString()}</td>
    </tr>`;
  }).join('');
  box.innerHTML = `<div class="card" style="padding:20px">
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px">
      <span style="font-size:13px;color:var(--g600)">文件系统：<strong>${esc(fsInfo?.description || fsInfo?.id || '-')}</strong></span>
      <span style="font-size:12px;color:var(--g500)">fileset 总已用：${totalUsed} GiB</span>
    </div>
    <table class="acc-table"><thead><tr><th>名称</th><th>路径</th><th style="width:180px">容量用量</th><th>文件数</th></tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}

// ── 网络资源二级 tab 切换 ──
function pqNetTabSwitch(tab) {
  _pqNetTab = tab;
  ['dns', 'resolve', 'ip'].forEach(t => {
    const btn = document.getElementById(`pq-net-tab-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
  });
  const box = document.getElementById('pq-net-content');
  if (!box) return;
  if (tab === 'dns') {
    box.innerHTML = `<div class="card" style="padding:20px">
      <div style="font-size:12px;color:var(--g500);margin-bottom:14px">输入域名或子域名，查询是否已被使用</div>
      <div class="field" style="margin-bottom:12px">
        <label style="font-size:12px;margin-bottom:4px;display:block">域名</label>
        <input type="text" id="pq-dns-domain" placeholder="如 api.example.com 或 api" onkeydown="if(event.key==='Enter')pqCheckDns()">
      </div>
      <button class="btn-primary btn-sm" onclick="pqCheckDns()">查询域名</button>
      <div id="pq-dns-result" style="margin-top:14px"></div>
    </div>`;
  } else if (tab === 'resolve') {
    box.innerHTML = `<div class="card" style="padding:20px">
      <div style="font-size:12px;color:var(--g500);margin-bottom:14px">用全球多个公共 DNS 分别解析，对比各家返回的 IP 是否一致</div>
      <div class="field" style="margin-bottom:12px">
        <label style="font-size:12px;margin-bottom:4px;display:block">域名</label>
        <input type="text" id="pq-dnsnw-domain" placeholder="如 www.example.com" onkeydown="if(event.key==='Enter')pqCheckDnsNationwide()">
      </div>
      <button class="btn-primary btn-sm" onclick="pqCheckDnsNationwide()">检测解析</button>
      <div id="pq-dnsnw-result" style="margin-top:14px"></div>
    </div>`;
  } else {
    box.innerHTML = `<div class="card" style="padding:20px">
      <div style="font-size:12px;color:var(--g500);margin-bottom:14px">输入公网 IP，查询归属地、运营商（ISP）及 AS 信息</div>
      <div class="field" style="margin-bottom:12px">
        <label style="font-size:12px;margin-bottom:4px;display:block">IP 地址</label>
        <input type="text" id="pq-ip-addr" placeholder="如 8.8.8.8" onkeydown="if(event.key==='Enter')pqCheckIp()">
      </div>
      <button class="btn-primary btn-sm" onclick="pqCheckIp()">查询 IP</button>
      <div id="pq-ip-result" style="margin-top:14px"></div>
    </div>`;
  }
}

async function pqCheckBucket() {
  const platform = document.getElementById('pq-bucket-platform').value;
  const ak = document.getElementById('pq-ak').value.trim();
  const sk = document.getElementById('pq-sk').value.trim();
  const bucket = document.getElementById('pq-bucket-name').value.trim();
  const region = document.getElementById('pq-bucket-region').value.trim();
  const path = document.getElementById('pq-bucket-path').value.trim();
  const wrap = document.getElementById('pq-bucket-result');

  if (!ak || !sk) { wrap.innerHTML = '<div style="color:var(--danger);font-size:13px">请输入 AK 和 SK</div>'; return; }
  if (!bucket) { wrap.innerHTML = '<div style="color:var(--danger);font-size:13px">请输入存储桶名称</div>'; return; }
  if (!region) { wrap.innerHTML = '<div style="color:var(--danger);font-size:13px">请选择地域</div>'; return; }

  wrap.innerHTML = '<div style="color:var(--g400);font-size:13px">校验中...</div>';
  const r = await post('/storage/check-permission', { platform, ak, sk, bucket, region, path });

  if (!r.ok) {
    wrap.innerHTML = `<div style="color:var(--danger);font-size:13px">${r.data?.error || '校验失败'}</div>`;
    return;
  }

  const d = r.data;
  const PLABEL = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
  const pathInfo = path ? ` | 路径：${esc(path)}` : '';

  // 读、写各自独立展示；始终校验读，写入无论有无权限都返回其结果
  const allOk = d.readable && d.writable;
  const anyOk = d.readable || d.writable;
  const boxBg = anyOk ? (allOk ? '#e8f5e9' : '#fff8e1') : '#ffebee';
  const boxBorder = anyOk ? (allOk ? '#a5d6a7' : '#ffe082') : '#ef9a9a';
  const titleColor = anyOk ? (allOk ? '#2e7d32' : '#f57f17') : '#c62828';
  const titleIcon = allOk ? '✓ 读写权限均具备' : anyOk ? '⚠ 部分权限' : '✗ 无权限';

  const rowHtml = (label, ok, errMsg) => `
    <div style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid rgba(0,0,0,.05)">
      <span style="min-width:72px;color:var(--g600)">${label}</span>
      <span style="font-weight:600;color:${ok ? '#388e3c' : '#d32f2f'}">${ok ? '✓ 有' : '✗ 无'}</span>
      ${!ok && errMsg ? `<span style="flex:1;font-size:11.5px;color:var(--g500);word-break:break-all">${esc(errMsg)}</span>` : ''}
    </div>`;

  wrap.innerHTML = `
    <div style="background:${boxBg};border:1px solid ${boxBorder};border-radius:8px;padding:14px;font-size:13px">
      <div style="font-weight:600;color:${titleColor};margin-bottom:8px">${titleIcon}</div>
      ${rowHtml('读取权限', d.readable, d.readError)}
      ${rowHtml('写入权限', d.writable, d.writeError)}
      <div style="margin-top:8px;font-size:12px;color:var(--g500)">平台：${PLABEL[platform] || platform} | 存储桶：<code style="background:rgba(0,0,0,.06);padding:1px 6px;border-radius:3px">${esc(bucket)}${path ? '/' + esc(path) : ''}</code>${pathInfo}</div>
    </div>`;
}

async function pqCheckDns() {
  const domain = document.getElementById('pq-dns-domain').value.trim();
  const wrap = document.getElementById('pq-dns-result');

  if (!domain) { wrap.innerHTML = '<div style="color:var(--danger);font-size:13px">请输入域名</div>'; return; }

  wrap.innerHTML = '<div style="color:var(--g400);font-size:13px">查询中...</div>';
  const r = await get(`/sync/check-dns?domain=${encodeURIComponent(domain)}`);

  if (!r.ok) {
    wrap.innerHTML = `<div style="color:var(--danger);font-size:13px">${r.data?.error || '查询失败'}</div>`;
    return;
  }

  const d = r.data;
  const PLABEL = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };

  if (d.found) {
    const rows = d.records.map(r => `<tr>
      <td><span class="badge badge-info" style="font-size:10px">${PLABEL[r.platform] || r.platform}</span></td>
      <td style="font-family:monospace;font-size:12px">${esc(r.record_name || '')}</td>
      <td><span class="badge badge-gray" style="font-size:10px">${esc(r.record_type || '')}</span></td>
      <td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.record_value || '')}">${esc(r.record_value || '-')}</td>
      <td style="font-size:12px;color:var(--g500)">${esc(r.zone_name || '')}</td>
    </tr>`).join('');
    wrap.innerHTML = `
      <div style="background:#fff3e0;border:1px solid #ffcc80;border-radius:8px;padding:14px;font-size:13px;margin-bottom:10px">
        <span style="font-weight:600;color:#e65100">⚠ 域名已被使用</span>
        <span style="color:#bf360c;margin-left:8px">找到 ${d.records.length} 条匹配记录</span>
      </div>
      <table class="acc-table"><thead><tr><th>平台</th><th>记录名</th><th>类型</th><th>值</th><th>域</th></tr></thead><tbody>${rows}</tbody></table>`;
  } else {
    wrap.innerHTML = `
      <div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:14px;font-size:13px">
        <span style="font-weight:600;color:#2e7d32">✓ 域名未使用</span>
        <span style="color:#388e3c;margin-left:8px">未找到 <code style="background:#c8e6c9;padding:1px 5px;border-radius:3px">${esc(domain)}</code> 的 DNS 记录</span>
      </div>`;
  }
}

async function pqCheckIp() {
  const ip = document.getElementById('pq-ip-addr').value.trim();
  const wrap = document.getElementById('pq-ip-result');

  if (!ip) { wrap.innerHTML = '<div style="color:var(--danger);font-size:13px">请输入 IP 地址</div>'; return; }

  wrap.innerHTML = '<div style="color:var(--g400);font-size:13px">查询中...</div>';
  const r = await get(`/sync/ip-info?ip=${encodeURIComponent(ip)}`);

  if (!r.ok) {
    wrap.innerHTML = `<div style="color:var(--danger);font-size:13px">${esc(r.data?.error || '查询失败')}</div>`;
    return;
  }

  const d = r.data;
  wrap.innerHTML = `
    <div style="background:#e3f2fd;border:1px solid #90caf9;border-radius:8px;padding:14px;font-size:13px">
      <div style="font-weight:600;color:#1565c0;margin-bottom:8px">📍 <code style="background:#bbdefb;padding:1px 6px;border-radius:3px">${esc(d.ip)}</code></div>
      <div style="display:flex;gap:8px;padding:6px 0">
        <span style="min-width:80px;color:var(--g600)">归属地</span>
        <span style="flex:1;word-break:break-all;font-weight:600">${esc(d.location || '-')}</span>
      </div>
    </div>`;
}

async function pqCheckDnsNationwide() {
  const domain = document.getElementById('pq-dnsnw-domain').value.trim();
  const wrap = document.getElementById('pq-dnsnw-result');

  if (!domain) { wrap.innerHTML = '<div style="color:var(--danger);font-size:13px">请输入域名</div>'; return; }

  wrap.innerHTML = '<div style="color:var(--g400);font-size:13px">检测中，请稍候...</div>';
  const r = await get(`/sync/dns-nationwide?domain=${encodeURIComponent(domain)}`);

  if (!r.ok) {
    wrap.innerHTML = `<div style="color:var(--danger);font-size:13px">${esc(r.data?.error || '检测失败')}</div>`;
    return;
  }

  const d = r.data;
  const rows = d.results.map(x => {
    const val = x.ok
      ? `<span style="font-family:monospace;font-size:12px">${x.ips.length ? esc(x.ips.join(', ')) : '无 A 记录'}</span>`
      : `<span style="color:#d32f2f;font-size:12px">${esc(x.error || '解析失败')}</span>`;
    return `<tr>
      <td>${esc(x.name)}</td>
      <td style="font-size:11px;color:var(--g500)">${esc(x.region || '')}</td>
      <td style="font-family:monospace;font-size:11px;color:var(--g500)">${esc(x.server)}</td>
      <td><span style="font-weight:600;color:${x.ok ? '#388e3c' : '#d32f2f'}">${x.ok ? '✓' : '✗'}</span></td>
      <td>${val}</td>
    </tr>`;
  }).join('');

  const banner = d.consistent
    ? `<div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:14px;font-size:13px;margin-bottom:10px">
         <span style="font-weight:600;color:#2e7d32">✓ 解析结果一致</span>
         <span style="color:#388e3c;margin-left:8px">各公共 DNS 返回相同的解析结果</span>
       </div>`
    : `<div style="background:#fff3e0;border:1px solid #ffcc80;border-radius:8px;padding:14px;font-size:13px;margin-bottom:10px">
         <span style="font-weight:600;color:#e65100">⚠ 解析结果不一致</span>
         <span style="color:#bf360c;margin-left:8px">共有 ${d.distinctCount} 种不同的解析结果，可能存在解析未同步或 CDN 分区调度</span>
       </div>`;

  wrap.innerHTML = banner +
    `<table class="acc-table"><thead><tr><th>DNS 服务商</th><th>区域</th><th>服务器</th><th>状态</th><th>解析 IP</th></tr></thead><tbody>${rows}</tbody></table>`;
}
