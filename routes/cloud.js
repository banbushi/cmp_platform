const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../utils/database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const bceRequest = require('../utils/bce');

const router = express.Router();

const POLICIES = {
  aws: [
    { id: 'AdministratorAccess', name: '管理员权限', desc: '完全访问所有 AWS 服务和资源', level: 'danger' },
    { id: 'PowerUserAccess', name: '高级用户', desc: '除 IAM 用户管理外的完全权限', level: 'warning' },
    { id: 'ReadOnlyAccess', name: '只读权限', desc: '只读访问所有 AWS 服务', level: 'safe' },
    { id: 'AmazonS3FullAccess', name: 'S3 完全权限', desc: '管理 S3 对象存储', level: 'normal' },
    { id: 'AmazonEC2FullAccess', name: 'EC2 完全权限', desc: '管理 EC2 云服务器', level: 'normal' },
    { id: 'AmazonRDSFullAccess', name: 'RDS 完全权限', desc: '管理 RDS 关系型数据库', level: 'normal' },
    { id: 'AWSLambdaFullAccess', name: 'Lambda 完全权限', desc: '管理无服务器函数', level: 'normal' },
    { id: 'AmazonVPCFullAccess', name: 'VPC 完全权限', desc: '管理虚拟私有云网络', level: 'normal' }
  ],
  aliyun: [
    { id: 'AdministratorAccess', name: '管理员权限', desc: '管理所有阿里云资源', level: 'danger' },
    { id: 'ReadOnlyAccess', name: '只读权限', desc: '只读访问所有阿里云资源', level: 'safe' },
    { id: 'AliyunECSFullAccess', name: 'ECS 完全权限', desc: '管理云服务器 ECS', level: 'normal' },
    { id: 'AliyunOSSFullAccess', name: 'OSS 完全权限', desc: '管理对象存储 OSS', level: 'normal' },
    { id: 'AliyunRDSFullAccess', name: 'RDS 完全权限', desc: '管理关系型数据库 RDS', level: 'normal' },
    { id: 'AliyunVPCFullAccess', name: 'VPC 完全权限', desc: '管理专有网络 VPC', level: 'normal' },
    { id: 'AliyunSLBFullAccess', name: 'SLB 完全权限', desc: '管理负载均衡 SLB', level: 'normal' },
    { id: 'AliyunCloudMonitorFullAccess', name: '云监控权限', desc: '访问云监控服务', level: 'normal' }
  ],
  baidu: [
    { id: 'BCEFullAccess', name: '完全访问权限', desc: '管理所有百度智能云资源', level: 'danger' },
    { id: 'BCEReadOnlyAccess', name: '只读权限', desc: '只读访问百度智能云资源', level: 'safe' },
    { id: 'BOSFullAccess', name: 'BOS 完全权限', desc: '管理对象存储 BOS', level: 'normal' },
    { id: 'BCCFullAccess', name: 'BCC 完全权限', desc: '管理云服务器 BCC', level: 'normal' },
    { id: 'RDSFullAccess', name: 'RDS 完全权限', desc: '管理关系型数据库 RDS', level: 'normal' },
    { id: 'BLBFullAccess', name: 'BLB 完全权限', desc: '管理负载均衡 BLB', level: 'normal' },
    { id: 'VPCFullAccess', name: 'VPC 完全权限', desc: '管理私有网络 VPC', level: 'normal' },
    { id: 'BMRFullAccess', name: 'BMR 权限', desc: '管理 MapReduce 服务', level: 'normal' }
  ]
};

router.get('/policies', authenticate, (req, res) => {
  res.json({ policies: POLICIES });
});

// ── 实例规格 & 可用区 ──

const INSTANCE_TYPES = {
  aws: [
    { id: 't2.micro',    desc: '1 vCPU / 1 GiB   免费套餐', category: '通用型 T2' },
    { id: 't2.small',    desc: '1 vCPU / 2 GiB',            category: '通用型 T2' },
    { id: 't2.medium',   desc: '2 vCPU / 4 GiB',            category: '通用型 T2' },
    { id: 't3.micro',    desc: '2 vCPU / 1 GiB   免费套餐', category: '通用型 T3' },
    { id: 't3.small',    desc: '2 vCPU / 2 GiB',            category: '通用型 T3' },
    { id: 't3.medium',   desc: '2 vCPU / 4 GiB',            category: '通用型 T3' },
    { id: 't3.large',    desc: '2 vCPU / 8 GiB',            category: '通用型 T3' },
    { id: 'm5.large',    desc: '2 vCPU / 8 GiB',            category: '通用型 M5' },
    { id: 'm5.xlarge',   desc: '4 vCPU / 16 GiB',           category: '通用型 M5' },
    { id: 'm5.2xlarge',  desc: '8 vCPU / 32 GiB',           category: '通用型 M5' },
    { id: 'c5.large',    desc: '2 vCPU / 4 GiB',            category: '计算优化 C5' },
    { id: 'c5.xlarge',   desc: '4 vCPU / 8 GiB',            category: '计算优化 C5' },
    { id: 'c5.2xlarge',  desc: '8 vCPU / 16 GiB',           category: '计算优化 C5' },
    { id: 'r5.large',    desc: '2 vCPU / 16 GiB',           category: '内存优化 R5' },
    { id: 'r5.xlarge',   desc: '4 vCPU / 32 GiB',           category: '内存优化 R5' }
  ],
  aliyun: [
    { id: 'ecs.t5-lc1m1.small',  desc: '1 vCPU / 1 GiB',   category: '共享型 T5' },
    { id: 'ecs.t5-lc1m2.small',  desc: '1 vCPU / 2 GiB',   category: '共享型 T5' },
    { id: 'ecs.t5-c1m2.small',   desc: '1 vCPU / 2 GiB',   category: '共享型 T5' },
    { id: 'ecs.t5-c1m4.small',   desc: '1 vCPU / 4 GiB',   category: '共享型 T5' },
    { id: 'ecs.n4.small',        desc: '1 vCPU / 2 GiB',   category: '通用型 N4' },
    { id: 'ecs.n4.large',        desc: '2 vCPU / 4 GiB',   category: '通用型 N4' },
    { id: 'ecs.n4.xlarge',       desc: '4 vCPU / 8 GiB',   category: '通用型 N4' },
    { id: 'ecs.c6.large',        desc: '2 vCPU / 4 GiB',   category: '计算型 C6' },
    { id: 'ecs.c6.xlarge',       desc: '4 vCPU / 8 GiB',   category: '计算型 C6' },
    { id: 'ecs.c6.2xlarge',      desc: '8 vCPU / 16 GiB',  category: '计算型 C6' },
    { id: 'ecs.g6.large',        desc: '2 vCPU / 8 GiB',   category: '通用平衡型 G6' },
    { id: 'ecs.g6.xlarge',       desc: '4 vCPU / 16 GiB',  category: '通用平衡型 G6' },
    { id: 'ecs.r6.large',        desc: '2 vCPU / 16 GiB',  category: '内存型 R6' },
    { id: 'ecs.r6.xlarge',       desc: '4 vCPU / 32 GiB',  category: '内存型 R6' }
  ],
  baidu: [
    { id: 'bcc.ic4.c1m1',   desc: '1 vCPU / 1 GiB',   category: '入门型 ic4' },
    { id: 'bcc.ic4.c2m2',   desc: '2 vCPU / 2 GiB',   category: '入门型 ic4' },
    { id: 'bcc.ic4.c4m4',   desc: '4 vCPU / 4 GiB',   category: '入门型 ic4' },
    { id: 'bcc.g5.c2m4',    desc: '2 vCPU / 4 GiB',   category: '通用型 g5' },
    { id: 'bcc.g5.c4m8',    desc: '4 vCPU / 8 GiB',   category: '通用型 g5' },
    { id: 'bcc.g5.c8m16',   desc: '8 vCPU / 16 GiB',  category: '通用型 g5' },
    { id: 'bcc.g5.c16m32',  desc: '16 vCPU / 32 GiB', category: '通用型 g5' },
    { id: 'bcc.c4.c2m4',    desc: '2 vCPU / 4 GiB',   category: '计算型 c4' },
    { id: 'bcc.c4.c4m8',    desc: '4 vCPU / 8 GiB',   category: '计算型 c4' },
    { id: 'bcc.m4.c2m8',    desc: '2 vCPU / 8 GiB',   category: '内存型 m4' },
    { id: 'bcc.m4.c4m16',   desc: '4 vCPU / 16 GiB',  category: '内存型 m4' }
  ]
};

const ZONES = {
  aws: {
    'us-east-1':      ['us-east-1a', 'us-east-1b', 'us-east-1c', 'us-east-1d'],
    'us-west-2':      ['us-west-2a', 'us-west-2b', 'us-west-2c'],
    'cn-north-1':     ['cn-north-1a', 'cn-north-1b'],
    'cn-northwest-1': ['cn-northwest-1a', 'cn-northwest-1b'],
    'ap-northeast-1': ['ap-northeast-1a', 'ap-northeast-1b', 'ap-northeast-1c'],
    'ap-southeast-1': ['ap-southeast-1a', 'ap-southeast-1b', 'ap-southeast-1c']
  },
  aliyun: {
    'cn-hangzhou': ['cn-hangzhou-g', 'cn-hangzhou-h', 'cn-hangzhou-i', 'cn-hangzhou-j'],
    'cn-shanghai': ['cn-shanghai-b', 'cn-shanghai-e', 'cn-shanghai-f', 'cn-shanghai-g'],
    'cn-beijing':  ['cn-beijing-c', 'cn-beijing-d', 'cn-beijing-e', 'cn-beijing-f'],
    'cn-shenzhen': ['cn-shenzhen-a', 'cn-shenzhen-b', 'cn-shenzhen-c', 'cn-shenzhen-d'],
    'cn-hongkong': ['cn-hongkong-b', 'cn-hongkong-c']
  },
  baidu: {
    'bj':  ['cn-bj-a', 'cn-bj-b', 'cn-bj-c', 'cn-bj-d'],
    'gz':  ['cn-gz-a', 'cn-gz-b'],
    'su':  ['cn-su-a', 'cn-su-b', 'cn-su-c'],
    'hkg': ['cn-hkg-a']
  }
};

router.get('/instance-types', authenticate, (req, res) => {
  res.json({ instance_types: INSTANCE_TYPES, zones: ZONES });
});

// ── 动态实例规格 & 镜像（带 5 分钟缓存）──
const _apiCache = new Map();
const _CACHE_TTL = 5 * 60 * 1000;
function _getCached(key) {
  const e = _apiCache.get(key);
  if (e && Date.now() < e.expires) return e.data;
  _apiCache.delete(key);
  return null;
}
function _setCached(key, data) { _apiCache.set(key, { data, expires: Date.now() + _CACHE_TTL }); }

// ── AWS EC2 ──
async function awsFetchInstanceTypes(cred, region) {
  const { EC2Client, DescribeInstanceTypesCommand } = require('@aws-sdk/client-ec2');
  const client = new EC2Client({
    region: region || 'us-east-1',
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });
  const result = [];
  let nextToken;
  do {
    const resp = await client.send(new DescribeInstanceTypesCommand({
      Filters: [{ Name: 'current-generation', Values: ['true'] }],
      MaxResults: 100,
      ...(nextToken ? { NextToken: nextToken } : {})
    }));
    for (const t of resp.InstanceTypes || []) {
      const vcpu = t.VCpuInfo?.DefaultVCpus ?? '?';
      const mem  = t.MemoryInfo?.SizeInMiB ? (t.MemoryInfo.SizeInMiB / 1024).toFixed(0) : '?';
      result.push({ id: t.InstanceType, desc: `${vcpu} vCPU / ${mem} GiB`, category: t.InstanceType.split('.')[0].toUpperCase() });
    }
    nextToken = resp.NextToken;
  } while (nextToken && result.length < 400);
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

async function awsFetchImages(cred, region) {
  const { EC2Client, DescribeImagesCommand } = require('@aws-sdk/client-ec2');
  const client = new EC2Client({
    region: region || 'us-east-1',
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });
  const resp = await client.send(new DescribeImagesCommand({
    Owners: ['amazon', '099720109477'],
    Filters: [
      { Name: 'state', Values: ['available'] },
      { Name: 'architecture', Values: ['x86_64'] },
      { Name: 'virtualization-type', Values: ['hvm'] },
      { Name: 'root-device-type', Values: ['ebs'] },
      { Name: 'name', Values: ['amzn2-ami-hvm-*', 'al2023-ami-*', 'ubuntu/images/hvm-ssd/ubuntu-*'] }
    ]
  }));
  return (resp.Images || [])
    .sort((a, b) => new Date(b.CreationDate) - new Date(a.CreationDate))
    .slice(0, 60)
    .map(img => ({ id: img.ImageId, name: img.Name, desc: img.Description || '' }));
}

// ── 阿里云 ECS ──
async function aliyunFetchInstanceTypes(cred) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({
    accessKeyId: cred.access_key,
    accessKeySecret: cred.secret_key,
    endpoint: 'https://ecs.aliyuncs.com',
    apiVersion: '2014-05-26'
  });
  const result = [];
  let nextToken;
  do {
    const resp = await client.request('DescribeInstanceTypes', {
      MaxResults: 100,
      ...(nextToken ? { NextToken: nextToken } : {})
    }, { method: 'POST' });
    for (const t of resp.InstanceTypes?.InstanceType || []) {
      result.push({
        id: t.InstanceTypeId,
        desc: `${t.CpuCoreCount} vCPU / ${t.MemorySize} GiB`,
        category: t.InstanceTypeFamily || t.InstanceTypeId.split('.').slice(0, 2).join('.')
      });
    }
    nextToken = resp.NextToken;
  } while (nextToken && result.length < 400);
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

async function aliyunFetchImages(cred, region) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({
    accessKeyId: cred.access_key,
    accessKeySecret: cred.secret_key,
    endpoint: `https://ecs.${region || 'cn-hangzhou'}.aliyuncs.com`,
    apiVersion: '2014-05-26'
  });
  const resp = await client.request('DescribeImages', {
    ImageOwnerAlias: 'system',
    OSType: 'linux',
    Status: 'Available',
    PageSize: 50,
    PageNumber: 1
  }, { method: 'POST' });
  return (resp.Images?.Image || []).map(img => ({
    id: img.ImageId, name: img.ImageName, desc: img.OSName || img.ImageName
  }));
}

// ── 百度智能云 BCC ──
async function baiduFetchInstanceTypes(cred, region) {
  const bccHost = `bcc.${region || 'bj'}.baidubce.com`;
  const resp = await bceRequest(cred, 'GET', '/v2/instanceType', {}, null, bccHost);
  return (resp.instanceTypes || []).map(t => ({
    id: t.spec,
    desc: `${t.cpuCount} vCPU / ${t.memoryCapacityInGB} GiB`,
    category: t.specFamily || t.spec.split('.').slice(0, 2).join('.')
  }));
}

async function baiduFetchImages(cred, region) {
  const bccHost = `bcc.${region || 'bj'}.baidubce.com`;
  const resp = await bceRequest(cred, 'GET', '/v2/image', { imageType: 'System', maxKeys: 50 }, null, bccHost);
  return (resp.images || []).map(img => ({
    id: img.id,
    name: img.name,
    desc: `${img.osName || ''} ${img.osVersion || ''}`.trim()
  }));
}

router.get('/instance-types/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  const region = req.query.region || '';
  const cacheKey = `types:${platform}:${region}`;
  const cached = _getCached(cacheKey);
  if (cached) return res.json({ instance_types: cached });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ?', [platform]);
  if (!cred) return res.json({ instance_types: INSTANCE_TYPES[platform] || [] });

  try {
    let types;
    if      (platform === 'aws')    types = await awsFetchInstanceTypes(cred, region);
    else if (platform === 'aliyun') types = await aliyunFetchInstanceTypes(cred);
    else if (platform === 'baidu')  types = await baiduFetchInstanceTypes(cred, region);
    else return res.status(400).json({ error: '不支持的云平台' });
    _setCached(cacheKey, types);
    res.json({ instance_types: types });
  } catch (e) {
    console.error(`[cloud/instance-types/${platform}]`, e.message);
    res.json({ instance_types: INSTANCE_TYPES[platform] || [], fallback: true });
  }
});

router.get('/images/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  const region = req.query.region || '';
  const cacheKey = `images:${platform}:${region}`;
  const cached = _getCached(cacheKey);
  if (cached) return res.json({ images: cached });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ?', [platform]);
  if (!cred) return res.status(400).json({ error: '请先配置云平台凭据' });

  try {
    let images;
    if      (platform === 'aws')    images = await awsFetchImages(cred, region);
    else if (platform === 'aliyun') images = await aliyunFetchImages(cred, region);
    else if (platform === 'baidu')  images = await baiduFetchImages(cred, region);
    else return res.status(400).json({ error: '不支持的云平台' });
    _setCached(cacheKey, images);
    res.json({ images });
  } catch (e) {
    console.error(`[cloud/images/${platform}]`, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 按需计费单价查询（60 分钟缓存）──
const _priceCache = new Map();
const _PRICE_TTL = 60 * 60 * 1000;
function _getPriceCached(key) {
  const e = _priceCache.get(key);
  if (e && Date.now() < e.expires) return e.data;
  _priceCache.delete(key);
  return null;
}
function _setPriceCached(key, data) { _priceCache.set(key, { data, expires: Date.now() + _PRICE_TTL }); }

// AWS region id → Pricing API location name
const _AWS_LOCATIONS = {
  'us-east-1': 'US East (N. Virginia)',
  'us-east-2': 'US East (Ohio)',
  'us-west-1': 'US West (N. California)',
  'us-west-2': 'US West (Oregon)',
  'ap-northeast-1': 'Asia Pacific (Tokyo)',
  'ap-northeast-2': 'Asia Pacific (Seoul)',
  'ap-southeast-1': 'Asia Pacific (Singapore)',
  'ap-southeast-2': 'Asia Pacific (Sydney)',
  'ap-south-1': 'Asia Pacific (Mumbai)',
  'eu-west-1': 'EU (Ireland)',
  'eu-central-1': 'EU (Frankfurt)',
  'sa-east-1': 'South America (Sao Paulo)'
  // cn-* 使用不同端点，暂不支持
};

// AWS 按需价格支持的操作系统（对应 Pricing API 的 operatingSystem 字段）
const _AWS_OS_LIST = [
  { key: 'Linux',       label: 'Linux' },
  { key: 'Windows',     label: 'Windows' },
  { key: 'RHEL',        label: 'RHEL' },
  { key: 'SUSE',        label: 'SUSE' },
  { key: 'Ubuntu Pro',  label: 'Ubuntu Pro' }
];

async function _awsFetchPriceForOs(client, GetProductsCommand, location, instanceType, os) {
  const resp = await client.send(new GetProductsCommand({
    ServiceCode: 'AmazonEC2',
    Filters: [
      { Type: 'TERM_MATCH', Field: 'instanceType',     Value: instanceType },
      { Type: 'TERM_MATCH', Field: 'location',         Value: location },
      { Type: 'TERM_MATCH', Field: 'operatingSystem',  Value: os },
      { Type: 'TERM_MATCH', Field: 'tenancy',          Value: 'Shared' },
      { Type: 'TERM_MATCH', Field: 'capacitystatus',   Value: 'Used' },
      { Type: 'TERM_MATCH', Field: 'preInstalledSw',   Value: 'NA' }
    ],
    MaxResults: 1
  }));
  if (!resp.PriceList?.length) return null;
  const item = JSON.parse(resp.PriceList[0]);
  const onDemand = item.terms?.OnDemand;
  if (!onDemand) return null;
  const dim = Object.values(Object.values(onDemand)[0].priceDimensions)[0];
  const p = parseFloat(dim.pricePerUnit?.USD ?? 0);
  return Number.isFinite(p) ? p : null;
}

async function awsFetchPrice(cred, region, instanceType) {
  const location = _AWS_LOCATIONS[region];
  if (!location) return { price: null, currency: 'USD', unit: '小时', note: '中国区价格暂不支持' };

  const { PricingClient, GetProductsCommand } = require('@aws-sdk/client-pricing');
  const client = new PricingClient({
    region: 'us-east-1',   // Pricing API 全球端点只在 us-east-1
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });

  // 并行查询各操作系统的按需价
  const settled = await Promise.allSettled(
    _AWS_OS_LIST.map(os => _awsFetchPriceForOs(client, GetProductsCommand, location, instanceType, os.key))
  );
  const osPrices = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value != null) {
      osPrices.push({ os: _AWS_OS_LIST[i].label, price: r.value });
    }
  });

  // Linux 作为主价格（无 Linux 则取最低者）
  const linux = osPrices.find(o => o.os === 'Linux');
  const primary = linux || osPrices.slice().sort((a, b) => a.price - b.price)[0];
  return {
    price: primary ? primary.price : null,
    currency: 'USD',
    unit: '小时',
    osPrices   // [{os, price}]，供前端展示分操作系统价格
  };
}

async function aliyunFetchPrice(cred, region, instanceType) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({
    accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
    endpoint: `https://ecs.${region || 'cn-hangzhou'}.aliyuncs.com`,
    apiVersion: '2014-05-26'
  });
  // 不同规格支持的系统盘类型不同：不指定会默认 cloud（普通云盘），新一代/经济型规格不支持而报错。
  // 覆盖阿里云全部云盘类型，按常见度重试，命中即返回。经济型(e)/通用算力型(u1)常需 essd_entry。
  const diskCategories = ['cloud_essd', 'cloud_essd_entry', 'cloud_auto', 'cloud_efficiency', 'cloud_ssd', 'cloud'];
  let lastErr;
  for (const cat of diskCategories) {
    try {
      const resp = await client.request('DescribePrice', {
        RegionId: region, InstanceType: instanceType, PriceUnit: 'Hour', Amount: 1,
        'SystemDisk.Category': cat
      }, { method: 'POST' });
      const tradePrice = resp.PriceInfo?.Price?.TradePrice;
      return { price: tradePrice != null ? parseFloat(tradePrice) : null, currency: 'CNY', unit: '小时' };
    } catch (e) {
      lastErr = e;
      // 仅当是磁盘类型不被支持/不合法时才换下一种；其他错误直接抛出
      if (!/disk category|SystemDisk\.Category/i.test(e.message || '')) throw e;
    }
  }
  // 所有盘型都不被该规格接受 —— 视为该地域不可正常购买，交由上层标记为 unavailable 隐藏
  throw lastErr;
}

// 百度价格：AK/SK OpenAPI（/v2/instance/price）经反复验证始终 HttpMessageNotReadable，无法用。
// 改用价格计算器公开接口（cookie 鉴权），从规格名解析 specId/cpu/内存 拼请求。
// cookie 放环境变量 BAIDU_CALCULATOR_COOKIE，过期后更新即可。
function _parseBaiduSpec(instanceType) {
  // bcc.m5.c2m16 -> specId=m5, cpu=2, mem=16 ; bcc.lgn1.c12m40.1p40 -> specId=lgn1, cpu12 mem40
  const t = String(instanceType || '');
  const parts = t.split('.');
  const specId = parts[1] || '';
  const cm = t.match(/c(\d+)m(\d+)/i);
  return { specId, cpu: cm ? parseInt(cm[1]) : 0, memory: cm ? parseInt(cm[2]) : 0 };
}

async function baiduFetchPrice(cred, region, instanceType) {
  const cookie = process.env.BAIDU_CALCULATOR_COOKIE;
  if (!cookie) {
    return { price: null, currency: 'CNY', unit: '小时', note: '未配置百度价格来源' };
  }
  const { specId, cpu, memory } = _parseBaiduSpec(instanceType);
  if (!specId || !cpu || !memory) {
    return { price: null, currency: 'CNY', unit: '小时', note: '暂无公开价格数据' };
  }

  // 用预付费（prepay）+ 购买 1 个月：specPrice 直接就是标准月价（如 e1.c4m8 = 211.6 元/月），无需换算
  const body = {
    bcc: {
      cpu, memory, spec: instanceType, specId, productType: 'prepay',
      rootDiskSizeInGb: 20, rootDiskStorageType: 'enhanced_ssd_pl1',
      gpuCard: '', gpuCount: 0, kunlunCard: '', kunlunCount: 0,
      fpgaCard: '', fpgaCount: 0, ephemeralSizeGb: 0
    },
    cds: { diskConfigs: [], productType: 'prepay' },
    purchaseLength: 1, purchaseNum: 1, region: region || 'bj'
  };

  try {
    const r = await fetch('https://cloud.baidu.com/api/calculator/bcc/instance/priceV2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Origin': 'https://cloud.baidu.com',
        'Referer': 'https://cloud.baidu.com/price/calculator?product=bcc',
        'User-Agent': 'Mozilla/5.0',
        'Cookie': cookie
      },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!data?.success) {
      // 常见：cookie 过期（success:false / 跳登录）
      console.warn(`[cloud/price/baidu] 计算器返回异常(${instanceType}):`, JSON.stringify(data).slice(0, 200));
      return { price: null, currency: 'CNY', unit: '小时', note: 'cookie 可能已过期' };
    }
    // 纯 BCC 实例月价（prepay，购买 1 个月）：优先 specIdPrices，回退 priceDetail[BCC]
    let raw = data.result?.specIdPrices?.[0]?.specPrices?.[0]?.specPrice ?? null;
    if (raw == null) {
      const bcc = (data.result?.priceDetail || []).find(d => d.servicetype === 'BCC');
      raw = bcc?.discountPriceNew?.price ?? bcc?.discountPrice?.price ?? bcc?.price?.[0] ?? null;
    }
    const price = raw != null ? parseFloat(raw) : null;
    if (price == null || isNaN(price)) {
      return { price: null, currency: 'CNY', unit: '小时', note: '暂无公开价格数据' };
    }
    return { price, currency: 'CNY', unit: '月' };   // 已是月价，前端直接展示不再 ×730
  } catch (e) {
    console.warn(`[cloud/price/baidu] 计算器请求失败(${instanceType}): ${e.message}`);
    return { price: null, currency: 'CNY', unit: '小时', note: '暂无公开价格数据' };
  }
}

router.get('/price/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  const { region, instanceType } = req.query;
  if (!region || !instanceType) return res.status(400).json({ error: '缺少 region 或 instanceType 参数' });

  const cacheKey = `price:${platform}:${region}:${instanceType}`;
  const cached = _getPriceCached(cacheKey);
  if (cached) return res.json(cached);

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ?', [platform]);
  if (!cred) return res.status(400).json({ error: '请先配置云平台凭据' });

  try {
    let result;
    if      (platform === 'aws')    result = await awsFetchPrice(cred, region, instanceType);
    else if (platform === 'aliyun') result = await aliyunFetchPrice(cred, region, instanceType);
    else if (platform === 'baidu')  result = await baiduFetchPrice(cred, region, instanceType);
    else return res.status(400).json({ error: '不支持的云平台' });
    _setPriceCached(cacheKey, result);
    res.json(result);
  } catch (e) {
    // 查价失败不返回 500（避免前端整条报错）；返回空价 + 说明，并缓存，避免重复失败请求
    console.warn(`[cloud/price/${platform}] 查询失败: ${e.message}`);
    const currency = platform === 'aws' ? 'USD' : 'CNY';
    // 规格在该地域不可购买（阿里云限制/停售/无库存）——给出精准提示，并标记 unavailable
    const unavailable = /beyond the permitted range|not support|InvalidInstanceType|not available|Zone|SystemDisk\.Category is not valid/i.test(e.message || '');
    const fail = {
      price: null, currency, unit: '小时',
      note: unavailable ? '该地域不可购买' : '暂无公开价格数据',
      unavailable: unavailable || undefined
    };
    _setPriceCached(cacheKey, fail);
    res.json(fail);
  }
});

router.post('/credentials', authenticate, requireAdmin, async (req, res) => {
  const { platform, access_key, secret_key, region, account_name, ssh_key_name, cf_client_id, cf_client_secret } = req.body;
  if (!platform || !access_key || !secret_key) {
    return res.status(400).json({ error: '请填写完整凭据信息' });
  }

  // 自动填充显示名称和平台类型（从 constants 读取）
  const { PLATFORM_NAMES, PLATFORM_CATEGORY } = require('../utils/constants');
  const display_name = PLATFORM_NAMES[platform] || platform;
  const category = PLATFORM_CATEGORY[platform] || 'cloud';

  const existing = await db.get('SELECT id, cf_client_secret FROM platform_credentials WHERE platform = ?', [platform]);
  // CF 凭据：cf_client_id 为可选字符串；cf_client_secret 留空=保留原值（前端不回显敏感值）
  const cfId = (cf_client_id || '').trim();
  const cfSecret = (cf_client_secret && cf_client_secret.trim())
    ? cf_client_secret.trim()
    : (existing ? (existing.cf_client_secret || '') : '');
  if (existing) {
    await db.run(
      'UPDATE platform_credentials SET access_key=?, secret_key=?, region=?, account_name=?, display_name=?, category=?, ssh_key_name=?, cf_client_id=?, cf_client_secret=? WHERE platform=?',
      [access_key, secret_key, region || '', account_name || null, display_name, category, ssh_key_name || '', cfId, cfSecret, platform]
    );
  } else {
    await db.run(
      'INSERT INTO platform_credentials (id, platform, access_key, secret_key, region, account_name, display_name, category, ssh_key_name, cf_client_id, cf_client_secret) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [uuidv4(), platform, access_key, secret_key, region || '', account_name || null, display_name, category, ssh_key_name || '', cfId, cfSecret]
    );
  }

  res.json({ message: '凭据保存成功' });
});

router.get('/credentials', authenticate, async (req, res) => {
  const creds = await db.all(
    "SELECT platform, access_key, region, account_name, display_name, category, enabled, updated_at, ssh_key_name, cf_client_id, (cf_client_secret <> '') AS has_cf_secret, CONCAT(SUBSTR(access_key,1,4),'****',SUBSTR(access_key,-4)) AS access_key_masked FROM platform_credentials"
  );
  res.json({ credentials: creds });
});

router.delete('/credentials/:platform', authenticate, requireAdmin, async (req, res) => {
  await db.run('DELETE FROM platform_credentials WHERE platform = ?', [req.params.platform]);
  res.json({ message: '凭据已删除' });
});

// 测试凭据连接
// 注意：本接口会用库里已存的 cf_client_secret / account_name 回填空字段，
// 非 admin 可借此探测已保存的凭据，故同样要求 admin。
router.post('/credentials/test', authenticate, requireAdmin, async (req, res) => {
  const { platform, access_key, secret_key, region } = req.body;
  let { cf_client_id, cf_client_secret, account_name } = req.body;
  if (!platform || !access_key || !secret_key) {
    return res.status(400).json({ error: '请填写完整凭据信息' });
  }
  // CF secret / 登录用户名 留空时用已存库的（前端编辑不回显敏感值）
  if ((cf_client_id && !cf_client_secret) || !account_name) {
    const saved = await db.get('SELECT cf_client_secret, account_name FROM platform_credentials WHERE platform = ?', [platform]);
    if (cf_client_id && !cf_client_secret && saved?.cf_client_secret) cf_client_secret = saved.cf_client_secret;
    if (!account_name && saved?.account_name) account_name = saved.account_name;
  }
  // 组装 Cloudflare Access Service Token 头（有则带上，绕过 CF 登录拦截）
  const cfHeaders = (cf_client_id && cf_client_secret)
    ? { 'CF-Access-Client-Id': cf_client_id, 'CF-Access-Client-Secret': cf_client_secret }
    : {};

  try {
    if (platform === 'aws') {
      const { IAMClient, GetUserCommand } = require('@aws-sdk/client-iam');
      const client = new IAMClient({ region: region || 'us-east-1', credentials: { accessKeyId: access_key, secretAccessKey: secret_key } });
      await client.send(new GetUserCommand({}));
    } else if (platform === 'aliyun') {
      const Core = require('@alicloud/pop-core');
      const client = new Core({ accessKeyId: access_key, accessKeySecret: secret_key, endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01' });
      await client.request('GetUser', {}, { method: 'POST' }).catch(e => {
        if (e.code === 'EntityNotExist.User' || e.name === 'EntityNotExist.User') return;
        throw e;
      });
    } else if (platform === 'baidu') {
      await bceRequest({ access_key, secret_key, region: region || 'bj' }, 'GET', '/v1/user', {}, null);
    } else if (platform === 'jumpserver') {
      const crypto = require('crypto');
      const date = new Date().toUTCString();
      const method = 'get';
      const path = '/api/v1/users/profile/';
      const requestTarget = `${method} ${path}`;
      const signingString = `(request-target): ${requestTarget}\ndate: ${date}`;
      const signature = crypto.createHmac('sha256', secret_key).update(signingString).digest('base64');
      const authorization = `Signature keyId="${access_key}",algorithm="hmac-sha256",headers="(request-target) date",signature="${signature}"`;

      const resp = await fetch(`${region}${path}`, {
        headers: {
          'Date': date,
          'Authorization': authorization,
          'X-JMS-ORG': '00000000-0000-0000-0000-000000000002',
          'Accept': 'application/json'
        }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } else if (platform === 'bytebase') {
      const resp = await fetch(`${access_key}/v1/actuator/info`, {
        headers: { Authorization: `Bearer ${secret_key}` }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } else if (platform === 'kuboard') {
      // 访问密钥鉴权：Cookie KuboardUsername=<登录名> + KuboardAccessKey=<keyId.secret>。
      // 用 LIST KuboardAuthUser 真实验证：200=通过，403=用户名/密钥不对，303/CF跳转=拦截。
      const loginUser = account_name || 'admin';
      const base = access_key.replace(/\/$/, '');
      const resp = await fetch(`${base}/kuboard-api/cluster/GLOBAL/kind/KuboardAuthUser`, {
        headers: { 'Cookie': `KuboardUsername=${loginUser}; KuboardAccessKey=${secret_key}`, ...cfHeaders },
        redirect: 'manual',
      });
      const loc = resp.headers.get('location') || '';
      if (/cloudflareaccess\.com|\/cdn-cgi\/access\/login/i.test(loc)) {
        throw new Error('被 Cloudflare Access 拦截：请确认 CF-Access-Client-Id/Secret 正确，且该 Service Token 已加入 Access 应用的 Service Auth 策略');
      }
      if (resp.status === 303 || loc) {
        throw new Error('鉴权未通过：访问密钥格式应为「密钥ID.密钥」，且需填写密钥所属的登录用户名');
      }
      if (resp.status === 403) {
        throw new Error('鉴权失败：登录用户名与访问密钥不匹配（用户名须为生成该密钥的账号，非 admin）');
      }
      if (resp.status !== 200) throw new Error(`Kuboard 返回 HTTP ${resp.status}`);
    } else if (platform.startsWith('grafana-')) {
      const resp = await fetch(`${access_key}/api/org`, {
        headers: { Authorization: `Bearer ${secret_key}` }
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    } else {
      return res.status(400).json({ error: '不支持测试该平台' });
    }

    res.json({ success: true, message: '连接成功' });
  } catch (err) {
    res.json({ success: false, message: err.message || '连接失败' });
  }
});

// ══════════════════════════════════════════════════
// 自定义策略管理
// ══════════════════════════════════════════════════

// GET /api/cloud/policies/custom?platform=X  —— 列出云端自定义策略
router.get('/policies/custom', authenticate, async (req, res) => {
  const { platform } = req.query;
  if (!platform) return res.status(400).json({ error: '缺少 platform 参数' });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  try {
    let policies = [];
    if      (platform === 'aws')    policies = await listAwsCustomPolicies(cred);
    else if (platform === 'aliyun') policies = await listAliyunCustomPolicies(cred);
    else if (platform === 'baidu')  policies = await listBaiduCustomPolicies(cred);
    else return res.status(400).json({ error: '仅支持 aws / aliyun / baidu' });
    res.json({ policies });
  } catch (err) {
    console.error(`[cloud/policies/custom] ${platform} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/cloud/policies/custom  body: { platform, name, description, document }
router.post('/policies/custom', authenticate, requireAdmin, async (req, res) => {
  const { platform, name, description, document } = req.body || {};
  if (!platform || !name || !document) return res.status(400).json({ error: '缺少必填字段' });

  // 校验 JSON
  try { JSON.parse(document); } catch { return res.status(400).json({ error: '策略文档不是合法 JSON' }); }

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  try {
    let result;
    if      (platform === 'aws')    result = await createAwsCustomPolicy(cred, name, description, document);
    else if (platform === 'aliyun') result = await createAliyunCustomPolicy(cred, name, description, document);
    else if (platform === 'baidu')  result = await createBaiduCustomPolicy(cred, name, description, document);
    else return res.status(400).json({ error: '仅支持 aws / aliyun / baidu' });
    res.json({ message: '策略创建成功', policy: result });
  } catch (err) {
    console.error(`[cloud/policies/custom] ${platform} create error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── AWS IAM 自定义策略 ──
async function listAwsCustomPolicies(cred) {
  const { IAMClient, ListPoliciesCommand } = require('@aws-sdk/client-iam');
  const client = new IAMClient({
    region: 'us-east-1',
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });
  const policies = [];
  let marker;
  do {
    const r = await client.send(new ListPoliciesCommand({ Scope: 'Local', Marker: marker, MaxItems: 100 }));
    for (const p of r.Policies || []) {
      policies.push({ id: p.Arn, name: p.PolicyName, desc: p.Description || '' });
    }
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  return policies;
}

async function createAwsCustomPolicy(cred, name, description, document) {
  const { IAMClient, CreatePolicyCommand } = require('@aws-sdk/client-iam');
  const client = new IAMClient({
    region: 'us-east-1',
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });
  const r = await client.send(new CreatePolicyCommand({
    PolicyName: name, Description: description || '', PolicyDocument: document
  }));
  return { id: r.Policy?.Arn, name: r.Policy?.PolicyName };
}

// ── 阿里云 RAM 自定义策略 ──
async function listAliyunCustomPolicies(cred) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({
    accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
    endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01'
  });
  const r = await client.request('ListPolicies', { PolicyType: 'Custom', MaxItems: 100 }, { method: 'POST' });
  return (r.Policies?.Policy || []).map(p => ({
    id: p.PolicyName, name: p.PolicyName, desc: p.Description || ''
  }));
}

async function createAliyunCustomPolicy(cred, name, description, document) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({
    accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
    endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01'
  });
  const r = await client.request('CreatePolicy', {
    PolicyName: name, Description: description || '', PolicyDocument: document
  }, { method: 'POST' });
  return { id: r.Policy?.PolicyName, name: r.Policy?.PolicyName };
}

// ── 百度云 IAM 自定义策略 ──
async function listBaiduCustomPolicies(cred) {
  const r = await bceRequest(cred, 'GET', '/v1/policy', { type: 'Custom' });
  return (r.policies || r.items || []).map(p => ({
    id: p.id || p.name, name: p.name, desc: p.description || ''
  }));
}

async function createBaiduCustomPolicy(cred, name, description, document) {
  const r = await bceRequest(cred, 'POST', '/v1/policy', {}, {
    name, description: description || '', document
  });
  return { id: r.policy?.id || name, name };
}

module.exports = router;
