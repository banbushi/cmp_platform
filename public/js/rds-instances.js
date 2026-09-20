// ─────────────────────────────────────────
// 数据库实例管理（MySQL / PostgreSQL / Redis 分页）
// ─────────────────────────────────────────

let allRdsInstances = [];
const engineFilters = { mysql: 'all', postgres: 'all', redis: 'all' };

function engineMatch(inst, engineType) {
  const e = (inst.engine || '').toLowerCase();
  if (engineType === 'mysql')    return e.includes('mysql');
  if (engineType === 'postgres') return e.includes('postgres');
  if (engineType === 'redis')    return e.includes('redis');
  return false;
}

function isRunning(inst) {
  const s = (inst.status || '').toLowerCase();
  return s.includes('running') || s.includes('available');
}

async function loadRdsInstances() {
  const r = await get('/rds/instances');
  if (!r.ok) { toast('加载数据库实例失败', 'error'); return; }
  allRdsInstances = r.data.instances || [];
  renderEngineSection('mysql');
  renderEngineSection('postgres');
  renderEngineSection('redis');
}

function renderEngineSection(engineType) {
  const items = allRdsInstances.filter(i => engineMatch(i, engineType));
  const platformFilter = engineFilters[engineType];

  // stats
  document.getElementById(`${engineType}-count-aws`).textContent     = items.filter(i => i.platform === 'aws').length;
  document.getElementById(`${engineType}-count-aliyun`).textContent  = items.filter(i => i.platform === 'aliyun').length;
  document.getElementById(`${engineType}-count-baidu`).textContent   = items.filter(i => i.platform === 'baidu').length;
  document.getElementById(`${engineType}-count-running`).textContent = items.filter(isRunning).length;

  // filter + keyword
  const keyword = (document.getElementById(`${engineType}-keyword`)?.value || '').trim().toLowerCase();
  const filtered = items.filter(i => {
    if (platformFilter !== 'all' && i.platform !== platformFilter) return false;
    if (keyword) {
      const n = (i.instance_name || '').toLowerCase();
      const id = (i.instance_id || '').toLowerCase();
      if (!n.includes(keyword) && !id.includes(keyword)) return false;
    }
    return true;
  });

  renderEngineTable(engineType, filtered);
}

function renderEngineTable(engineType, list) {
  const wrap = document.getElementById(`${engineType}-table-wrap`);
  if (!list.length) {
    wrap.innerHTML = '<div class="empty-tip">暂无数据</div>';
    return;
  }

  const PLATFORM_LABEL = { aws: 'AWS RDS', aliyun: '阿里云 RDS', baidu: '百度云 RDS' };
  const PLATFORM_COLOR = { aws: '#FF9900', aliyun: '#FF6A00', baidu: '#2932E1' };

  const rows = list.map(i => {
    const plLabel = PLATFORM_LABEL[i.platform] || i.platform;
    const plColor = PLATFORM_COLOR[i.platform] || 'var(--g500)';
    const running = isRunning(i);
    const statusColor = running ? '#10b981' : '#f59e0b';
    return `<tr>
      <td><div style="display:inline-block;padding:2px 8px;border-radius:4px;background:${plColor}15;color:${plColor};font-size:11px;font-weight:600">${esc(plLabel)}</div></td>
      <td style="font-weight:600;color:var(--g900)">${esc(i.instance_name || '-')}</td>
      <td style="font-family:monospace;font-size:12px;color:var(--g600)">${esc(i.instance_id || '-')}</td>
      <td>${esc(i.engine || '-')} ${esc(i.engine_version || '')}</td>
      <td style="font-size:12px;color:var(--g600)">${esc(i.instance_class || '-')}</td>
      <td><span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${statusColor}15;color:${statusColor};font-size:11px;font-weight:600">${esc(i.status || '-')}</span></td>
      <td>${esc(i.region || '-')}</td>
      <td style="font-family:monospace;font-size:12px;color:var(--g600);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.endpoint || '-')}</td>
      <td style="color:var(--g500);font-size:12px">${i.synced_at ? i.synced_at.slice(0,16).replace('T',' ') : '-'}</td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `<div class="sync-table-container"><table class="sync-table" style="min-width:1100px">
    <thead><tr>
      <th style="width:80px">云平台</th>
      <th style="width:160px">实例名称</th>
      <th style="width:180px">实例 ID</th>
      <th style="width:110px">引擎</th>
      <th style="width:110px">规格</th>
      <th style="width:90px">状态</th>
      <th style="width:120px">地域</th>
      <th>连接地址</th>
      <th style="width:120px;white-space:nowrap">同步时间</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function setEngineFilter(engineType, platform, btn) {
  engineFilters[engineType] = platform;
  const section = document.getElementById(`sec-rds-${engineType}`);
  section.querySelectorAll('.sync-filter-tabs .filter-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderEngineSection(engineType);
}

function onEngineSearch(engineType) {
  renderEngineSection(engineType);
}

async function syncRdsInstances(platform) {
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = '同步中...'; }

  const r = await post(`/rds/sync/${platform}`);

  if (btn) { btn.disabled = false; btn.textContent = '⇄ 同步实例'; }

  if (!r.ok) { toast('同步失败: ' + (r.data?.error || '未知错误'), 'err'); return; }

  const results = r.data.results || [];
  const successCount = results.filter(x => x.success).length;
  const totalCount   = results.reduce((sum, x) => sum + (x.count || 0), 0);
  toast(`同步完成：${successCount}/${results.length} 个平台成功，共 ${totalCount} 个实例`, 'ok');
  loadRdsInstances();
}

// ─────────────────────────────────────────
// 创建数据库实例（管理员直接创建，精简必填 + 合理默认）
// ─────────────────────────────────────────
const DB_REGIONS = {
  aws:    [
    ['us-west-2','us-west-2 (US West Oregon)'],['us-west-1','us-west-1 (US West N. California)'],
    ['us-east-1','us-east-1 (US East N. Virginia)'],['us-east-2','us-east-2 (US East Ohio)'],
    ['ca-central-1','ca-central-1 (Canada Central)'],
    ['sa-east-1','sa-east-1 (South America São Paulo)'],
    ['eu-west-1','eu-west-1 (Europe Ireland)'],['eu-west-2','eu-west-2 (Europe London)'],['eu-west-3','eu-west-3 (Europe Paris)'],
    ['eu-central-1','eu-central-1 (Europe Frankfurt)'],['eu-central-2','eu-central-2 (Europe Zurich)'],
    ['eu-north-1','eu-north-1 (Europe Stockholm)'],['eu-south-1','eu-south-1 (Europe Milan)'],['eu-south-2','eu-south-2 (Europe Spain)'],
    ['ap-northeast-1','ap-northeast-1 (Asia Pacific Tokyo)'],['ap-northeast-2','ap-northeast-2 (Asia Pacific Seoul)'],['ap-northeast-3','ap-northeast-3 (Asia Pacific Osaka)'],
    ['ap-southeast-1','ap-southeast-1 (Asia Pacific Singapore)'],['ap-southeast-2','ap-southeast-2 (Asia Pacific Sydney)'],['ap-southeast-3','ap-southeast-3 (Asia Pacific Jakarta)'],['ap-southeast-4','ap-southeast-4 (Asia Pacific Melbourne)'],
    ['ap-south-1','ap-south-1 (Asia Pacific Mumbai)'],
    ['me-south-1','me-south-1 (Middle East Bahrain)'],['me-central-1','me-central-1 (Middle East UAE)'],
    ['af-south-1','af-south-1 (Africa Cape Town)'],
  ],
  aliyun: [['cn-hangzhou','华东1 杭州'],['cn-shanghai','华东2 上海'],['cn-beijing','华北2 北京'],['cn-shenzhen','华南1 深圳'],['cn-hongkong','中国香港']],
  baidu:  [['bj','华北-北京'],['gz','华南-广州'],['su','华东-苏州'],['hkg','港澳台-香港']],
};
// ── 各云 × 引擎的常用「版本」枚举（静态维护，覆盖主流选项；新版本需手动补表）──
const DB_VERSIONS = {
  aws: {
    mysql:    ['8.4.6', '8.4.5', '8.4.4', '8.4.3', '8.0.43', '8.0.42', '8.0.41', '8.0.40', '8.0.39', '8.0.37', '8.0.36', '8.0.35', '5.7.44'],
    postgres: ['17.5', '17.4', '17.2', '16.9', '16.8', '16.6', '15.13', '15.12', '15.10', '14.18', '14.17', '14.15', '13.21', '13.20'],
    redis:    ['7.1', '7.0', '6.2', '5.0.6'],
  },
  aliyun: {
    mysql:    ['8.0', '5.7', '5.6'],
    postgres: ['16.0', '15.0', '14.0', '13.0'],
    redis:    ['7.0', '6.0', '5.0'],
  },
  baidu: {
    mysql:    ['8.0', '5.7', '5.6'],
    postgres: ['15', '14', '13', '12'],
    redis:    ['5.0', '4.0', '3.2'],
  },
};
// ── 各云 × 引擎的常用「规格」枚举（静态维护）──
// AWS 的 MySQL/PostgreSQL 按实例类分类：可突增(t)/标准(m)/内存优化(r,x)，值为对象 { 分类: [[值,label]] }
// 其余（AWS Redis、阿里云、百度云）为扁平数组 [[值,label]]，无分类选择器
// 百度云 RDS(mysql/postgres) 按 CPU/内存创建，值格式 "cpu:mem"，提交时拆成 cpuCount/memoryGb
const CLASS_CAT_LABELS = { burstable: '可突增类 (t)', standard: '标准类 (m)', memory: '内存优化类 (r/x)' };
const CLASS_CAT_ORDER = ['standard', 'memory', 'burstable'];
const DB_CLASSES = {
  aws: {
    mysql: {
      burstable: [
        ['db.t4g.micro','db.t4g.micro (2C1G)'],['db.t4g.small','db.t4g.small (2C2G)'],['db.t4g.medium','db.t4g.medium (2C4G)'],['db.t4g.large','db.t4g.large (2C8G)'],['db.t4g.xlarge','db.t4g.xlarge (4C16G)'],['db.t4g.2xlarge','db.t4g.2xlarge (8C32G)'],
        ['db.t3.micro','db.t3.micro (2C1G)'],['db.t3.small','db.t3.small (2C2G)'],['db.t3.medium','db.t3.medium (2C4G)'],['db.t3.large','db.t3.large (2C8G)'],['db.t3.xlarge','db.t3.xlarge (4C16G)'],['db.t3.2xlarge','db.t3.2xlarge (8C32G)'],
      ],
      standard:  [
        ['db.m7g.large','db.m7g.large (2C8G)'],['db.m7g.xlarge','db.m7g.xlarge (4C16G)'],['db.m7g.2xlarge','db.m7g.2xlarge (8C32G)'],['db.m7g.4xlarge','db.m7g.4xlarge (16C64G)'],['db.m7g.8xlarge','db.m7g.8xlarge (32C128G)'],
        ['db.m6g.large','db.m6g.large (2C8G)'],['db.m6g.xlarge','db.m6g.xlarge (4C16G)'],['db.m6g.2xlarge','db.m6g.2xlarge (8C32G)'],['db.m6g.4xlarge','db.m6g.4xlarge (16C64G)'],['db.m6g.8xlarge','db.m6g.8xlarge (32C128G)'],
        ['db.m6i.large','db.m6i.large (2C8G)'],['db.m6i.xlarge','db.m6i.xlarge (4C16G)'],['db.m6i.2xlarge','db.m6i.2xlarge (8C32G)'],['db.m6i.4xlarge','db.m6i.4xlarge (16C64G)'],
        ['db.m5.large','db.m5.large (2C8G)'],['db.m5.xlarge','db.m5.xlarge (4C16G)'],['db.m5.2xlarge','db.m5.2xlarge (8C32G)'],['db.m5.4xlarge','db.m5.4xlarge (16C64G)'],
      ],
      memory:    [
        ['db.r7g.large','db.r7g.large (2C16G)'],['db.r7g.xlarge','db.r7g.xlarge (4C32G)'],['db.r7g.2xlarge','db.r7g.2xlarge (8C64G)'],['db.r7g.4xlarge','db.r7g.4xlarge (16C128G)'],['db.r7g.8xlarge','db.r7g.8xlarge (32C256G)'],
        ['db.r6g.large','db.r6g.large (2C16G)'],['db.r6g.xlarge','db.r6g.xlarge (4C32G)'],['db.r6g.2xlarge','db.r6g.2xlarge (8C64G)'],['db.r6g.4xlarge','db.r6g.4xlarge (16C128G)'],
        ['db.r6i.large','db.r6i.large (2C16G)'],['db.r6i.xlarge','db.r6i.xlarge (4C32G)'],['db.r6i.2xlarge','db.r6i.2xlarge (8C64G)'],['db.r6i.4xlarge','db.r6i.4xlarge (16C128G)'],
        ['db.r5.large','db.r5.large (2C16G)'],['db.r5.xlarge','db.r5.xlarge (4C32G)'],['db.r5.2xlarge','db.r5.2xlarge (8C64G)'],
        ['db.x2g.large','db.x2g.large (2C32G)'],['db.x2g.xlarge','db.x2g.xlarge (4C64G)'],['db.x2g.2xlarge','db.x2g.2xlarge (8C128G)'],
      ],
    },
    postgres: {
      burstable: [
        ['db.t4g.micro','db.t4g.micro (2C1G)'],['db.t4g.small','db.t4g.small (2C2G)'],['db.t4g.medium','db.t4g.medium (2C4G)'],['db.t4g.large','db.t4g.large (2C8G)'],['db.t4g.xlarge','db.t4g.xlarge (4C16G)'],['db.t4g.2xlarge','db.t4g.2xlarge (8C32G)'],
        ['db.t3.micro','db.t3.micro (2C1G)'],['db.t3.small','db.t3.small (2C2G)'],['db.t3.medium','db.t3.medium (2C4G)'],['db.t3.large','db.t3.large (2C8G)'],['db.t3.xlarge','db.t3.xlarge (4C16G)'],['db.t3.2xlarge','db.t3.2xlarge (8C32G)'],
      ],
      standard:  [
        ['db.m7g.large','db.m7g.large (2C8G)'],['db.m7g.xlarge','db.m7g.xlarge (4C16G)'],['db.m7g.2xlarge','db.m7g.2xlarge (8C32G)'],['db.m7g.4xlarge','db.m7g.4xlarge (16C64G)'],['db.m7g.8xlarge','db.m7g.8xlarge (32C128G)'],
        ['db.m6g.large','db.m6g.large (2C8G)'],['db.m6g.xlarge','db.m6g.xlarge (4C16G)'],['db.m6g.2xlarge','db.m6g.2xlarge (8C32G)'],['db.m6g.4xlarge','db.m6g.4xlarge (16C64G)'],['db.m6g.8xlarge','db.m6g.8xlarge (32C128G)'],
        ['db.m6i.large','db.m6i.large (2C8G)'],['db.m6i.xlarge','db.m6i.xlarge (4C16G)'],['db.m6i.2xlarge','db.m6i.2xlarge (8C32G)'],['db.m6i.4xlarge','db.m6i.4xlarge (16C64G)'],
        ['db.m5.large','db.m5.large (2C8G)'],['db.m5.xlarge','db.m5.xlarge (4C16G)'],['db.m5.2xlarge','db.m5.2xlarge (8C32G)'],['db.m5.4xlarge','db.m5.4xlarge (16C64G)'],
      ],
      memory:    [
        ['db.r7g.large','db.r7g.large (2C16G)'],['db.r7g.xlarge','db.r7g.xlarge (4C32G)'],['db.r7g.2xlarge','db.r7g.2xlarge (8C64G)'],['db.r7g.4xlarge','db.r7g.4xlarge (16C128G)'],['db.r7g.8xlarge','db.r7g.8xlarge (32C256G)'],
        ['db.r6g.large','db.r6g.large (2C16G)'],['db.r6g.xlarge','db.r6g.xlarge (4C32G)'],['db.r6g.2xlarge','db.r6g.2xlarge (8C64G)'],['db.r6g.4xlarge','db.r6g.4xlarge (16C128G)'],
        ['db.r6i.large','db.r6i.large (2C16G)'],['db.r6i.xlarge','db.r6i.xlarge (4C32G)'],['db.r6i.2xlarge','db.r6i.2xlarge (8C64G)'],['db.r6i.4xlarge','db.r6i.4xlarge (16C128G)'],
        ['db.r5.large','db.r5.large (2C16G)'],['db.r5.xlarge','db.r5.xlarge (4C32G)'],['db.r5.2xlarge','db.r5.2xlarge (8C64G)'],
        ['db.x2g.large','db.x2g.large (2C32G)'],['db.x2g.xlarge','db.x2g.xlarge (4C64G)'],['db.x2g.2xlarge','db.x2g.2xlarge (8C128G)'],
      ],
    },
    redis:    [['cache.t3.micro','cache.t3.micro (0.5G)'],['cache.t3.small','cache.t3.small (1.4G)'],['cache.m6g.large','cache.m6g.large (6.4G)']],
  },
  aliyun: {
    mysql:    [['mysql.n2.medium.1','2C4G 通用(mysql.n2.medium.1)'],['mysql.n2.large.1','4C8G(mysql.n2.large.1)'],['mysql.n4.large.1','4C16G(mysql.n4.large.1)']],
    postgres: [['pg.n2.small.1','1C2G(pg.n2.small.1)'],['pg.n2.medium.1','2C4G(pg.n2.medium.1)'],['pg.n2.large.1','4C8G(pg.n2.large.1)']],
    redis:    [['redis.master.small.default','1G 主从(small)'],['redis.master.mid.default','2G 主从(mid)'],['redis.master.large.default','4G 主从(large)']],
  },
  baidu: {
    // 百度云 RDS 按 CPU/内存，值 "cpu:mem"
    mysql:    [['1:2','1C2G'],['2:4','2C4G'],['2:8','2C8G'],['4:16','4C16G']],
    postgres: [['1:2','1C2G'],['2:4','2C4G'],['2:8','2C8G'],['4:16','4C16G']],
    redis:    [['cache.n1.micro','1G(cache.n1.micro)'],['cache.n1.small','2G(cache.n1.small)'],['cache.n1.medium','4G(cache.n1.medium)']],
  },
};

// ── 磁盘类型枚举（仅列出支持磁盘类型选择的平台）──
// AWS: gp2/gp3/io1；阿里云 essd 系列；百度云 IO 类型。空数组=该平台不展示磁盘类型选择
const DB_STORAGE_TYPES = {
  aws:    [['gp3','gp3 (通用SSD, 可调IOPS)'],['gp2','gp2 (通用SSD)'],['io1','io1 (预置IOPS)']],
  aliyun: [['cloud_essd','ESSD 云盘'],['cloud_ssd','SSD 云盘'],['cloud_essd2','ESSD PL2']],
  baidu:  [['cloud_high','高性能云盘'],['cloud_enha','增强型SSD']],
};
// 百度云 RDS 走 CPU/内存创建（规格值为 "cpu:mem"）
function isBaiduCpuMem(platform, engineKind) { return platform === 'baidu' && engineKind !== 'redis'; }
const ENGINE_LABEL = { mysql: 'MySQL', postgres: 'PostgreSQL', redis: 'Redis' };

function showCreateDbInstanceModal(engineKind) {
  let modal = document.getElementById('modal-create-db');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-create-db';
    modal.className = 'modal-overlay hidden';
    modal.onclick = () => modal.classList.add('hidden');
    modal.innerHTML = `<div class="modal" style="width:520px;max-width:95vw" onclick="event.stopPropagation()">
      <div class="modal-header"><h3 id="cdb-title">创建实例</h3><button class="modal-close" onclick="document.getElementById('modal-create-db').classList.add('hidden')">✕</button></div>
      <div style="padding:20px 24px;display:flex;flex-direction:column;gap:13px;max-height:70vh;overflow-y:auto">
        <input type="hidden" id="cdb-engine">
        <div class="field"><label>云平台 <span class="req">*</span></label>
          <select id="cdb-platform" onchange="_cdbOnPlatformChange()" style="margin-top:6px">
            <option value="aliyun">阿里云</option><option value="aws">AWS</option><option value="baidu">百度云</option>
          </select>
        </div>
        <div class="field" id="cdb-role-wrap"><label>实例类型 <span class="req">*</span></label>
          <select id="cdb-role" onchange="_cdbOnRoleChange()" style="margin-top:6px">
            <option value="primary">读写实例（主实例）</option>
            <option value="replica">只读实例（只读副本）</option>
          </select>
        </div>
        <div class="field hidden" id="cdb-source-wrap">
          <label style="display:flex;align-items:center;justify-content:space-between">
            <span>源实例 <span class="req">*</span></span>
            <span style="font-size:11.5px;color:var(--g400)">只读副本从该实例派生</span>
          </label>
          <select id="cdb-source" style="margin-top:6px"><option value="">请选择源实例</option></select>
        </div>
        <div class="field"><label>地域 <span class="req">*</span></label>
          <select id="cdb-region" onchange="_cdbOnRegionChange()" style="margin-top:6px"></select>
        </div>
        <div class="field"><label>实例名称</label>
          <input type="text" id="cdb-name" placeholder="留空则自动生成" style="margin-top:6px">
        </div>
        <div class="field" id="cdb-version-wrap"><label>引擎版本 <span class="req">*</span></label>
          <select id="cdb-version" style="margin-top:6px"></select>
        </div>
        <div class="field hidden" id="cdb-cat-wrap"><label>数据库实例类</label>
          <select id="cdb-cat" onchange="_cdbOnCatChange()" style="margin-top:6px"></select>
        </div>
        <div class="field"><label id="cdb-class-label">实例规格 <span class="req">*</span></label>
          <div id="cdb-class-filter" style="display:flex;gap:8px;margin-top:6px">
            <select id="cdb-filter-cpu" onchange="_cdbOnClassFilterChange()" style="flex:1"><option value="">全部 CPU</option></select>
            <select id="cdb-filter-mem" onchange="_cdbOnClassFilterChange()" style="flex:1"><option value="">全部内存</option></select>
          </div>
          <select id="cdb-class" style="margin-top:6px"></select>
        </div>
        <div class="field hidden" id="cdb-storagetype-wrap"><label>磁盘类型</label>
          <select id="cdb-storagetype" onchange="_cdbOnStorageTypeChange()" style="margin-top:6px;width:100%"></select>
        </div>
        <div class="field" id="cdb-storage-wrap"><label>存储空间 (GiB)</label>
          <input type="number" id="cdb-storage" value="20" min="20" style="margin-top:6px">
          <div id="cdb-storage-hint" style="font-size:11.5px;color:var(--g400);margin-top:4px"></div>
        </div>
        <div class="field hidden" id="cdb-iops-wrap"><label>预置 IOPS</label>
          <input type="number" id="cdb-iops" placeholder="如 3000" style="margin-top:6px;width:100%">
          <div id="cdb-iops-hint" style="font-size:11.5px;color:var(--g400);margin-top:4px"></div>
        </div>
        <div class="field hidden" id="cdb-throughput-wrap"><label>存储吞吐量 (MiBps)</label>
          <input type="number" id="cdb-throughput" placeholder="如 125" style="margin-top:6px;width:100%">
          <div id="cdb-throughput-hint" style="font-size:11.5px;color:var(--g400);margin-top:4px"></div>
        </div>
        <div class="field hidden" id="cdb-autoscale-wrap">
          <label style="display:flex;align-items:center;gap:6px;margin-top:2px">
            <input type="checkbox" id="cdb-autoscale" onchange="_cdbOnAutoscaleChange()" style="width:auto">启用存储自动扩展
          </label>
          <div id="cdb-autoscale-max-wrap" class="hidden" style="margin-top:6px">
            <input type="number" id="cdb-autoscale-max" placeholder="最大存储阈值 (GiB)" style="width:100%">
            <div style="font-size:11.5px;color:var(--g400);margin-top:4px">存储用量接近上限时自动扩容，不超过该阈值</div>
          </div>
        </div>
        <div class="field" id="cdb-pwd-wrap"><label id="cdb-pwd-label">访问密码 <span class="req" id="cdb-pwd-req"></span></label>
          <input type="password" id="cdb-password" placeholder="请输入访问密码" style="margin-top:6px">
          <div style="font-size:11.5px;color:var(--g400);margin-top:4px">至少 8 位，含大小写字母和数字</div>
        </div>
        <div class="field" id="cdb-vpc-wrap">
          <label style="display:flex;align-items:center;justify-content:space-between">
            <span id="cdb-vpc-label">VPC / 子网（可选，阿里云/AWS）</span>
            <span id="cdb-vpc-sync" onclick="_cdbSyncVpc()" style="font-size:11.5px;color:var(--primary,#2563eb);cursor:pointer">↻ 同步网络</span>
          </label>
          <div style="display:flex;gap:8px;margin-top:6px">
            <select id="cdb-vpc" onchange="_cdbOnVpcChange()" style="flex:1"><option value="">不指定（默认网络）</option></select>
            <select id="cdb-vswitch" style="flex:1"><option value="">不指定</option></select>
          </div>
        </div>
        <div class="field hidden" id="cdb-subnetgroup-wrap">
          <label style="display:flex;align-items:center;justify-content:space-between">
            <span>子网组 (DBSubnetGroup)</span>
            <span id="cdb-sng-sync" onclick="_cdbSyncSubnetGroup()" style="font-size:11.5px;color:var(--primary,#2563eb);cursor:pointer">↻ 同步子网组</span>
          </label>
          <select id="cdb-subnetgroup" style="margin-top:6px"><option value="">不指定（默认）</option></select>
          <div style="font-size:11.5px;color:var(--g400);margin-top:4px">AWS RDS 需含 ≥2 子网跨 ≥2 可用区的子网组</div>
        </div>
        <div class="field hidden" id="cdb-sg-wrap">
          <label style="display:flex;align-items:center;justify-content:space-between">
            <span>安全组（可多选）</span>
            <span id="cdb-sg-sync" onclick="_cdbSyncSg()" style="font-size:11.5px;color:var(--primary,#2563eb);cursor:pointer">↻ 同步安全组</span>
          </label>
          <input type="text" id="cdb-sg-search" oninput="_cdbFilterSg()" placeholder="搜索安全组名称 / ID" style="margin-top:6px">
          <div id="cdb-sg" style="margin-top:6px;max-height:140px;overflow-y:auto;border:1px solid var(--border,#d1d5db);border-radius:6px;padding:4px"></div>
          <div id="cdb-sg-selected" style="font-size:11.5px;color:var(--g500);margin-top:4px"></div>
        </div>
        <div class="field hidden" id="cdb-extra-wrap">
          <label style="display:flex;gap:20px;align-items:center;margin-top:2px">
            <span style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="cdb-multiaz" style="width:auto">多可用区部署 (Multi-AZ)</span>
            <span style="display:flex;align-items:center;gap:6px"><input type="checkbox" id="cdb-monitoring" style="width:auto">开启数据库监控</span>
          </label>
        </div>
        <div style="background:#FFFBEB;border:1px solid #FDE68A;border-radius:6px;padding:9px 12px;font-size:12px;color:#92400E">
          ⚠ 创建实例会产生真实云计费，请确认规格与计费方式。实例创建为异步操作，创建后需点「同步实例」刷新状态。
        </div>
        <div id="cdb-err" class="err-text"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn-ghost" onclick="document.getElementById('modal-create-db').classList.add('hidden')">取消</button>
          <button class="btn-primary" id="cdb-submit" onclick="submitCreateDbInstance()">创建</button>
        </div>
      </div></div>`;
    document.body.appendChild(modal);
  }
  document.getElementById('cdb-engine').value = engineKind;
  document.getElementById('cdb-title').textContent = `创建 ${ENGINE_LABEL[engineKind]} 实例`;
  document.getElementById('cdb-err').textContent = '';
  ['cdb-name','cdb-password','cdb-iops','cdb-throughput','cdb-autoscale-max','cdb-sg-search'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('cdb-storage').value = '20';
  document.getElementById('cdb-platform').value = 'aliyun';
  document.getElementById('cdb-role').value = 'primary';
  document.getElementById('cdb-multiaz').checked = false;
  document.getElementById('cdb-monitoring').checked = false;
  document.getElementById('cdb-autoscale').checked = false;
  _cdbSgPicked = new Set();
  _cdbUpdateSgSelected();
  _cdbOnPlatformChange();
  modal.classList.remove('hidden');
}

// 某平台某引擎的规格是否为分类结构（对象而非数组）
function _cdbIsCategorized(platform, engineKind) {
  const c = (DB_CLASSES[platform] || {})[engineKind];
  return c && !Array.isArray(c);
}

// 引擎版本缓存：key `${platform}:${region}:${engineKind}` → versions[]
const _cdbVerCache = {};

// 填充版本下拉：Redis 用静态枚举；MySQL/PostgreSQL 从云端动态拉取（按地域+引擎）
function _cdbFillVersions(platform, engineKind) {
  const verSel = document.getElementById('cdb-version');
  // Redis 维持静态枚举
  if (engineKind === 'redis') {
    const versions = (DB_VERSIONS[platform] || {}).redis || [];
    verSel.innerHTML = versions.map(v => `<option value="${v}">${v}</option>`).join('') || '<option value="">-</option>';
    return;
  }
  const region = document.getElementById('cdb-region').value;
  const key = `${platform}:${region}:${engineKind}`;
  if (_cdbVerCache[key]) { _cdbRenderVersions(_cdbVerCache[key]); return; }
  verSel.innerHTML = '<option value="">加载中...</option>';
  _cdbLoadVersions(platform, region, engineKind, key);
}

async function _cdbLoadVersions(platform, region, engineKind, key) {
  const verSel = document.getElementById('cdb-version');
  const r = await get(`/rds/engine-versions/${platform}?region=${encodeURIComponent(region)}&engineKind=${engineKind}`);
  // 防竞态：请求返回时若用户已切换平台/引擎/地域，丢弃过期结果
  const curKey = `${document.getElementById('cdb-platform').value}:${document.getElementById('cdb-region').value}:${document.getElementById('cdb-engine').value}`;
  if (curKey !== key) return;
  let versions = (r.ok && r.data.versions) ? r.data.versions : [];
  if (!versions.length) versions = (DB_VERSIONS[platform] || {})[engineKind] || [];
  _cdbVerCache[key] = versions;
  _cdbRenderVersions(versions);
}

function _cdbRenderVersions(versions) {
  const verSel = document.getElementById('cdb-version');
  verSel.innerHTML = versions.length
    ? versions.map(v => `<option value="${v}">${v}</option>`).join('')
    : '<option value="">无可用版本</option>';
}

// 当前分类下的完整规格列表（供 CPU/内存筛选复用，不必重算分类）
let _cdbClassList = [];

// 从规格 label 解析 CPU/内存，如 "db.m6g.large (2C8G)" → {cpu:2, mem:8}；解析不到返回 null
function _cdbParseCpuMem(label) {
  const m = /(\d+)\s*C\s*(\d+)\s*G/i.exec(label || '');
  return m ? { cpu: Number(m[1]), mem: Number(m[2]) } : null;
}

// 填充规格下拉：分类结构按当前选中分类取子表，扁平结构直接列出
function _cdbFillClasses(platform, engineKind) {
  const catWrap = document.getElementById('cdb-cat-wrap');
  const catSel = document.getElementById('cdb-cat');
  let list;
  if (_cdbIsCategorized(platform, engineKind)) {
    catWrap.classList.remove('hidden');
    const cats = DB_CLASSES[platform][engineKind];
    // 分类下拉（首次或平台切换后重建）
    const wantCats = CLASS_CAT_ORDER.filter(k => cats[k]);
    const curCats = [...catSel.options].map(o => o.value);
    if (wantCats.join() !== curCats.join()) {
      catSel.innerHTML = wantCats.map(k => `<option value="${k}">${CLASS_CAT_LABELS[k]}</option>`).join('');
    }
    const cat = catSel.value || wantCats[0];
    catSel.value = cat;
    list = cats[cat] || [];
  } else {
    catWrap.classList.add('hidden');
    list = (DB_CLASSES[platform] || {})[engineKind] || [];
  }
  _cdbClassList = list;
  // 重建 CPU/内存筛选下拉（依据当前分类的可解析规格）
  _cdbBuildClassFilters(list);
  _cdbRenderClassOptions();
  // 百度云 RDS 规格实为 CPU/内存组合，标签提示
  const label = document.getElementById('cdb-class-label');
  if (label) label.innerHTML = isBaiduCpuMem(platform, engineKind)
    ? '实例规格 (CPU/内存) <span class="req">*</span>'
    : '实例规格 <span class="req">*</span>';
}

// 用当前规格列表的可解析 CPU/内存值，重建两个筛选下拉的选项
function _cdbBuildClassFilters(list) {
  const cpuSel = document.getElementById('cdb-filter-cpu');
  const memSel = document.getElementById('cdb-filter-mem');
  const cpus = [...new Set(list.map(([, l]) => _cdbParseCpuMem(l)?.cpu).filter(Boolean))].sort((a, b) => a - b);
  const mems = [...new Set(list.map(([, l]) => _cdbParseCpuMem(l)?.mem).filter(Boolean))].sort((a, b) => a - b);
  // 无可解析 CPU/内存（如某些平台 label 不含），隐藏筛选行
  const filterWrap = document.getElementById('cdb-class-filter');
  if (!cpus.length && !mems.length) { filterWrap.style.display = 'none'; return; }
  filterWrap.style.display = 'flex';
  const prevCpu = cpuSel.value, prevMem = memSel.value;
  cpuSel.innerHTML = '<option value="">全部 CPU</option>' + cpus.map(c => `<option value="${c}">${c} 核</option>`).join('');
  memSel.innerHTML = '<option value="">全部内存</option>' + mems.map(m => `<option value="${m}">${m} GB</option>`).join('');
  // 尽量保留之前的筛选值
  if ([...cpuSel.options].some(o => o.value === prevCpu)) cpuSel.value = prevCpu;
  if ([...memSel.options].some(o => o.value === prevMem)) memSel.value = prevMem;
}

// 按 CPU/内存筛选后渲染规格下拉
function _cdbRenderClassOptions() {
  const classSel = document.getElementById('cdb-class');
  const cpu = document.getElementById('cdb-filter-cpu').value;
  const mem = document.getElementById('cdb-filter-mem').value;
  const filtered = _cdbClassList.filter(([, l]) => {
    if (!cpu && !mem) return true;
    const cm = _cdbParseCpuMem(l);
    if (!cm) return false;
    if (cpu && cm.cpu !== Number(cpu)) return false;
    if (mem && cm.mem !== Number(mem)) return false;
    return true;
  });
  classSel.innerHTML = filtered.length
    ? filtered.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')
    : '<option value="">无匹配规格</option>';
}

// CPU/内存筛选变化 → 仅重渲规格下拉
function _cdbOnClassFilterChange() { _cdbRenderClassOptions(); }

// 实例类分类切换 → 重置筛选并刷新规格下拉
function _cdbOnCatChange() {
  document.getElementById('cdb-filter-cpu').value = '';
  document.getElementById('cdb-filter-mem').value = '';
  _cdbFillClasses(document.getElementById('cdb-platform').value, document.getElementById('cdb-engine').value);
}

// 磁盘类型缓存：key `${platform}:${region}:${engineKind}` → [{value,label,...meta}]
const _cdbStCache = {};
// 当前平台的磁盘类型元数据（value → 完整对象），供切换时读约束
let _cdbStMeta = {};

// 把后端可能的多种格式统一成对象数组 [{value,label,...}]
function _cdbNormalizeStorageTypes(types, platform) {
  return (types || []).map(t => {
    if (Array.isArray(t)) return { value: t[0], label: t[1] };          // 旧 [v,l]
    if (typeof t === 'string') return { value: t, label: t };
    return t;                                                            // 已是富对象
  });
}

// 填充磁盘类型下拉：从云端动态拉取（按地域+引擎）
function _cdbFillStorageTypes(platform, engineKind) {
  const region = document.getElementById('cdb-region').value;
  const key = `${platform}:${region}:${engineKind}`;
  if (_cdbStCache[key]) { _cdbRenderStorageTypes(_cdbStCache[key]); return; }
  const sel = document.getElementById('cdb-storagetype');
  sel.innerHTML = '<option value="">加载中...</option>';
  _cdbLoadStorageTypes(platform, region, engineKind, key);
}

async function _cdbLoadStorageTypes(platform, region, engineKind, key) {
  const r = await get(`/rds/storage-types/${platform}?region=${encodeURIComponent(region)}&engineKind=${engineKind}`);
  // 防竞态：返回时若用户已切换平台/引擎/地域则丢弃
  const curKey = `${document.getElementById('cdb-platform').value}:${document.getElementById('cdb-region').value}:${document.getElementById('cdb-engine').value}`;
  if (curKey !== key) return;
  let types = (r.ok && r.data.storage_types) ? r.data.storage_types : [];
  types = _cdbNormalizeStorageTypes(types, platform);
  if (!types.length) types = _cdbNormalizeStorageTypes(DB_STORAGE_TYPES[platform] || [], platform);
  _cdbStCache[key] = types;
  _cdbRenderStorageTypes(types);
}

function _cdbRenderStorageTypes(types) {
  const sel = document.getElementById('cdb-storagetype');
  _cdbStMeta = {};
  types.forEach(t => { _cdbStMeta[t.value] = t; });
  sel.innerHTML = types.length
    ? types.map(t => `<option value="${t.value}">${t.label}</option>`).join('')
    : '<option value="">无可用磁盘类型</option>';
  _cdbOnStorageTypeChange();
}

// 磁盘类型切换 → 依据元数据显隐并约束 存储空间/IOPS/吞吐量/自动扩展
function _cdbOnStorageTypeChange() {
  const st = document.getElementById('cdb-storagetype').value;
  const m = _cdbStMeta[st] || {};
  // 存储空间 min/max
  const storageInput = document.getElementById('cdb-storage');
  const storageHint = document.getElementById('cdb-storage-hint');
  if (m.storageMin != null) {
    storageInput.min = m.storageMin;
    if (m.storageMax != null) storageInput.max = m.storageMax;
    if (Number(storageInput.value) < m.storageMin) storageInput.value = m.storageMin;
    storageHint.textContent = `范围 ${m.storageMin} ~ ${m.storageMax ?? '—'} GiB`;
  } else {
    storageHint.textContent = '';
  }
  // IOPS：supportsIops 才显示
  const iopsWrap = document.getElementById('cdb-iops-wrap');
  const iopsInput = document.getElementById('cdb-iops');
  const iopsHint = document.getElementById('cdb-iops-hint');
  if (m.supportsIops) {
    iopsWrap.classList.remove('hidden');
    if (m.iopsMin != null) { iopsInput.min = m.iopsMin; iopsInput.max = m.iopsMax ?? ''; iopsInput.placeholder = `${m.iopsMin} ~ ${m.iopsMax ?? '—'}`; }
    const perGib = (m.iopsPerGibMin != null) ? `，IOPS/GiB 比率 ${m.iopsPerGibMin}~${m.iopsPerGibMax}` : '';
    iopsHint.textContent = (m.iopsMin != null ? `范围 ${m.iopsMin} ~ ${m.iopsMax ?? '—'}` : '') + perGib;
  } else {
    iopsWrap.classList.add('hidden');
    iopsInput.value = '';
  }
  // 吞吐量：supportsThroughput（gp3）才显示
  const tpWrap = document.getElementById('cdb-throughput-wrap');
  const tpInput = document.getElementById('cdb-throughput');
  const tpHint = document.getElementById('cdb-throughput-hint');
  if (m.supportsThroughput) {
    tpWrap.classList.remove('hidden');
    if (m.throughputMin != null) { tpInput.min = m.throughputMin; tpInput.max = m.throughputMax ?? ''; tpInput.placeholder = `${m.throughputMin} ~ ${m.throughputMax ?? '—'}`; tpHint.textContent = `范围 ${m.throughputMin} ~ ${m.throughputMax ?? '—'} MiBps`; }
  } else {
    tpWrap.classList.add('hidden');
    tpInput.value = '';
  }
  // 存储自动扩展
  const asWrap = document.getElementById('cdb-autoscale-wrap');
  if (m.supportsAutoscaling) asWrap.classList.remove('hidden');
  else { asWrap.classList.add('hidden'); document.getElementById('cdb-autoscale').checked = false; _cdbOnAutoscaleChange(); }
}

// 自动扩展开关 → 显隐最大阈值输入
function _cdbOnAutoscaleChange() {
  const on = document.getElementById('cdb-autoscale').checked;
  const wrap = document.getElementById('cdb-autoscale-max-wrap');
  wrap.classList.toggle('hidden', !on);
  if (on) {
    const maxInput = document.getElementById('cdb-autoscale-max');
    const storage = Number(document.getElementById('cdb-storage').value) || 0;
    // 默认阈值给当前存储的约 2 倍，便于用户参考
    if (!maxInput.value && storage) maxInput.value = Math.min(storage * 2, 65536);
  }
}

// 实例类型（读写/只读）切换 → 只读展开源实例，并隐藏无关字段
function _cdbOnRoleChange() {
  const isReplica = document.getElementById('cdb-role').value === 'replica';
  document.getElementById('cdb-source-wrap').classList.toggle('hidden', !isReplica);
  // 只读副本继承源实例的版本/密码，隐藏这两项
  document.getElementById('cdb-version-wrap').classList.toggle('hidden', isReplica);
  document.getElementById('cdb-pwd-wrap').classList.toggle('hidden', isReplica);
  if (isReplica) _cdbFillSourceInstances();
}

// 填充源实例下拉：从已加载实例列表筛同平台、同引擎、主实例
function _cdbFillSourceInstances() {
  const platform = document.getElementById('cdb-platform').value;
  const engineKind = document.getElementById('cdb-engine').value;
  const sel = document.getElementById('cdb-source');
  const engLabel = ENGINE_LABEL[engineKind];
  const list = (allRdsInstances || []).filter(i =>
    i.platform === platform &&
    engineMatch(i, engineKind) &&
    i.instance_role !== 'replica'
  );
  sel.innerHTML = list.length
    ? '<option value="">请选择源实例</option>' + list.map(i => `<option value="${i.instance_id}">${i.instance_name || i.instance_id}（${i.instance_id}）</option>`).join('')
    : `<option value="">无可用 ${engLabel} 主实例，请先同步实例</option>`;
}

function _cdbOnPlatformChange() {
  const platform   = document.getElementById('cdb-platform').value;
  const engineKind = document.getElementById('cdb-engine').value;
  // 地域下拉
  const regionSel = document.getElementById('cdb-region');
  regionSel.innerHTML = (DB_REGIONS[platform] || []).map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  // 版本 + 规格下拉（枚举表）；平台/引擎切换时清空 CPU/内存筛选
  _cdbFillVersions(platform, engineKind);
  document.getElementById('cdb-filter-cpu').value = '';
  document.getElementById('cdb-filter-mem').value = '';
  _cdbFillClasses(platform, engineKind);
  // 存储：Redis 无需存储
  document.getElementById('cdb-storage-wrap').style.display = engineKind === 'redis' ? 'none' : '';
  // 磁盘类型：非 Redis 时动态拉取（Redis 无磁盘类型概念，隐藏）
  const stWrap = document.getElementById('cdb-storagetype-wrap');
  if (engineKind === 'redis') {
    stWrap.classList.add('hidden');
  } else {
    stWrap.classList.remove('hidden');
    _cdbFillStorageTypes(platform, engineKind);
  }
  // 密码必填判定：阿里云 Redis / AWS RDS 需要密码
  const pwdRequired = (engineKind === 'redis' && platform === 'aliyun') || (engineKind !== 'redis' && platform === 'aws');
  // 密码标签/占位随引擎变化：Redis 提示访问密码，MySQL/PG 提示主账号密码
  const engLbl = ENGINE_LABEL[engineKind];
  const pwdIsRedis = engineKind === 'redis';
  document.getElementById('cdb-pwd-label').innerHTML =
    (pwdIsRedis ? `${engLbl} 访问密码` : `${engLbl} 主账号密码`) + ' <span class="req" id="cdb-pwd-req">' + (pwdRequired ? '*' : '') + '</span>';
  document.getElementById('cdb-password').placeholder = pwdIsRedis ? `请输入 ${engLbl} 访问密码` : `请输入 ${engLbl} 主账号密码`;
  // VPC 仅阿里云/AWS 展示
  const showVpc = platform !== 'baidu';
  document.getElementById('cdb-vpc-wrap').style.display = showVpc ? '' : 'none';
  // AWS 走「子网组(DBSubnetGroup)」而非单个子网/交换机，隐藏单子网下拉；阿里云保留交换机下拉
  const isAws = platform === 'aws';
  document.getElementById('cdb-vswitch').style.display = isAws ? 'none' : '';
  document.getElementById('cdb-vpc-label').textContent = isAws ? 'VPC（可选）' : 'VPC / 交换机（可选）';
  if (showVpc) _cdbFillVpcs();
  // 只读实例：Redis 不支持，隐藏实例类型选择
  const roSupported = engineKind !== 'redis';
  document.getElementById('cdb-role-wrap').classList.toggle('hidden', !roSupported);
  if (!roSupported) document.getElementById('cdb-role').value = 'primary';
  // 子网组（AWS 专用）/ 安全组（AWS、阿里云）/ Multi-AZ+监控（AWS）
  document.getElementById('cdb-subnetgroup-wrap').classList.toggle('hidden', !(isAws && engineKind !== 'redis'));
  const showSg = (platform === 'aws' || platform === 'aliyun') && engineKind !== 'redis';
  document.getElementById('cdb-sg-wrap').classList.toggle('hidden', !showSg);
  document.getElementById('cdb-extra-wrap').classList.toggle('hidden', !(isAws && engineKind !== 'redis'));
  if (isAws && engineKind !== 'redis') _cdbFillSubnetGroups();
  if (showSg) _cdbFillSg();
  // 重新应用只读联动（平台变更后源实例列表要跟着变）
  _cdbOnRoleChange();
}

// VPC 下拉缓存：key `${platform}:${region}` → vpcs[]，`${platform}:${region}:${vpcId}` → subnets[]
const _cdbVpcCache = {};
const _cdbSubnetCache = {};

function _cdbResetSubnet(placeholder) {
  const sw = document.getElementById('cdb-vswitch');
  sw.innerHTML = `<option value="">${placeholder || '不指定'}</option>`;
}

// 从已同步数据填充 VPC 下拉
async function _cdbFillVpcs() {
  const platform = document.getElementById('cdb-platform').value;
  const region   = document.getElementById('cdb-region').value;
  const sel = document.getElementById('cdb-vpc');
  _cdbResetSubnet();
  if (platform === 'baidu' || !region) { sel.innerHTML = '<option value="">不指定（默认网络）</option>'; return; }

  const key = `${platform}:${region}`;
  if (_cdbVpcCache[key]) { _cdbRenderVpcs(sel, _cdbVpcCache[key]); return; }
  sel.innerHTML = '<option value="">加载中...</option>';
  const r = await get(`/sync/vpcs?platform=${platform}&region=${encodeURIComponent(region)}`);
  if (r.ok) { _cdbVpcCache[key] = r.data.vpcs || []; _cdbRenderVpcs(sel, _cdbVpcCache[key]); }
  else sel.innerHTML = '<option value="">不指定（默认网络）</option>';
}

function _cdbRenderVpcs(sel, vpcs) {
  if (!vpcs.length) { sel.innerHTML = '<option value="">不指定（暂无已同步 VPC，可点「同步网络」）</option>'; return; }
  sel.innerHTML = '<option value="">不指定（默认网络）</option>' +
    vpcs.map(v => {
      const cidr = v.cidr ? ` [${v.cidr}]` : '';
      return `<option value="${v.vpc_id}" title="${v.description || ''}">${v.vpc_name || v.vpc_id}（${v.vpc_id}）${cidr}</option>`;
    }).join('');
}

// 地域变更 → 重新拉 VPC + 引擎版本 + 磁盘类型（都按地域不同）
function _cdbOnRegionChange() {
  const platform = document.getElementById('cdb-platform').value;
  const engineKind = document.getElementById('cdb-engine').value;
  if (platform !== 'baidu') _cdbFillVpcs();
  _cdbFillVersions(platform, engineKind);
  // 磁盘类型随地域变化（非 Redis）
  if (engineKind !== 'redis') _cdbFillStorageTypes(platform, engineKind);
  // AWS 子网组也随地域变化
  if (platform === 'aws' && engineKind !== 'redis') _cdbFillSubnetGroups();
  // 安全组随地域变化
  if ((platform === 'aws' || platform === 'aliyun') && engineKind !== 'redis') _cdbFillSg();
}

// VPC 变更 → AWS 按 VPC 过滤子网组；阿里云拉对应交换机
async function _cdbOnVpcChange() {
  const platform = document.getElementById('cdb-platform').value;
  const region   = document.getElementById('cdb-region').value;
  const vpcId    = document.getElementById('cdb-vpc').value;
  // AWS：不选单个子网，改为按选中 VPC 重新过滤子网组
  if (platform === 'aws') {
    const key = `${platform}:${region}`;
    const sngSel = document.getElementById('cdb-subnetgroup');
    if (_cdbSngCache[key]) _cdbRenderSubnetGroups(sngSel, _cdbSngCache[key]);
    else _cdbFillSubnetGroups();
    return;
  }
  const sel = document.getElementById('cdb-vswitch');
  const label = platform === 'aliyun' ? '交换机' : '子网';
  if (!vpcId) { _cdbResetSubnet(); return; }

  const key = `${platform}:${region}:${vpcId}`;
  if (_cdbSubnetCache[key]) { _cdbRenderSubnets(sel, _cdbSubnetCache[key], label); return; }
  sel.innerHTML = '<option value="">加载中...</option>';
  const params = new URLSearchParams({ platform, region, vpc_id: vpcId });
  const r = await get(`/sync/subnets?${params}`);
  if (r.ok) { _cdbSubnetCache[key] = r.data.subnets || []; _cdbRenderSubnets(sel, _cdbSubnetCache[key], label); }
  else _cdbResetSubnet();
}

function _cdbRenderSubnets(sel, subnets, label) {
  if (!subnets.length) { sel.innerHTML = `<option value="">不指定（暂无已同步${label}，可点「同步网络」）</option>`; return; }
  sel.innerHTML = '<option value="">不指定</option>' +
    subnets.map(s => {
      const zone = s.zone ? ` [${s.zone}]` : '';
      const cidr = s.cidr ? ` ${s.cidr}` : '';
      return `<option value="${s.subnet_id}" title="${s.description || ''}">${s.subnet_name || s.subnet_id}（${s.subnet_id}）${cidr}${zone}</option>`;
    }).join('');
}

// 点「同步网络」：同步该平台 VPC + 子网后刷新下拉
async function _cdbSyncVpc() {
  const platform = document.getElementById('cdb-platform').value;
  const region   = document.getElementById('cdb-region').value;
  if (platform === 'baidu') return;
  const link = document.getElementById('cdb-vpc-sync');
  const old = link.textContent; link.textContent = '同步中...'; link.style.pointerEvents = 'none';
  await post(`/sync/vpcs/${platform}`, {});
  await post(`/sync/subnets/${platform}`, {});
  Object.keys(_cdbVpcCache).forEach(k => k.startsWith(`${platform}:`) && delete _cdbVpcCache[k]);
  Object.keys(_cdbSubnetCache).forEach(k => k.startsWith(`${platform}:`) && delete _cdbSubnetCache[k]);
  await _cdbFillVpcs();
  link.textContent = old; link.style.pointerEvents = '';
  toast('网络已同步', 'ok');
}

// ── AWS 子网组下拉 ──
const _cdbSngCache = {};
async function _cdbFillSubnetGroups() {
  const platform = document.getElementById('cdb-platform').value;
  const region   = document.getElementById('cdb-region').value;
  const sel = document.getElementById('cdb-subnetgroup');
  if (platform !== 'aws' || !region) { sel.innerHTML = '<option value="">不指定（默认）</option>'; return; }
  const key = `${platform}:${region}`;
  if (_cdbSngCache[key]) { _cdbRenderSubnetGroups(sel, _cdbSngCache[key]); return; }
  sel.innerHTML = '<option value="">加载中...</option>';
  const r = await get(`/sync/db-subnet-groups?platform=${platform}&region=${encodeURIComponent(region)}`);
  if (r.ok) { _cdbSngCache[key] = r.data.subnet_groups || []; _cdbRenderSubnetGroups(sel, _cdbSngCache[key]); }
  else sel.innerHTML = '<option value="">不指定（默认）</option>';
}
// 按当前选中 VPC 过滤子网组（未选 VPC 则展示全部）
function _cdbRenderSubnetGroups(sel, groups) {
  const vpcId = document.getElementById('cdb-vpc').value;
  const list = vpcId ? groups.filter(g => g.vpc_id === vpcId) : groups;
  if (!groups.length) { sel.innerHTML = '<option value="">不指定（暂无已同步子网组，可点「同步子网组」）</option>'; return; }
  if (!list.length) { sel.innerHTML = '<option value="">该 VPC 下无子网组（请先在控制台创建，或点「同步子网组」）</option>'; return; }
  sel.innerHTML = '<option value="">不指定（默认）</option>' +
    list.map(g => `<option value="${g.group_name}" title="${g.description || ''}">${g.group_name}${g.vpc_id ? `（${g.vpc_id}）` : ''}</option>`).join('');
}
async function _cdbSyncSubnetGroup() {
  const platform = document.getElementById('cdb-platform').value;
  const region   = document.getElementById('cdb-region').value;
  if (platform !== 'aws') return;
  const link = document.getElementById('cdb-sng-sync');
  const old = link.textContent; link.textContent = '同步中...'; link.style.pointerEvents = 'none';
  await post(`/sync/db-subnet-groups/${platform}`, {});
  Object.keys(_cdbSngCache).forEach(k => k.startsWith(`${platform}:`) && delete _cdbSngCache[k]);
  await _cdbFillSubnetGroups();
  link.textContent = old; link.style.pointerEvents = '';
  toast('子网组已同步', 'ok');
}

// ── 安全组多选下拉 ──
const _cdbSgCache = {};
// 已勾选的安全组 ID 集合（跨搜索过滤持久保留）
let _cdbSgPicked = new Set();

async function _cdbFillSg() {
  const platform = document.getElementById('cdb-platform').value;
  const region   = document.getElementById('cdb-region').value;
  const box = document.getElementById('cdb-sg');
  if (!region) { box.innerHTML = ''; _cdbUpdateSgSelected(); return; }
  const key = `${platform}:${region}`;
  if (_cdbSgCache[key]) { _cdbRenderSg(_cdbSgCache[key]); return; }
  box.innerHTML = '<div style="padding:6px;color:var(--g400);font-size:12px">加载中...</div>';
  const r = await get(`/sync/security-groups?platform=${platform}&region=${encodeURIComponent(region)}`);
  if (r.ok) { _cdbSgCache[key] = r.data.security_groups || []; _cdbRenderSg(_cdbSgCache[key]); }
  else box.innerHTML = '';
}
function _cdbRenderSg(sgs, keyword) {
  const box = document.getElementById('cdb-sg');
  const kw = (keyword || '').trim().toLowerCase();
  const list = kw
    ? sgs.filter(s => (s.sg_name || '').toLowerCase().includes(kw) || (s.sg_id || '').toLowerCase().includes(kw))
    : sgs;
  if (!sgs.length) { box.innerHTML = '<div style="padding:6px;color:var(--g400);font-size:12px">暂无已同步安全组，可点「同步安全组」</div>'; _cdbUpdateSgSelected(); return; }
  box.innerHTML = list.length
    ? list.map(s => {
        const checked = _cdbSgPicked.has(s.sg_id) ? 'checked' : '';
        const nm = s.sg_name || s.sg_id;
        return `<label style="display:flex;align-items:center;gap:8px;padding:4px 6px;cursor:pointer;font-size:13px" title="${s.description || ''}">
          <input type="checkbox" value="${s.sg_id}" ${checked} onchange="_cdbToggleSg(this)" style="width:auto">
          <span>${nm}（${s.sg_id}）</span></label>`;
      }).join('')
    : '<div style="padding:6px;color:var(--g400);font-size:12px">无匹配安全组</div>';
  _cdbUpdateSgSelected();
}
// 勾选/取消 → 维护选中集合
function _cdbToggleSg(cb) {
  if (cb.checked) _cdbSgPicked.add(cb.value);
  else _cdbSgPicked.delete(cb.value);
  _cdbUpdateSgSelected();
}
// 更新「已选 N 个」提示
function _cdbUpdateSgSelected() {
  const el = document.getElementById('cdb-sg-selected');
  if (!el) return;
  el.textContent = _cdbSgPicked.size ? `已选 ${_cdbSgPicked.size} 个：${[..._cdbSgPicked].join(', ')}` : '未选择安全组';
}
// 安全组搜索框输入 → 过滤列表（勾选状态由 _cdbSgPicked 保留）
function _cdbFilterSg() {
  const platform = document.getElementById('cdb-platform').value;
  const region   = document.getElementById('cdb-region').value;
  const kw = document.getElementById('cdb-sg-search').value;
  const cached = _cdbSgCache[`${platform}:${region}`] || [];
  _cdbRenderSg(cached, kw);
}
async function _cdbSyncSg() {
  const platform = document.getElementById('cdb-platform').value;
  const link = document.getElementById('cdb-sg-sync');
  const old = link.textContent; link.textContent = '同步中...'; link.style.pointerEvents = 'none';
  await post(`/sync/security-groups/${platform}`, {});
  Object.keys(_cdbSgCache).forEach(k => k.startsWith(`${platform}:`) && delete _cdbSgCache[k]);
  await _cdbFillSg();
  link.textContent = old; link.style.pointerEvents = '';
  toast('安全组已同步', 'ok');
}

async function submitCreateDbInstance() {
  const errEl = document.getElementById('cdb-err');
  errEl.textContent = '';
  const engineKind = document.getElementById('cdb-engine').value;
  const platform   = document.getElementById('cdb-platform').value;
  const region     = document.getElementById('cdb-region').value;
  const instanceName = document.getElementById('cdb-name').value.trim();
  const engineVersion = document.getElementById('cdb-version').value.trim();
  const classVal   = document.getElementById('cdb-class').value.trim();
  const storageGb  = document.getElementById('cdb-storage').value;
  const accountPassword = document.getElementById('cdb-password').value;
  const vpcId      = document.getElementById('cdb-vpc').value;
  // AWS 走子网组，不传单个子网/交换机
  const vSwitchId  = platform === 'aws' ? '' : document.getElementById('cdb-vswitch').value;
  const instanceRole = document.getElementById('cdb-role').value;
  const isReplica  = instanceRole === 'replica';
  const sourceInstanceId = document.getElementById('cdb-source').value;
  const baiduCpuMem = isBaiduCpuMem(platform, engineKind);
  // 只读副本继承源实例密码，无需再设
  const pwdRequired = !isReplica && ((engineKind === 'redis' && platform === 'aliyun') || (engineKind !== 'redis' && platform === 'aws'));

  if (!region) { errEl.textContent = '请选择地域'; return; }
  if (!classVal) { errEl.textContent = '请选择实例规格'; return; }
  if (isReplica) {
    if (!sourceInstanceId) { errEl.textContent = '只读实例请选择源实例'; return; }
  } else if (!engineVersion) {
    errEl.textContent = '请选择引擎版本'; return;
  }
  if (pwdRequired && (!accountPassword || accountPassword.length < 8)) {
    errEl.textContent = '请设置访问密码（至少 8 位）'; return;
  }

  const body = {
    platform, engineKind, region, instanceName, engineVersion,
    storageGb, vpcId, vSwitchId, accountPassword,
    instanceRole, sourceInstanceId,
  };
  if (baiduCpuMem) {
    // 百度云 RDS 规格值格式 "cpu:mem"
    const [cpu, mem] = classVal.split(':');
    body.cpuCount = cpu;
    body.memoryGb = mem;
  } else {
    body.instanceClass = classVal;
  }
  // 磁盘类型 + IOPS + 吞吐量 + 自动扩展（依据当前类型元数据收集，含范围校验）
  const stWrap = document.getElementById('cdb-storagetype-wrap');
  if (!stWrap.classList.contains('hidden')) {
    const stVal = document.getElementById('cdb-storagetype').value;
    body.storageType = stVal;
    const m = _cdbStMeta[stVal] || {};
    // 存储空间范围校验
    const sg = Number(storageGb);
    if (m.storageMin != null && sg < m.storageMin) { errEl.textContent = `存储空间不能小于 ${m.storageMin} GiB`; return; }
    if (m.storageMax != null && sg > m.storageMax) { errEl.textContent = `存储空间不能大于 ${m.storageMax} GiB`; return; }
    // IOPS
    if (m.supportsIops) {
      const iopsVal = document.getElementById('cdb-iops').value;
      if (iopsVal) {
        const iv = Number(iopsVal);
        if (m.iopsMin != null && iv < m.iopsMin) { errEl.textContent = `IOPS 不能小于 ${m.iopsMin}`; return; }
        if (m.iopsMax != null && iv > m.iopsMax) { errEl.textContent = `IOPS 不能大于 ${m.iopsMax}`; return; }
        body.iops = iopsVal;
      }
    }
    // 吞吐量（gp3）
    if (m.supportsThroughput) {
      const tpVal = document.getElementById('cdb-throughput').value;
      if (tpVal) {
        const tv = Number(tpVal);
        if (m.throughputMin != null && tv < m.throughputMin) { errEl.textContent = `吞吐量不能小于 ${m.throughputMin} MiBps`; return; }
        if (m.throughputMax != null && tv > m.throughputMax) { errEl.textContent = `吞吐量不能大于 ${m.throughputMax} MiBps`; return; }
        body.storageThroughput = tpVal;
      }
    }
    // 存储自动扩展 + 最大阈值
    if (m.supportsAutoscaling && document.getElementById('cdb-autoscale').checked) {
      const maxVal = document.getElementById('cdb-autoscale-max').value;
      if (!maxVal) { errEl.textContent = '请填写存储自动扩展的最大阈值'; return; }
      if (Number(maxVal) <= sg) { errEl.textContent = '最大存储阈值需大于当前存储空间'; return; }
      body.maxAllocatedStorage = maxVal;
    }
  }
  // 子网组（AWS）
  const sngWrap = document.getElementById('cdb-subnetgroup-wrap');
  if (!sngWrap.classList.contains('hidden')) body.subnetGroup = document.getElementById('cdb-subnetgroup').value;
  // 安全组多选（来自勾选集合 _cdbSgPicked）
  const sgWrap = document.getElementById('cdb-sg-wrap');
  if (!sgWrap.classList.contains('hidden')) {
    body.securityGroupIds = [..._cdbSgPicked];
  }
  // Multi-AZ / 监控（AWS）
  const extraWrap = document.getElementById('cdb-extra-wrap');
  if (!extraWrap.classList.contains('hidden')) {
    body.multiAz = document.getElementById('cdb-multiaz').checked;
    body.monitoring = document.getElementById('cdb-monitoring').checked;
  }

  const btn = document.getElementById('cdb-submit');
  btn.disabled = true; btn.textContent = '创建中...';
  const r = await post('/rds/instances', body);
  btn.disabled = false; btn.textContent = '创建';
  if (!r.ok) { errEl.textContent = r.data?.error || '创建失败'; return; }

  document.getElementById('modal-create-db').classList.add('hidden');
  const roLabel = isReplica ? '只读' : '';
  toast(`${ENGINE_LABEL[engineKind]} ${roLabel}实例创建已提交：${r.data.instanceId || ''}，稍后点「同步实例」刷新状态`, 'ok');
  loadRdsInstances();
}
