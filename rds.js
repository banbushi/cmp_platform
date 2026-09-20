const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../utils/database');
const { authenticate } = require('../middleware/auth');
const bceRequest = require('../utils/bce');
const { AWS_REGIONS, ALIYUN_REGIONS, BAIDU_REGIONS, BAIDU_DB_REGIONS } = require('../utils/regions');

const router = express.Router();

// ══════════════════════════════════════════════════════════════
// 动态引擎版本（从各云官方 API 实时拉取，带 30 分钟缓存 + 静态兜底）
// ══════════════════════════════════════════════════════════════
const _verCache = new Map();
const _VER_TTL = 30 * 60 * 1000;
function _verGet(key) {
  const e = _verCache.get(key);
  if (e && Date.now() < e.expires) return e.data;
  _verCache.delete(key);
  return null;
}
function _verSet(key, data) { _verCache.set(key, { data, expires: Date.now() + _VER_TTL }); }

// 静态兜底版本（API 拉取失败时用；正常情况下会被动态结果覆盖）
const FALLBACK_VERSIONS = {
  aws:    { mysql: ['8.0', '5.7'], postgres: ['16', '15', '14', '13'] },
  aliyun: { mysql: ['8.0', '5.7', '5.6'], postgres: ['16.0', '15.0', '14.0', '13.0'] },
  baidu:  { mysql: ['8.0', '5.7', '5.6'], postgres: ['15', '14', '13', '12'] },
};

// engineKind → 各云引擎名
function _awsEngineName(engineKind) { return engineKind === 'postgres' ? 'postgres' : 'mysql'; }

// AWS：DescribeDBEngineVersions 按引擎拉版本
async function awsFetchEngineVersions(cred, region, engineKind) {
  const { RDSClient, DescribeDBEngineVersionsCommand } = require('@aws-sdk/client-rds');
  const client = new RDSClient({ region: region || 'us-west-2', credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
  const engine = _awsEngineName(engineKind);
  const versions = [];
  let marker;
  do {
    const resp = await client.send(new DescribeDBEngineVersionsCommand({ Engine: engine, MaxRecords: 100, ...(marker ? { Marker: marker } : {}) }));
    for (const v of resp.DBEngineVersions || []) {
      if (v.EngineVersion) versions.push(v.EngineVersion);
    }
    marker = resp.Marker;
  } while (marker);
  // 去重 + 版本号降序
  return [...new Set(versions)].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

// 阿里云：DescribeAvailableClasses/DescribeDBInstanceAttribute 需实例；用 rds.aliyuncs.com 的
// DescribeAvailableEngineVersion 无区域大表，改用 DescribeAvailableResource 拉可用版本（按地域）
async function aliyunFetchEngineVersions(cred, region, engineKind) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({ accessKeyId: cred.access_key, accessKeySecret: cred.secret_key, endpoint: 'https://rds.aliyuncs.com', apiVersion: '2014-08-15' });
  const engine = engineKind === 'postgres' ? 'PostgreSQL' : 'MySQL';
  const resp = await client.request('DescribeAvailableResource', {
    RegionId: region || 'cn-hangzhou', Engine: engine, InstanceChargeType: 'Postpaid',
  }, { method: 'POST' });
  const versions = new Set();
  const zones = resp.AvailableZones?.AvailableZone || [];
  for (const z of zones) {
    for (const eng of (z.SupportedEngines?.SupportedEngine || [])) {
      for (const ev of (eng.SupportedEngineVersions?.SupportedEngineVersion || [])) {
        if (ev.Version) versions.add(ev.Version);
      }
    }
  }
  return [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

// 百度云：GET /v1/instance/engineVersion 拉支持的引擎版本
async function baiduFetchEngineVersions(cred, region, engineKind) {
  const host = `rds.${region || 'bj'}.baidubce.com`;
  const engine = engineKind === 'postgres' ? 'postgresql' : 'mysql';
  const resp = await bceRequest(cred, 'GET', '/v1/instance/engineVersion', {}, null, host);
  const versions = new Set();
  // 响应形如 { engineVersions: [{ engine, engineVersion }] } 或 { [engine]: [ver] }
  const list = resp.engineVersions || resp.result || [];
  for (const item of list) {
    if (typeof item === 'string') { versions.add(item); continue; }
    if ((item.engine || '').toLowerCase() === engine && item.engineVersion) versions.add(item.engineVersion);
  }
  // 部分接口按引擎分组返回
  if (!versions.size && resp[engine]) (resp[engine] || []).forEach(v => versions.add(v));
  return [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
}

// ── GET /api/rds/engine-versions/:platform?region=&engineKind= ── 动态引擎版本
router.get('/engine-versions/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  const region = req.query.region || '';
  const engineKind = req.query.engineKind === 'postgres' ? 'postgres' : 'mysql';
  const cacheKey = `ver:${platform}:${region}:${engineKind}`;
  const cached = _verGet(cacheKey);
  if (cached) return res.json({ versions: cached });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.json({ versions: (FALLBACK_VERSIONS[platform] || {})[engineKind] || [], fallback: true });

  try {
    let versions;
    if      (platform === 'aws')    versions = await awsFetchEngineVersions(cred, region, engineKind);
    else if (platform === 'aliyun') versions = await aliyunFetchEngineVersions(cred, region, engineKind);
    else if (platform === 'baidu')  versions = await baiduFetchEngineVersions(cred, region, engineKind);
    else return res.status(400).json({ error: '不支持的云平台' });
    if (!versions || !versions.length) versions = (FALLBACK_VERSIONS[platform] || {})[engineKind] || [];
    _verSet(cacheKey, versions);
    res.json({ versions });
  } catch (e) {
    console.error(`[rds/engine-versions/${platform}]`, e.message);
    res.json({ versions: (FALLBACK_VERSIONS[platform] || {})[engineKind] || [], fallback: true });
  }
});

// ══════════════════════════════════════════════════════════════
// 动态磁盘类型（同样 30 分钟缓存 + 静态兜底）
// ══════════════════════════════════════════════════════════════
// 磁盘类型 code → 展示 label（用于给动态拉到的 code 补中文说明；缺失则直接显示 code）
const STORAGE_TYPE_LABELS = {
  aws:    { standard: 'standard (磁介质)', gp2: 'gp2 (通用SSD)', gp3: 'gp3 (通用SSD, 可调IOPS)', io1: 'io1 (预置IOPS SSD)', io2: 'io2 (预置IOPS SSD, 高耐久)' },
  aliyun: { cloud_essd: 'ESSD 云盘', cloud_essd2: 'ESSD PL2', cloud_essd3: 'ESSD PL3', cloud_ssd: 'SSD 云盘', local_ssd: '本地SSD盘', cloud: '普通云盘' },
  baidu:  { cloud_high: '高性能云盘', cloud_nor: '通用型SSD', cloud_enha: '增强型SSD', cloud_essd_pl1: 'ESSD PL1', cloud_essd_pl2: 'ESSD PL2' },
};
// 静态兜底磁盘类型（阿里云/百度云为简单 {value,label}；AWS 由 _awsFallbackStorageTypes 生成富对象）
const FALLBACK_STORAGE_TYPES = {
  aliyun: [{ value: 'cloud_essd', label: 'ESSD 云盘' }, { value: 'cloud_essd2', label: 'ESSD PL2' }, { value: 'cloud_ssd', label: 'SSD 云盘' }],
  baidu:  [{ value: 'cloud_high', label: '高性能云盘' }, { value: 'cloud_enha', label: '增强型SSD' }],
};
function _stLabel(platform, code) { return (STORAGE_TYPE_LABELS[platform] || {})[code] || code; }

// AWS 富对象兜底（API 不可达时用官方固定约束生成，字段与动态返回一致）
function _awsFallbackStorageTypes() {
  const order = ['gp3', 'gp2', 'io2', 'io1'];
  return order.map(code => {
    const fx = AWS_STORAGE_META[code] || {};
    return {
      value: code, label: _stLabel('aws', code),
      supportsIops: fx.supportsIops ?? false,
      supportsThroughput: fx.supportsThroughput ?? false,
      supportsAutoscaling: true,
      storageMin: fx.storage?.[0] ?? 20, storageMax: fx.storage?.[1] ?? 65536,
      iopsMin: fx.iops?.[0] ?? null, iopsMax: fx.iops?.[1] ?? null,
      iopsPerGibMin: fx.iopsPerGib?.[0] ?? null, iopsPerGibMax: fx.iopsPerGib?.[1] ?? null,
      throughputMin: fx.throughput?.[0] ?? null, throughputMax: fx.throughput?.[1] ?? null,
    };
  });
}

// AWS 各磁盘类型官方固定约束（DescribeOrderable 未返回时兜底；单位与控制台一致）
// storage: 存储空间 GiB [min,max]；iops: [min,max]；iopsPerGib: [min,max]；throughput: MiBps [min,max]
const AWS_STORAGE_META = {
  gp2:      { supportsIops: false, supportsThroughput: false, storage: [20, 65536] },
  gp3:      { supportsIops: true,  supportsThroughput: true,  storage: [20, 65536], iops: [3000, 64000], iopsPerGib: [0.5, 500], throughput: [125, 4000], iopsFree: 3000, throughputFree: 125 },
  io1:      { supportsIops: true,  supportsThroughput: false, storage: [100, 65536], iops: [1000, 256000], iopsPerGib: [0.5, 50] },
  io2:      { supportsIops: true,  supportsThroughput: false, storage: [100, 65536], iops: [1000, 256000], iopsPerGib: [0.5, 1000] },
  standard: { supportsIops: false, supportsThroughput: false, storage: [5, 3072] },
};

// AWS：DescribeOrderableDBInstanceOptions 按引擎聚合 StorageType + 存储/IOPS/吞吐量约束
async function awsFetchStorageTypes(cred, region, engineKind) {
  const { RDSClient, DescribeOrderableDBInstanceOptionsCommand } = require('@aws-sdk/client-rds');
  const client = new RDSClient({ region: region || 'us-west-2', credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
  const engine = _awsEngineName(engineKind);
  // 每种类型取一份「约束最宽」的元数据（不同规格返回的 min/max 略有差异，取并集边界）
  const meta = {};
  let marker, pages = 0;
  do {
    const resp = await client.send(new DescribeOrderableDBInstanceOptionsCommand({ Engine: engine, MaxRecords: 100, ...(marker ? { Marker: marker } : {}) }));
    for (const o of resp.OrderableDBInstanceOptions || []) {
      const st = o.StorageType;
      if (!st || String(st).startsWith('aurora')) continue;
      const m = meta[st] || (meta[st] = { supportsIops: false, supportsThroughput: false, supportsAutoscaling: false, storageMin: null, storageMax: null, iopsMin: null, iopsMax: null, iopsPerGibMin: null, iopsPerGibMax: null, throughputMin: null, throughputMax: null });
      if (o.SupportsIops) m.supportsIops = true;
      if (o.SupportsStorageThroughput) m.supportsThroughput = true;
      if (o.SupportsStorageAutoscaling) m.supportsAutoscaling = true;
      const lo = (cur, v) => (v == null ? cur : (cur == null ? v : Math.min(cur, v)));
      const hi = (cur, v) => (v == null ? cur : (cur == null ? v : Math.max(cur, v)));
      m.storageMin = lo(m.storageMin, o.MinStorageSize); m.storageMax = hi(m.storageMax, o.MaxStorageSize);
      m.iopsMin = lo(m.iopsMin, o.MinIopsPerDbInstance); m.iopsMax = hi(m.iopsMax, o.MaxIopsPerDbInstance);
      m.iopsPerGibMin = lo(m.iopsPerGibMin, o.MinIopsPerGib); m.iopsPerGibMax = hi(m.iopsPerGibMax, o.MaxIopsPerGib);
      m.throughputMin = lo(m.throughputMin, o.MinStorageThroughputPerDbInstance); m.throughputMax = hi(m.throughputMax, o.MaxStorageThroughputPerDbInstance);
    }
    marker = resp.Marker;
  } while (marker && ++pages < 10);
  // 官方固定支持 gp2/gp3/io1/io2，补齐（用固定约束填缺失字段）
  ['gp3', 'gp2', 'io1', 'io2'].forEach(t => { if (!meta[t]) meta[t] = {}; });
  const order = ['gp3', 'gp2', 'io2', 'io1', 'standard'];
  return Object.keys(meta)
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .map(code => {
      const m = meta[code] || {};
      const fx = AWS_STORAGE_META[code] || {};
      return {
        value: code,
        label: _stLabel('aws', code),
        supportsIops: m.supportsIops ?? fx.supportsIops ?? false,
        supportsThroughput: m.supportsThroughput ?? fx.supportsThroughput ?? false,
        supportsAutoscaling: m.supportsAutoscaling ?? false,
        storageMin: m.storageMin ?? fx.storage?.[0] ?? 20,
        storageMax: m.storageMax ?? fx.storage?.[1] ?? 65536,
        iopsMin: m.iopsMin ?? fx.iops?.[0] ?? null,
        iopsMax: m.iopsMax ?? fx.iops?.[1] ?? null,
        iopsPerGibMin: m.iopsPerGibMin ?? fx.iopsPerGib?.[0] ?? null,
        iopsPerGibMax: m.iopsPerGibMax ?? fx.iopsPerGib?.[1] ?? null,
        throughputMin: m.throughputMin ?? fx.throughput?.[0] ?? null,
        throughputMax: m.throughputMax ?? fx.throughput?.[1] ?? null,
      };
    });
}

// 阿里云：DescribeAvailableResource 从可用资源里提取 StorageType
async function aliyunFetchStorageTypes(cred, region, engineKind) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({ accessKeyId: cred.access_key, accessKeySecret: cred.secret_key, endpoint: 'https://rds.aliyuncs.com', apiVersion: '2014-08-15' });
  const engine = engineKind === 'postgres' ? 'PostgreSQL' : 'MySQL';
  const resp = await client.request('DescribeAvailableResource', { RegionId: region || 'cn-hangzhou', Engine: engine, InstanceChargeType: 'Postpaid' }, { method: 'POST' });
  const set = new Set();
  for (const z of (resp.AvailableZones?.AvailableZone || [])) {
    for (const eng of (z.SupportedEngines?.SupportedEngine || [])) {
      for (const ev of (eng.SupportedEngineVersions?.SupportedEngineVersion || [])) {
        for (const cat of (ev.SupportedCategorys?.SupportedCategory || [])) {
          for (const st of (cat.SupportedStorageType?.supportedStorageType || cat.SupportedStorageType?.SupportedStorageType || [])) {
            if (typeof st === 'string') set.add(st);
            else if (st?.StorageType) set.add(st.StorageType);
          }
        }
      }
    }
  }
  return [...set].map(c => ({ value: c, label: _stLabel('aliyun', c) }));
}

// 百度云：GET /v1/instance/diskType（若不支持则回落静态）
async function baiduFetchStorageTypes(cred, region, engineKind) {
  const host = `rds.${region || 'bj'}.baidubce.com`;
  const resp = await bceRequest(cred, 'GET', '/v1/instance/diskType', {}, null, host);
  const set = new Set();
  const list = resp.diskTypes || resp.diskType || resp.result || [];
  for (const item of list) {
    if (typeof item === 'string') set.add(item);
    else if (item?.diskType) set.add(item.diskType);
    else if (item?.type) set.add(item.type);
  }
  return [...set].map(c => ({ value: c, label: _stLabel('baidu', c) }));
}

// ── GET /api/rds/storage-types/:platform?region=&engineKind= ── 动态磁盘类型
router.get('/storage-types/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  const region = req.query.region || '';
  const engineKind = req.query.engineKind === 'postgres' ? 'postgres' : 'mysql';
  const cacheKey = `st:${platform}:${region}:${engineKind}`;
  const cached = _verGet(cacheKey);
  if (cached) return res.json({ storage_types: cached });

  // 兜底：AWS 用富对象生成器，阿里云/百度云用简单表
  const fallbackOf = (p) => (p === 'aws' ? _awsFallbackStorageTypes() : (FALLBACK_STORAGE_TYPES[p] || []));

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.json({ storage_types: fallbackOf(platform), fallback: true });

  try {
    let types;
    if      (platform === 'aws')    types = await awsFetchStorageTypes(cred, region, engineKind);
    else if (platform === 'aliyun') types = await aliyunFetchStorageTypes(cred, region, engineKind);
    else if (platform === 'baidu')  types = await baiduFetchStorageTypes(cred, region, engineKind);
    else return res.status(400).json({ error: '不支持的云平台' });
    if (!types || !types.length) types = fallbackOf(platform);
    _verSet(cacheKey, types);
    res.json({ storage_types: types });
  } catch (e) {
    console.error(`[rds/storage-types/${platform}]`, e.message);
    res.json({ storage_types: fallbackOf(platform), fallback: true });
  }
});

// ── GET /api/rds/instances?platform= ── 获取已同步的 RDS 实例列表
router.get('/instances', authenticate, async (req, res) => {
  const { platform } = req.query;
  const where = platform ? 'WHERE platform = ?' : '';
  const params = platform ? [platform] : [];
  const instances = await db.all(
    `SELECT * FROM cloud_rds_instances ${where} ORDER BY platform, instance_name`,
    params
  );
  res.json({ instances });
});

// ── POST /api/rds/sync/:platform ── 同步 RDS 实例列表
router.post('/sync/:platform', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  const { platform } = req.params;
  const platforms = platform === 'all' ? ['aws', 'aliyun', 'baidu'] : [platform];
  const results = [];

  for (const p of platforms) {
    const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [p]);
    if (!cred) { results.push({ platform: p, success: false, message: '未配置主账号凭据' }); continue; }
    try {
      let instances = [];
      if (p === 'aws') {
        const rdsInstances = await syncAwsRdsInstances(cred);
        const redisInstances = await syncAwsRedisInstances(cred);
        instances = [...rdsInstances, ...redisInstances];
      }
      if (p === 'aliyun') {
        const rdsInstances = await syncAliyunRdsInstances(cred);
        const redisInstances = await syncAliyunRedisInstances(cred);
        instances = [...rdsInstances, ...redisInstances];
      }
      if (p === 'baidu') {
        const rdsInstances = await syncBaiduRdsInstances(cred);
        const redisInstances = await syncBaiduRedisInstances(cred);
        instances = [...rdsInstances, ...redisInstances];
      }

      for (const inst of instances) {
        await db.run(`
          INSERT INTO cloud_rds_instances
            (id, platform, instance_id, instance_name, engine, engine_version, instance_class, status, region, endpoint, port, \`databases\`)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            instance_name=VALUES(instance_name), engine=VALUES(engine), engine_version=VALUES(engine_version),
            instance_class=VALUES(instance_class), status=VALUES(status), region=VALUES(region),
            endpoint=VALUES(endpoint), port=VALUES(port), \`databases\`=VALUES(\`databases\`), synced_at=NOW()
        `, [
          uuidv4(), p, inst.instance_id, inst.instance_name, inst.engine, inst.engine_version,
          inst.instance_class, inst.status, inst.region, inst.endpoint, inst.port,
          JSON.stringify(inst.databases || [])
        ]);
      }
      results.push({ platform: p, success: true, count: instances.length });
    } catch (e) {
      console.error(`[rds/sync] ${p} error:`, e.message);
      results.push({ platform: p, success: false, message: e.message });
    }
  }
  res.json({ results });
});

// ── GET /api/rds/instances/:platform/:instanceId/databases ── 查询实例上的数据库列表
router.get('/instances/:platform/:instanceId/databases', authenticate, async (req, res) => {
  const { platform, instanceId } = req.params;
  // 先从本地缓存取
  const inst = await db.get(
    'SELECT `databases` FROM cloud_rds_instances WHERE platform = ? AND instance_id = ?',
    [platform, instanceId]
  );
  if (inst && inst.databases) {
    try {
      const dbs = JSON.parse(inst.databases);
      if (dbs.length) return res.json({ databases: dbs });
    } catch {}
  }
  // 本地无数据则实时查询
  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.json({ databases: [] });
  try {
    let dbs = [];
    if (platform === 'aws')    dbs = await listAwsDatabases(cred, instanceId);
    if (platform === 'aliyun') dbs = await listAliyunDatabases(cred, instanceId);
    if (platform === 'baidu')  dbs = await listBaiduDatabases(cred, instanceId);
    res.json({ databases: dbs });
  } catch (e) {
    res.json({ databases: [] });
  }
});

// ── GET /api/rds/accounts ── 已创建的数据库账号列表
router.get('/accounts', authenticate, async (req, res) => {
  const accounts = await db.all(
    'SELECT * FROM cloud_db_accounts ORDER BY created_at DESC'
  );
  res.json({ accounts });
});

// ── POST /api/rds/instances ── 管理员直接创建数据库实例（不走工单）
router.post('/instances', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });
  const {
    platform, engineKind, region, engineVersion, instanceClass,
    storageGb, instanceName, vpcId, vSwitchId, securityIp, chargeType,
    accountName, accountPassword, cpuCount, memoryGb,
    instanceRole, sourceInstanceId, storageType, iops,
    storageThroughput, maxAllocatedStorage,
    subnetGroup, securityGroupIds, multiAz, monitoring,
  } = req.body || {};

  const isReplica = instanceRole === 'replica';

  // 精简必填校验
  if (!['aws', 'aliyun', 'baidu'].includes(platform)) return res.status(400).json({ error: '请选择云平台' });
  if (!['mysql', 'postgres', 'redis'].includes(engineKind)) return res.status(400).json({ error: '请选择数据库类型' });
  if (!region) return res.status(400).json({ error: '请选择地域' });
  if (!instanceClass && !(platform === 'baidu' && engineKind !== 'redis')) {
    return res.status(400).json({ error: '请选择实例规格' });
  }
  // 只读副本：必须指定源实例
  if (isReplica) {
    if (engineKind === 'redis') return res.status(400).json({ error: 'Redis 不支持只读副本' });
    if (!sourceInstanceId) return res.status(400).json({ error: '只读实例需选择源实例' });
  }
  // AWS RDS 主实例建议指定子网组（否则落到默认 VPC）
  // 需要密码的场景：Redis(阿里云) / RDS 主账号(AWS)；只读副本继承源实例账号，无需密码
  if (!isReplica) {
    if (engineKind === 'redis' && platform === 'aliyun' && !accountPassword) {
      return res.status(400).json({ error: 'Redis 实例需设置访问密码' });
    }
    if (engineKind !== 'redis' && platform === 'aws' && !accountPassword) {
      return res.status(400).json({ error: 'AWS RDS 需设置主账号密码' });
    }
  }

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  const sgIds = Array.isArray(securityGroupIds) ? securityGroupIds.filter(Boolean)
              : (securityGroupIds ? [securityGroupIds] : []);
  const opts = {
    engineKind, region, engineVersion, instanceClass,
    storageGb: storageGb ? Number(storageGb) : undefined,
    instanceName, vpcId, vSwitchId, securityIp, chargeType,
    accountName, accountPassword,
    cpuCount: cpuCount ? Number(cpuCount) : undefined,
    memoryGb: memoryGb ? Number(memoryGb) : undefined,
    isReplica, sourceInstanceId,
    storageType, iops: iops ? Number(iops) : undefined,
    storageThroughput: storageThroughput ? Number(storageThroughput) : undefined,
    maxAllocatedStorage: maxAllocatedStorage ? Number(maxAllocatedStorage) : undefined,
    subnetGroup, securityGroupIds: sgIds,
    multiAz: !!multiAz, monitoring: !!monitoring,
  };
  const result = await createDbInstance(platform, cred, opts);
  if (!result.success) return res.status(500).json({ error: result.message });

  // 落库一条 pending 记录，同步后会被真实状态覆盖（UNIQUE KEY platform+instance_id）
  if (result.instanceId) {
    const engineLabel = engineKind === 'postgres' ? 'PostgreSQL' : engineKind === 'redis' ? 'Redis' : 'MySQL';
    try {
      await db.run(
        `INSERT INTO cloud_rds_instances
           (id, platform, instance_id, instance_name, engine, engine_version, instance_class, status, region, endpoint, port, \`databases\`, synced_at,
            instance_role, source_instance, storage_type, iops, storage_gb, vpc_id, subnet_group, security_groups, multi_az, monitoring)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'Creating', ?, '', ?, '[]', NOW(),
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE status='Creating', synced_at=NOW(),
            instance_role=VALUES(instance_role), source_instance=VALUES(source_instance),
            storage_type=VALUES(storage_type), iops=VALUES(iops), storage_gb=VALUES(storage_gb),
            vpc_id=VALUES(vpc_id), subnet_group=VALUES(subnet_group), security_groups=VALUES(security_groups),
            multi_az=VALUES(multi_az), monitoring=VALUES(monitoring)`,
        [uuidv4(), platform, result.instanceId, instanceName || result.instanceId,
         engineLabel, engineVersion || '', instanceClass || '', region,
         engineKind === 'redis' ? 6379 : (engineKind === 'postgres' ? 5432 : 3306),
         isReplica ? 'replica' : 'primary', sourceInstanceId || '', storageType || '',
         opts.iops || null, opts.storageGb || null, vpcId || '', subnetGroup || '',
         sgIds.join(','), opts.multiAz ? 1 : 0, opts.monitoring ? 1 : 0]
      );
    } catch (e) { console.warn('[rds/create] 落库失败（实例已在云端创建）:', e.message); }
  }

  res.status(201).json({ ok: true, instanceId: result.instanceId, message: result.message });
});

// ══════════════════════════════════════════════════════════════
// 核心函数：创建 RDS 账号并授权（供 feishu.js 调用）
// ══════════════════════════════════════════════════════════════
async function createRdsAccount(platform, cred, instanceId, accountName, password, privilege, databases) {
  if (platform === 'aliyun') return createAliyunRdsAccount(cred, instanceId, accountName, password, privilege, databases);
  if (platform === 'baidu')  return createBaiduRdsAccount(cred, instanceId, accountName, password, privilege, databases);
  if (platform === 'aws')    return createAwsRdsAccount(cred, instanceId, accountName, password, privilege, databases);
  return { success: false, message: `不支持的云平台：${platform}` };
}

// ══════════════════════════════════════════════════════════════
// 阿里云 RDS：CreateAccount + GrantAccountPrivilege
// ══════════════════════════════════════════════════════════════
async function createAliyunRdsAccount(cred, instanceId, accountName, password, privilege, databases) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({
    accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
    endpoint: 'https://rds.aliyuncs.com', apiVersion: '2014-08-15'
  });
  try {
    await client.request('CreateAccount', {
      DBInstanceId: instanceId,
      AccountName: accountName,
      AccountPassword: password,
      AccountType: 'Normal',
      AccountDescription: 'Created by cloud management platform',
    }, { method: 'POST' });
  } catch (e) {
    if (!e.message?.includes('already') && !e.code?.includes('AlreadyExist')) throw e;
  }
  const privType = privilege === 'ReadWrite' ? 'ReadWrite' : 'ReadOnly';
  for (const dbName of (databases || [])) {
    await client.request('GrantAccountPrivilege', {
      DBInstanceId: instanceId,
      AccountName: accountName,
      DBName: dbName,
      AccountPrivilege: privType,
    }, { method: 'POST' });
  }
  return { success: true, message: '账号创建并授权成功', accountName };
}

// ══════════════════════════════════════════════════════════════
// 百度云 RDS：创建账号 + 授权
// ══════════════════════════════════════════════════════════════
async function createBaiduRdsAccount(cred, instanceId, accountName, password, privilege, databases) {
  const host = 'rds.bj.baidubce.com';
  // 创建账号
  await bceRequest(cred, 'POST', `/v1/instance/${encodeURIComponent(instanceId)}/account`, {}, {
    accountName,
    password,
    accountType: 'common',
    desc: 'Created by cloud management platform',
  }, host);
  // 授权数据库
  const privType = privilege === 'ReadWrite' ? 'readWrite' : 'readOnly';
  for (const dbName of (databases || [])) {
    await bceRequest(cred, 'PUT',
      `/v1/instance/${encodeURIComponent(instanceId)}/account/${encodeURIComponent(accountName)}/privilege`,
      {},
      { databasePrivileges: [{ dbName, authType: privType }] },
      host
    );
  }
  return { success: true, message: '账号创建并授权成功', accountName };
}

// ══════════════════════════════════════════════════════════════
// AWS RDS：无管理面 API，返回手动 SQL 提示
// ══════════════════════════════════════════════════════════════
async function createAwsRdsAccount(cred, instanceId, accountName, password, privilege, databases) {
  const inst = await db.get(
    'SELECT endpoint, port FROM cloud_rds_instances WHERE platform = ? AND instance_id = ?',
    ['aws', instanceId]
  );
  const host = inst?.endpoint || instanceId;
  const port = inst?.port || 3306;
  const grantSql = (databases || []).map(d =>
    `GRANT ${privilege === 'ReadWrite' ? 'ALL PRIVILEGES' : 'SELECT'} ON \`${d}\`.* TO '${accountName}'@'%';`
  ).join('\n');
  return {
    success: true,
    needsManual: true,
    message: `AWS RDS 需手动执行以下 SQL（连接 ${host}:${port}）：\nCREATE USER '${accountName}'@'%' IDENTIFIED BY '${password}';\n${grantSql}\nFLUSH PRIVILEGES;`,
    accountName,
  };
}

// ══════════════════════════════════════════════════════════════
// 核心函数：创建数据库实例（供管理员直接创建 / 工单审批后调用）
// opts: { engineKind:'mysql'|'postgres'|'redis', region, engineVersion, instanceClass,
//         storageGb, instanceName, vpcId, vSwitchId(阿里云子网), securityIp,
//         chargeType('PostPaid'默认), accountPassword }
// 返回 { success, instanceId?, message }
// ══════════════════════════════════════════════════════════════
async function createDbInstance(platform, cred, opts) {
  try {
    if (platform === 'aliyun') return await createAliyunDbInstance(cred, opts);
    if (platform === 'aws')    return await createAwsDbInstance(cred, opts);
    if (platform === 'baidu')  return await createBaiduDbInstance(cred, opts);
    return { success: false, message: `不支持的云平台：${platform}` };
  } catch (e) {
    return { success: false, message: `创建实例失败：${e.message}` };
  }
}

// ── 阿里云建实例：RDS(MySQL/PG) 用 CreateDBInstance；Redis 用 r-kvstore CreateInstance ──
async function createAliyunDbInstance(cred, opts) {
  const Core = require('@alicloud/pop-core');
  const { engineKind, region, engineVersion, instanceClass, storageGb,
          instanceName, vpcId, vSwitchId, securityIp, chargeType } = opts;

  if (engineKind === 'redis') {
    const client = new Core({
      accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
      endpoint: 'https://r-kvstore.aliyuncs.com', apiVersion: '2015-01-01',
    });
    const params = {
      RegionId: region,
      InstanceClass: instanceClass,                 // 如 redis.master.small.default
      InstanceName: instanceName || undefined,
      ChargeType: chargeType === 'PrePaid' ? 'PrePaid' : 'PostPaid',
      EngineVersion: engineVersion || '5.0',
      Password: opts.accountPassword || undefined,
    };
    if (vpcId)     { params.VpcId = vpcId; params.InstanceType = 'Redis'; }
    if (vSwitchId) params.VSwitchId = vSwitchId;
    const res = await client.request('CreateInstance', params, { method: 'POST' });
    return { success: true, instanceId: res.InstanceId, message: 'Redis 实例创建中' };
  }

  // MySQL / PostgreSQL 走 RDS
  const client = new Core({
    accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
    endpoint: 'https://rds.aliyuncs.com', apiVersion: '2014-08-15',
  });
  const engine = engineKind === 'postgres' ? 'PostgreSQL' : 'MySQL';

  // 只读实例：从源实例派生，用 CreateReadOnlyDBInstance
  if (opts.isReplica) {
    const roParams = {
      RegionId: region,
      DBInstanceId: opts.sourceInstanceId,
      EngineVersion: engineVersion || (engineKind === 'postgres' ? '14.0' : '8.0'),
      DBInstanceClass: instanceClass,
      DBInstanceStorage: storageGb || 20,
      PayType: chargeType === 'PrePaid' ? 'Prepaid' : 'Postpaid',
    };
    if (vpcId)     { roParams.InstanceNetworkType = 'VPC'; roParams.VPCId = vpcId; }
    if (vSwitchId) roParams.VSwitchId = vSwitchId;
    const res = await client.request('CreateReadOnlyDBInstance', roParams, { method: 'POST' });
    return { success: true, instanceId: res.DBInstanceId, message: `${engine} 只读实例创建中` };
  }

  const params = {
    RegionId: region,
    Engine: engine,
    EngineVersion: engineVersion || (engineKind === 'postgres' ? '14.0' : '8.0'),
    DBInstanceClass: instanceClass,                 // 如 mysql.n2.medium.1
    DBInstanceStorage: storageGb || 20,
    DBInstanceNetType: 'Intranet',
    PayType: chargeType === 'PrePaid' ? 'Prepaid' : 'Postpaid',
    DBInstanceDescription: instanceName || undefined,
    SecurityIPList: securityIp || '127.0.0.1',      // 默认只放开本机，创建后再改白名单
  };
  // 磁盘类型：阿里云用 DBInstanceStorageType，如 cloud_essd / cloud_ssd
  if (opts.storageType) params.DBInstanceStorageType = opts.storageType;
  if (vpcId)     { params.InstanceNetworkType = 'VPC'; params.VPCId = vpcId; }
  if (vSwitchId) params.VSwitchId = vSwitchId;
  const res = await client.request('CreateDBInstance', params, { method: 'POST' });
  const instanceId = res.DBInstanceId;
  // 阿里云建实例 API 不带安全组，需创建后单独调 ModifySecurityGroupConfiguration
  if (instanceId && opts.securityGroupIds?.length) {
    try {
      await client.request('ModifySecurityGroupConfiguration', {
        DBInstanceId: instanceId, RegionId: region, SecurityGroupId: opts.securityGroupIds.join(','),
      }, { method: 'POST' });
    } catch (e) { console.warn('[rds/aliyun] 绑定安全组失败（实例已创建）:', e.message); }
  }
  return { success: true, instanceId, message: `${engine} 实例创建中` };
}

// ── AWS 建实例：RDS(MySQL/PG) 用 CreateDBInstance；Redis 用 ElastiCache CreateCacheCluster ──
async function createAwsDbInstance(cred, opts) {
  const { engineKind, region, engineVersion, instanceClass, storageGb,
          instanceName, accountName, accountPassword } = opts;

  if (engineKind === 'redis') {
    const { ElastiCacheClient, CreateCacheClusterCommand } = require('@aws-sdk/client-elasticache');
    const client = new ElastiCacheClient({
      region, credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key },
    });
    const res = await client.send(new CreateCacheClusterCommand({
      CacheClusterId: instanceName || `redis-${Date.now()}`,
      Engine: 'redis',
      EngineVersion: engineVersion || undefined,
      CacheNodeType: instanceClass || 'cache.t3.micro',
      NumCacheNodes: 1,
    }));
    return { success: true, instanceId: res.CacheCluster?.CacheClusterId, message: 'Redis 集群创建中' };
  }

  const { RDSClient, CreateDBInstanceCommand, CreateDBInstanceReadReplicaCommand } = require('@aws-sdk/client-rds');
  const client = new RDSClient({
    region, credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key },
  });
  const engine = engineKind === 'postgres' ? 'postgres' : 'mysql';

  // 只读副本：从源实例派生，不需引擎/存储/密码等参数
  if (opts.isReplica) {
    const replicaId = (instanceName || `${engine}-ro-${Date.now()}`).replace(/[^a-zA-Z0-9-]/g, '-');
    const res = await client.send(new CreateDBInstanceReadReplicaCommand({
      DBInstanceIdentifier: replicaId,
      SourceDBInstanceIdentifier: opts.sourceInstanceId,
      DBInstanceClass: instanceClass || undefined,
      ...(opts.securityGroupIds?.length ? { VpcSecurityGroupIds: opts.securityGroupIds } : {}),
      ...(opts.monitoring ? { MonitoringInterval: 60, EnablePerformanceInsights: true } : {}),
      PubliclyAccessible: false,
    }));
    return { success: true, instanceId: res.DBInstance?.DBInstanceIdentifier, message: `${engine} 只读副本创建中` };
  }

  const dbId = (instanceName || `${engine}-${Date.now()}`).replace(/[^a-zA-Z0-9-]/g, '-');
  // gp3/io1/io2 支持预置 IOPS
  const iopsCapable = opts.storageType === 'gp3' || opts.storageType === 'io1' || opts.storageType === 'io2';
  const res = await client.send(new CreateDBInstanceCommand({
    DBInstanceIdentifier: dbId,
    Engine: engine,
    EngineVersion: engineVersion || undefined,
    DBInstanceClass: instanceClass || 'db.t3.micro',
    AllocatedStorage: storageGb || 20,
    // 主用户名：'admin' 是 PostgreSQL 引擎保留字不可用，默认统一用 dbadmin（MySQL/PG 均合法）
    MasterUsername: accountName || 'dbadmin',
    MasterUserPassword: accountPassword,
    PubliclyAccessible: false,
    ...(opts.subnetGroup ? { DBSubnetGroupName: opts.subnetGroup } : {}),
    ...(opts.securityGroupIds?.length ? { VpcSecurityGroupIds: opts.securityGroupIds } : {}),
    ...(opts.storageType ? { StorageType: opts.storageType } : {}),
    ...(iopsCapable && opts.iops ? { Iops: opts.iops } : {}),
    // gp3 存储吞吐量
    ...(opts.storageType === 'gp3' && opts.storageThroughput ? { StorageThroughput: opts.storageThroughput } : {}),
    // 存储自动扩展最大阈值
    ...(opts.maxAllocatedStorage ? { MaxAllocatedStorage: opts.maxAllocatedStorage } : {}),
    ...(opts.multiAz ? { MultiAZ: true } : {}),
    ...(opts.monitoring ? { MonitoringInterval: 60, EnablePerformanceInsights: true } : {}),
  }));
  return { success: true, instanceId: res.DBInstance?.DBInstanceIdentifier, message: `${engine} 实例创建中` };
}

// ── 百度云建实例：RDS 用 POST /v1/instance；Redis(SCS) 用 scs 域名 POST /v1/instance ──
async function createBaiduDbInstance(cred, opts) {
  const { engineKind, region, engineVersion, instanceName, storageGb, chargeType } = opts;
  const billing = { paymentTiming: chargeType === 'PrePaid' ? 'Prepaid' : 'Postpaid' };

  if (engineKind === 'redis') {
    const host = `redis.${region || 'bj'}.baidubce.com`;
    const body = {
      billing,
      instanceName: instanceName || `redis-${Date.now()}`,
      nodeType: opts.instanceClass || 'cache.n1.micro',
      shardNum: 1,
      engineVersion: engineVersion || '5.0',
      clientToken: uuidv4(),
    };
    const res = await bceRequest(cred, 'POST', '/v1/instance', {}, body, host);
    const instanceId = (res.instanceIds && res.instanceIds[0]) || res.instanceId;
    return { success: true, instanceId, message: 'Redis(SCS) 实例创建中' };
  }

  const host = `rds.${region || 'bj'}.baidubce.com`;
  const engine = engineKind === 'postgres' ? 'postgresql' : 'mysql';

  // 只读实例：百度云 RDS 用 POST /v1/instance/readReplica，需指定源实例
  if (opts.isReplica) {
    const roBody = {
      billing,
      sourceInstanceId: opts.sourceInstanceId,
      cpuCount: opts.cpuCount || 1,
      memoryCapacity: opts.memoryGb || 2,
      volumeCapacity: storageGb || 20,
      instanceName: instanceName || `${engine}-ro-${Date.now()}`,
      clientToken: uuidv4(),
    };
    const res = await bceRequest(cred, 'POST', '/v1/instance/readReplica', {}, roBody, host);
    const instanceId = (res.instanceIds && res.instanceIds[0]) || res.instanceId;
    return { success: true, instanceId, message: `${engine} 只读实例创建中` };
  }

  const body = {
    billing,
    engine,
    engineVersion: engineVersion || (engineKind === 'postgres' ? '14' : '8.0'),
    cpuCount: opts.cpuCount || 1,
    memoryCapacity: opts.memoryGb || 2,
    volumeCapacity: storageGb || 20,
    instanceName: instanceName || `${engine}-${Date.now()}`,
    clientToken: uuidv4(),
  };
  // 磁盘类型：百度云用 diskIoType，如 cloud_high / cloud_enha
  if (opts.storageType) body.diskIoType = opts.storageType;
  const res = await bceRequest(cred, 'POST', '/v1/instance', {}, body, host);
  const instanceId = (res.instanceIds && res.instanceIds[0]) || res.instanceId;
  return { success: true, instanceId, message: `${engine} 实例创建中` };
}

// ══════════════════════════════════════════════════════════════
// 同步实现
// ══════════════════════════════════════════════════════════════
async function syncAwsRdsInstances(cred) {
  const { RDSClient, DescribeDBInstancesCommand } = require('@aws-sdk/client-rds');
  const all = [];
  const regionResults = await Promise.allSettled(AWS_REGIONS.map(async region => {
    const client = new RDSClient({
      region,
      credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
    });
    const instances = [];
    let marker;
    do {
      const res = await client.send(new DescribeDBInstancesCommand({ Marker: marker }));
      for (const i of res.DBInstances || []) {
        instances.push({
          instance_id:    i.DBInstanceIdentifier,
          instance_name:  i.DBInstanceIdentifier,
          engine:         i.Engine || '',
          engine_version: i.EngineVersion || '',
          instance_class: i.DBInstanceClass || '',
          status:         i.DBInstanceStatus || '',
          region,
          endpoint:       i.Endpoint?.Address || '',
          port:           i.Endpoint?.Port || 3306,
          databases:      [],
        });
      }
      marker = res.Marker;
    } while (marker);
    return instances;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[rds/aws] region failed: ${r.reason?.message}`);
  }
  return all;
}

async function syncAliyunRdsInstances(cred) {
  const Core = require('@alicloud/pop-core');
  const all = [];
  const regionResults = await Promise.allSettled(ALIYUN_REGIONS.map(async region => {
    const client = new Core({
      accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
      endpoint: `https://rds.aliyuncs.com`, apiVersion: '2014-08-15'
    });
    const instances = [];
    let pageNumber = 1;
    while (true) {
      const res = await client.request('DescribeDBInstances', { RegionId: region, PageSize: 100, PageNumber: pageNumber }, { method: 'POST' });
      const list = (res.Items || {}).DBInstance || [];
      for (const i of list) {
        instances.push({
          instance_id:    i.DBInstanceId,
          instance_name:  i.DBInstanceDescription || i.DBInstanceId,
          engine:         i.Engine || '',
          engine_version: i.EngineVersion || '',
          instance_class: i.DBInstanceClass || '',
          status:         i.DBInstanceStatus || '',
          region:         i.RegionId || region,
          endpoint:       i.ConnectionString || '',
          port:           parseInt(i.Port || '3306'),
          databases:      [],
        });
      }
      if (list.length < 100) break;
      pageNumber++;
    }
    return instances;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[rds/aliyun] region failed: ${r.reason?.message}`);
  }
  return all;
}

async function syncBaiduRdsInstances(cred) {
  const all = [];
  const regionResults = await Promise.allSettled(BAIDU_DB_REGIONS.map(async region => {
    const host = `rds.${region}.baidubce.com`;
    const instances = [];
    let marker;
    do {
      const query = { maxKeys: 100 };
      if (marker) query.marker = marker;
      const res = await bceRequest(cred, 'GET', '/v1/instance', query, null, host);
      for (const i of (res.instances || res.result || [])) {
        instances.push({
          instance_id:    i.instanceId,
          instance_name:  i.instanceName || i.instanceId,
          engine:         i.engine || 'MySQL',
          engine_version: i.engineVersion || '',
          instance_class: i.cpuCount ? `${i.cpuCount}C${i.memoryCapacity}G` : '',
          status:         i.instanceStatus || '',
          region,
          endpoint:       i.endpoint?.address ? `${i.endpoint.address}:${i.endpoint.port}` : '',
          port:           i.endpoint?.port || 3306,
          databases:      [],
        });
      }
      marker = res.isTruncated ? (res.nextMarker || res.marker) : undefined;
    } while (marker);
    return instances;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[rds/baidu] region failed: ${r.reason?.message}`);
  }
  return all;
}

// ══════════════════════════════════════════════════════════════
// Redis 同步
// ══════════════════════════════════════════════════════════════

async function syncAwsRedisInstances(cred) {
  const { ElastiCacheClient, DescribeReplicationGroupsCommand, DescribeCacheClustersCommand } = require('@aws-sdk/client-elasticache');
  const all = [];
  const regionResults = await Promise.allSettled(AWS_REGIONS.map(async region => {
    const client = new ElastiCacheClient({
      region,
      credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
    });
    const instances = [];
    // 拉取 Redis 集群（ReplicationGroup = Redis，CacheCluster engine=redis）
    let marker;
    do {
      const res = await client.send(new DescribeCacheClustersCommand({ Marker: marker, ShowCacheNodeInfo: true }));
      for (const c of res.CacheClusters || []) {
        if ((c.Engine || '').toLowerCase() !== 'redis') continue;
        const node = (c.CacheNodes || [])[0];
        instances.push({
          instance_id:    c.CacheClusterId,
          instance_name:  c.CacheClusterId,
          engine:         'Redis',
          engine_version: c.EngineVersion || '',
          instance_class: c.CacheNodeType || '',
          status:         c.CacheClusterStatus || '',
          region,
          endpoint:       node?.Endpoint?.Address || c.ConfigurationEndpoint?.Address || '',
          port:           node?.Endpoint?.Port || c.ConfigurationEndpoint?.Port || 6379,
          databases:      [],
        });
      }
      marker = res.Marker;
    } while (marker);
    return instances;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[redis/aws] region failed: ${r.reason?.message}`);
  }
  return all;
}

async function syncAliyunRedisInstances(cred) {
  const Core = require('@alicloud/pop-core');
  const all = [];
  const regionResults = await Promise.allSettled(ALIYUN_REGIONS.map(async region => {
    const client = new Core({
      accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
      endpoint: 'https://r-kvstore.aliyuncs.com', apiVersion: '2015-01-01'
    });
    const instances = [];
    let pageNumber = 1;
    while (true) {
      const res = await client.request('DescribeInstances', { RegionId: region, PageSize: 50, PageNumber: pageNumber }, { method: 'POST' });
      const list = (res.Instances || {}).KVStoreInstance || [];
      for (const i of list) {
        instances.push({
          instance_id:    i.InstanceId,
          instance_name:  i.InstanceName || i.InstanceId,
          engine:         'Redis',
          engine_version: i.EngineVersion || '',
          instance_class: i.InstanceClass || '',
          status:         i.InstanceStatus || '',
          region:         i.RegionId || region,
          endpoint:       i.ConnectionDomain || '',
          port:           i.Port || 6379,
          databases:      [],
        });
      }
      if (list.length < 50) break;
      pageNumber++;
    }
    return instances;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[redis/aliyun] region failed: ${r.reason?.message}`);
  }
  return all;
}

async function syncBaiduRedisInstances(cred) {
  const all = [];
  const regionResults = await Promise.allSettled(BAIDU_DB_REGIONS.map(async region => {
    const host = `redis.${region}.baidubce.com`;
    const instances = [];
    let marker;
    do {
      const query = { maxKeys: 100 };
      if (marker) query.marker = marker;
      const res = await bceRequest(cred, 'GET', '/v1/instance', query, null, host);
      for (const i of (res.instances || [])) {
        instances.push({
          instance_id:    i.instanceId,
          instance_name:  i.instanceName || i.instanceId,
          engine:         'Redis',
          engine_version: i.engineVersion || '',
          instance_class: i.nodeType || '',
          status:         i.instanceStatus || '',
          region,
          endpoint:       i.domain || '',
          port:           i.port || 6379,
          databases:      [],
        });
      }
      marker = res.isTruncated ? (res.nextMarker || res.marker) : undefined;
    } while (marker);
    return instances;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[redis/baidu] region failed: ${r.reason?.message}`);
  }
  return all;
}

// ══════════════════════════════════════════════════════════════
// 数据库列表查询
// ══════════════════════════════════════════════════════════════
async function listAwsDatabases(cred, instanceId) {
  const { RDSClient, DescribeDBInstancesCommand } = require('@aws-sdk/client-rds');
  const client = new RDSClient({
    region: cred.region || 'us-east-1',
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });
  const res = await client.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: instanceId }));
  const inst = (res.DBInstances || [])[0];
  return (inst?.AssociatedRoles || []).map(r => r.FeatureName).filter(Boolean);
}

async function listAliyunDatabases(cred, instanceId) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({
    accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
    endpoint: 'https://rds.aliyuncs.com', apiVersion: '2014-08-15'
  });
  const res = await client.request('DescribeDatabases', { DBInstanceId: instanceId }, { method: 'POST' });
  return ((res.Databases || {}).Database || []).map(d => d.DBName);
}

async function listBaiduDatabases(cred, instanceId) {
  const host = 'rds.bj.baidubce.com';
  const res = await bceRequest(cred, 'GET', `/v1/instance/${encodeURIComponent(instanceId)}/database`, {}, null, host);
  return (res.databases || []).map(d => d.dbName || d.name).filter(Boolean);
}

module.exports = router;
module.exports.createRdsAccount = createRdsAccount;
module.exports.createDbInstance = createDbInstance;
