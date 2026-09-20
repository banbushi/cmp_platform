const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../utils/database');
const { authenticate } = require('../middleware/auth');
const bceRequest = require('../utils/bce');
const { AWS_REGIONS, ALIYUN_REGIONS, BAIDU_REGIONS } = require('../utils/regions');

const router = express.Router();

const BCC_HOST = 'bcc.bj.baidubce.com';

const _sleep = ms => new Promise(r => setTimeout(r, ms));

// 判断某地域拉取失败是否为「地域根本不存在」（DNS 解析不到 endpoint）。
// 这类地域必然无实例，可安全视为空地域，不应因此判定同步不完整而跳过对账删除。
function _isNonexistentRegionErr(err) {
  const msg = (err && (err.message || err.code || '')) + '';
  return /ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(msg);
}

// ── 列表 & 创建 ──

// 获取云主机列表
router.get('/', authenticate, async (req, res) => {
  const { platform, status, keyword } = req.query;

  let sql = 'SELECT * FROM cloud_instances WHERE 1=1';
  const params = [];

  if (platform && platform !== 'all') { sql += ' AND platform = ?'; params.push(platform); }
  if (status)  { sql += ' AND status = ?'; params.push(status); }
  if (keyword) {
    sql += ' AND (instance_name LIKE ? OR instance_id LIKE ? OR public_ip LIKE ? OR private_ip LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  sql += ' ORDER BY created_at DESC';

  const instances = await db.all(sql, params);
  res.json({ instances: instances.map(i => ({ ...i, config: JSON.parse(i.config || '{}') })) });
});

// ── 查询可用地域（必须在 /:id 之前注册）──
router.get('/regions', authenticate, async (req, res) => {
  const { platform } = req.query;
  if (!platform) return res.status(400).json({ error: '缺少 platform' });
  const regions = {
    aws: [
      { id: 'us-east-1', name: 'US East (N. Virginia)' },
      { id: 'us-west-2', name: 'US West (Oregon)' },
      { id: 'ap-northeast-1', name: 'Asia Pacific (Tokyo)' },
      { id: 'ap-southeast-1', name: 'Asia Pacific (Singapore)' },
      { id: 'eu-west-1', name: 'Europe (Ireland)' }
    ],
    aliyun: [
      { id: 'cn-hangzhou', name: '华东1（杭州）' },
      { id: 'cn-beijing', name: '华北2（北京）' },
      { id: 'cn-shanghai', name: '华东2（上海）' },
      { id: 'cn-shenzhen', name: '华南1（深圳）' }
    ],
    baidu: [
      { id: 'bj', name: '北京' },
      { id: 'gz', name: '广州' },
      { id: 'su', name: '苏州' },
      { id: 'bd', name: '保定' }
    ]
  };
  res.json({ regions: regions[platform] || [] });
});

// ── 查询可用实例规格（必须在 /:id 之前）──
router.get('/instance-types', authenticate, async (req, res) => {
  const { platform, region } = req.query;
  if (!platform) return res.status(400).json({ error: '缺少 platform' });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  try {
    let types = [];
    if (platform === 'aws') {
      const { EC2Client, DescribeInstanceTypesCommand } = require('@aws-sdk/client-ec2');
      const client = new EC2Client({
        region: region || cred.region || 'us-east-1',
        credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
      });
      // AWS 实例类型有 800+ 种，必须翻页拉全，否则 t 系列（免费层/2c2g）等会被截断
      let nextToken;
      do {
        const resp = await client.send(new DescribeInstanceTypesCommand({ MaxResults: 100, NextToken: nextToken }));
        for (const t of (resp.InstanceTypes || [])) {
          types.push({
            type: t.InstanceType,
            vcpu: t.VCpuInfo?.DefaultVCpus || 0,
            memory: t.MemoryInfo?.SizeInMiB || 0,
            freeTier: !!t.FreeTierEligible,
            currentGen: t.CurrentGeneration !== false,
            arch: (t.ProcessorInfo?.SupportedArchitectures || []).join('/'),
            clockSpeed: t.ProcessorInfo?.SustainedClockSpeedInGhz || null
          });
        }
        nextToken = resp.NextToken;
      } while (nextToken);
    } else if (platform === 'aliyun') {
      const Core = require('@alicloud/pop-core');
      const client = new Core({
        accessKeyId: cred.access_key,
        accessKeySecret: cred.secret_key,
        endpoint: `https://ecs.${region || cred.region || 'cn-hangzhou'}.aliyuncs.com`,
        apiVersion: '2014-05-26'
      });
      const resp = await client.request('DescribeInstanceTypes', {}, { method: 'POST' });
      types = (resp.InstanceTypes?.InstanceType || []).map(t => ({
        type: t.InstanceTypeId,
        vcpu: t.CpuCoreCount || 0,
        memory: t.MemorySize * 1024 || 0
      }));
    } else if (platform === 'baidu') {
      const bccHost = `bcc.${region || cred.region || 'bj'}.baidubce.com`;
      const resp = await bceRequest(cred, 'GET', '/v2/instance/flavorSpec', {}, null, bccHost);
      // flavorSpec 返回结构为 zoneResources[].bccResources.flavorGroups[].flavors[]，
      // 需逐层展开并按 spec 去重（不同可用区会重复出现相同规格）
      const seen = new Set();
      for (const zone of (resp.zoneResources || [])) {
        for (const grp of (zone.bccResources?.flavorGroups || [])) {
          for (const f of (grp.flavors || [])) {
            const spec = f.spec || f.specId;
            if (!spec || seen.has(spec)) continue;
            seen.add(spec);
            types.push({
              type: spec,
              vcpu: f.cpuCount || 0,
              memory: (f.memoryCapacityInGB || 0) * 1024
            });
          }
        }
      }
    }
    res.json({ types });
  } catch (err) {
    res.status(500).json({ error: '查询失败: ' + err.message });
  }
});

// ── 查询可用镜像（必须在 /:id 之前）──
router.get('/images', authenticate, async (req, res) => {
  const { platform, region } = req.query;
  if (!platform) return res.status(400).json({ error: '缺少 platform' });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  try {
    let images = [];
    if (platform === 'aws') {
      const { EC2Client, DescribeImagesCommand } = require('@aws-sdk/client-ec2');
      const client = new EC2Client({
        region: region || cred.region || 'us-east-1',
        credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
      });
      // 主流发行版官方 owner（Ubuntu 属于 Canonical，不在 amazon 名下）
      const OWNERS = [
        'amazon',           // Amazon Linux / Windows
        '099720109477',     // Canonical (Ubuntu)
        '309956199498',     // Red Hat (RHEL)
        '136693071363',     // Debian
        '013907871322'      // SUSE
      ];
      // 名称模式精选：只取常见发行版的近期正式镜像，避免拉回上万条历史镜像
      const NAME_PATTERNS = [
        'ubuntu/images/hvm-ssd*/ubuntu-*-24.04-*', 'ubuntu/images/hvm-ssd*/ubuntu-*-22.04-*', 'ubuntu/images/hvm-ssd*/ubuntu-*-20.04-*',
        'al2023-ami-2023*-kernel-*', 'amzn2-ami-hvm-*-gp2', 'amzn2-ami-kernel-*-hvm-*-gp2',
        'RHEL-9*_HVM-*', 'RHEL-8*_HVM-*',
        'debian-12-*', 'debian-11-*',
        'suse-sles-15-*',
        'Windows_Server-2022-English-Full-Base-*', 'Windows_Server-2019-English-Full-Base-*'
      ];
      const collected = [];
      let nextToken;
      do {
        const resp = await client.send(new DescribeImagesCommand({
          Owners: OWNERS,
          Filters: [
            { Name: 'state', Values: ['available'] },
            { Name: 'architecture', Values: ['x86_64', 'arm64'] },
            { Name: 'root-device-type', Values: ['ebs'] },
            { Name: 'virtualization-type', Values: ['hvm'] },
            { Name: 'is-public', Values: ['true'] },
            { Name: 'name', Values: NAME_PATTERNS }
          ],
          MaxResults: 1000,
          NextToken: nextToken
        }));
        collected.push(...(resp.Images || []));
        nextToken = resp.NextToken;
      } while (nextToken);
      // 按创建时间倒序，取最新的一批，避免下拉过长
      collected.sort((a, b) => (b.CreationDate || '').localeCompare(a.CreationDate || ''));
      images = collected.slice(0, 300).map(i => ({
        id: i.ImageId,
        name: i.Name || i.ImageId,
        arch: i.Architecture || '',                 // x86_64 / arm64，供前端架构校验
        description: `${i.Architecture || ''}${i.Description ? ' · ' + i.Description : ''}`.trim()
      }));
    } else if (platform === 'aliyun') {
      const Core = require('@alicloud/pop-core');
      const client = new Core({
        accessKeyId: cred.access_key,
        accessKeySecret: cred.secret_key,
        endpoint: `https://ecs.${region || cred.region || 'cn-hangzhou'}.aliyuncs.com`,
        apiVersion: '2014-05-26'
      });
      const regionId = region || cred.region || 'cn-hangzhou';
      let pageNumber = 1;
      while (true) {
        const resp = await client.request('DescribeImages', { RegionId: regionId, ImageOwnerAlias: 'system', PageSize: 100, PageNumber: pageNumber }, { method: 'POST' });
        const list = resp.Images?.Image || [];
        for (const i of list) {
          images.push({
            id: i.ImageId,
            name: i.ImageName || i.OSName || i.ImageId,
            description: i.Description || i.OSType || ''
          });
        }
        if (list.length < 100) break;
        pageNumber++;
      }
    } else if (platform === 'baidu') {
      const bccHost = `bcc.${region || cred.region || 'bj'}.baidubce.com`;
      // 百度镜像分页用 marker + isTruncated
      let marker;
      do {
        const params = { imageType: 'System', maxKeys: 100 };
        if (marker) params.marker = marker;
        const resp = await bceRequest(cred, 'GET', '/v2/image', params, null, bccHost);
        for (const i of (resp.images || [])) {
          images.push({
            id: i.id,
            name: i.name || i.id,
            description: i.desc || i.osName || ''
          });
        }
        marker = resp.isTruncated ? resp.nextMarker : null;
      } while (marker);
    }
    res.json({ images });
  } catch (err) {
    res.status(500).json({ error: '查询失败: ' + err.message });
  }
});

// ── 查询 VPC 列表（必须在 /:id 之前）──
router.get('/vpcs', authenticate, async (req, res) => {
  const { platform, region } = req.query;
  if (!platform) return res.status(400).json({ error: '缺少 platform' });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  try {
    let vpcs = [];
    if (platform === 'aws') {
      const { EC2Client, DescribeVpcsCommand } = require('@aws-sdk/client-ec2');
      const client = new EC2Client({
        region: region || cred.region || 'us-east-1',
        credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
      });
      const resp = await client.send(new DescribeVpcsCommand({}));
      vpcs = (resp.Vpcs || []).map(v => {
        const nameTag = (v.Tags || []).find(t => t.Key === 'Name');
        return {
          id: v.VpcId,
          name: nameTag ? `${nameTag.Value} (${v.VpcId})` : v.VpcId,
          cidr: v.CidrBlock || '',
          isDefault: v.IsDefault || false
        };
      });
    } else if (platform === 'aliyun') {
      const Core = require('@alicloud/pop-core');
      const client = new Core({
        accessKeyId: cred.access_key,
        accessKeySecret: cred.secret_key,
        endpoint: `https://vpc.${region || cred.region || 'cn-hangzhou'}.aliyuncs.com`,
        apiVersion: '2016-04-28'
      });
      const resp = await client.request('DescribeVpcs', { RegionId: region || cred.region || 'cn-hangzhou', PageSize: 50 }, { method: 'POST' });
      vpcs = (resp.Vpcs?.Vpc || []).map(v => ({
        id: v.VpcId,
        name: `${v.VpcName || v.VpcId} (${v.VpcId})`,
        cidr: v.CidrBlock || '',
        isDefault: v.IsDefault || false
      }));
    } else if (platform === 'baidu') {
      const bccHost = `bcc.${region || cred.region || 'bj'}.baidubce.com`;
      const resp = await bceRequest(cred, 'GET', '/v1/vpc', {}, null, bccHost);
      vpcs = (resp.vpcs || []).map(v => ({
        id: v.vpcId,
        name: `${v.name || v.vpcId} (${v.vpcId})`,
        cidr: v.cidr || '',
        isDefault: v.isDefault || false
      }));
    }
    res.json({ vpcs });
  } catch (err) {
    res.status(500).json({ error: '查询失败: ' + err.message });
  }
});

// ── 查询安全组列表（必须在 /:id 之前）──
router.get('/security-groups', authenticate, async (req, res) => {
  const { platform, region, vpcId } = req.query;
  if (!platform) return res.status(400).json({ error: '缺少 platform' });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  try {
    let groups = [];
    if (platform === 'aws') {
      const { EC2Client, DescribeSecurityGroupsCommand } = require('@aws-sdk/client-ec2');
      const client = new EC2Client({
        region: region || cred.region || 'us-east-1',
        credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
      });
      const params = {};
      if (vpcId) {
        params.Filters = [{ Name: 'vpc-id', Values: [vpcId] }];
      }
      const resp = await client.send(new DescribeSecurityGroupsCommand(params));
      groups = (resp.SecurityGroups || []).map(g => ({
        id: g.GroupId,
        name: `${g.GroupName} (${g.GroupId})`,
        description: g.Description || '',
        vpcId: g.VpcId || ''
      }));
    } else if (platform === 'aliyun') {
      const Core = require('@alicloud/pop-core');
      const client = new Core({
        accessKeyId: cred.access_key,
        accessKeySecret: cred.secret_key,
        endpoint: `https://ecs.${region || cred.region || 'cn-hangzhou'}.aliyuncs.com`,
        apiVersion: '2014-05-26'
      });
      const params = { RegionId: region || cred.region || 'cn-hangzhou', PageSize: 50 };
      if (vpcId) params.VpcId = vpcId;
      const resp = await client.request('DescribeSecurityGroups', params, { method: 'POST' });
      groups = (resp.SecurityGroups?.SecurityGroup || []).map(g => ({
        id: g.SecurityGroupId,
        name: `${g.SecurityGroupName || g.SecurityGroupId} (${g.SecurityGroupId})`,
        description: g.Description || '',
        vpcId: g.VpcId || ''
      }));
    } else if (platform === 'baidu') {
      const bccHost = `bcc.${region || cred.region || 'bj'}.baidubce.com`;
      const query = vpcId ? { vpcId } : {};
      const resp = await bceRequest(cred, 'GET', '/v2/securityGroup', query, null, bccHost);
      groups = (resp.securityGroups || []).map(g => ({
        id: g.id,
        name: `${g.name || g.id} (${g.id})`,
        description: g.desc || '',
        vpcId: g.vpcId || ''
      }));
    }
    res.json({ groups });
  } catch (err) {
    res.status(500).json({ error: '查询失败: ' + err.message });
  }
});

// ── 查询子网列表（必须在 /:id 之前）──
router.get('/subnets', authenticate, async (req, res) => {
  const { platform, region, vpcId } = req.query;
  if (!platform) return res.status(400).json({ error: '缺少 platform' });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  try {
    let subnets = [];
    if (platform === 'aws') {
      const { EC2Client, DescribeSubnetsCommand } = require('@aws-sdk/client-ec2');
      const client = new EC2Client({
        region: region || cred.region || 'us-east-1',
        credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
      });
      const params = {};
      if (vpcId) {
        params.Filters = [{ Name: 'vpc-id', Values: [vpcId] }];
      }
      const resp = await client.send(new DescribeSubnetsCommand(params));
      subnets = (resp.Subnets || []).map(s => {
        const nameTag = (s.Tags || []).find(t => t.Key === 'Name');
        return {
          id: s.SubnetId,
          name: nameTag ? `${nameTag.Value} (${s.SubnetId})` : `${s.SubnetId} [${s.AvailabilityZone}]`,
          zone: s.AvailabilityZone || '',
          cidr: s.CidrBlock || '',
          vpcId: s.VpcId || ''
        };
      });
    } else if (platform === 'aliyun') {
      const Core = require('@alicloud/pop-core');
      const client = new Core({
        accessKeyId: cred.access_key,
        accessKeySecret: cred.secret_key,
        endpoint: `https://vpc.${region || cred.region || 'cn-hangzhou'}.aliyuncs.com`,
        apiVersion: '2016-04-28'
      });
      const params = { RegionId: region || cred.region || 'cn-hangzhou', PageSize: 50 };
      if (vpcId) params.VpcId = vpcId;
      const resp = await client.request('DescribeVSwitches', params, { method: 'POST' });
      subnets = (resp.VSwitches?.VSwitch || []).map(s => ({
        id: s.VSwitchId,
        name: `${s.VSwitchName || s.VSwitchId} (${s.VSwitchId}) [${s.ZoneId}]`,
        zone: s.ZoneId || '',
        cidr: s.CidrBlock || '',
        vpcId: s.VpcId || ''
      }));
    } else if (platform === 'baidu') {
      const bccHost = `bcc.${region || cred.region || 'bj'}.baidubce.com`;
      const query = vpcId ? { vpcId } : {};
      const resp = await bceRequest(cred, 'GET', '/v1/subnet', query, null, bccHost);
      subnets = (resp.subnets || []).map(s => ({
        id: s.subnetId,
        name: `${s.name || s.subnetId} (${s.subnetId}) [${s.zoneName || ''}]`,
        zone: s.zoneName || '',
        cidr: s.cidr || '',
        vpcId: s.vpcId || ''
      }));
    }
    res.json({ subnets });
  } catch (err) {
    res.status(500).json({ error: '查询失败: ' + err.message });
  }
});

// 获取单台云主机详情
router.get('/:id', authenticate, async (req, res) => {
  const inst = await db.get('SELECT * FROM cloud_instances WHERE id = ?', [req.params.id]);
  if (!inst) return res.status(404).json({ error: '云主机不存在' });
  res.json({ instance: { ...inst, config: JSON.parse(inst.config || '{}') } });
});

// 同步指定平台云主机到本地数据库（注册在 /:id 之前）
router.post('/sync/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  const platforms = platform === 'all' ? ['aws', 'aliyun', 'baidu'] : [platform];
  const results = [];

  for (const p of platforms) {
    const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [p]);
    if (!cred) {
      results.push({ platform: p, success: false, message: '未配置主账号凭据', count: 0 });
      continue;
    }

    let remoteList = [];
    let complete = true;
    try {
      let fetched;
      if (p === 'aws')         fetched = await fetchAwsInstances(cred);
      else if (p === 'aliyun') fetched = await fetchAliyunInstances(cred);
      else if (p === 'baidu')  fetched = await fetchBaiduInstances(cred);
      remoteList = fetched.instances;
      complete = fetched.complete;
    } catch (err) {
      results.push({ platform: p, success: false, message: `拉取云主机失败: ${err.message}`, count: 0 });
      continue;
    }

    let written = 0;
    const remoteIds = new Set();
    for (const inst of remoteList) {
      remoteIds.add(inst.instanceId);
      try {
        await db.run(`
          INSERT INTO cloud_instances (id, platform, instance_id, instance_name, status, region, zone, instance_type, image_id, public_ip, private_ip, config)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            instance_name = VALUES(instance_name),
            status        = VALUES(status),
            region        = VALUES(region),
            zone          = VALUES(zone),
            instance_type = VALUES(instance_type),
            image_id      = VALUES(image_id),
            public_ip     = VALUES(public_ip),
            private_ip    = VALUES(private_ip),
            config        = VALUES(config)
        `, [uuidv4(), p, inst.instanceId, inst.instanceName, inst.status, inst.region || '', inst.zone || '', inst.instanceType || '', inst.imageId || '', inst.publicIp || '', inst.privateIp || '', JSON.stringify(inst.config || {})]);
        written++;
      } catch (err) {
        console.error(`[instances] ${p} 写入 ${inst.instanceId} 失败:`, err.message);
      }
    }

    // 对账删除：清理云端已不存在的实例。仅在拉取完整成功时执行，避免某地域临时失败误删。
    let removed = 0;
    if (complete) {
      const localRows = await db.all('SELECT instance_id FROM cloud_instances WHERE platform = ?', [p]);
      const stale = localRows.filter(row => !remoteIds.has(row.instance_id)).map(row => row.instance_id);
      for (const staleId of stale) {
        await db.run('DELETE FROM cloud_instances WHERE platform = ? AND instance_id = ?', [p, staleId]);
        removed++;
      }
    } else {
      console.warn(`[instances] ${p} 拉取不完整（部分地域失败），跳过对账删除以防误删`);
    }

    results.push({ platform: p, success: true, message: complete ? '同步成功' : '同步成功（部分地域失败，未清理）', count: written, removed });
  }

  res.json({ results });
});

// 创建云主机
router.post('/', authenticate, async (req, res) => {
  const { platform, instance_name, instance_type, image_id, region, zone, count, user_id, extra,
          public_ip, system_disk_size, data_disk_size } = req.body;
  if (!platform || !instance_type || !image_id) {
    return res.status(400).json({ error: '请填写 platform、instance_type、image_id' });
  }

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  // 磁盘/公网 IP 选项（三云 create 函数均已支持）
  const diskOpts = {
    public_ip: !!public_ip,
    system_disk_size: parseInt(system_disk_size) || 0,
    data_disk_size: parseInt(data_disk_size) || 0,
  };

  let result;
  try {
    if (platform === 'aws')         result = await createAwsInstance(cred, { instance_name, instance_type, image_id, region, count: count || 1, ...diskOpts, extra: extra || {} });
    else if (platform === 'aliyun') result = await createAliyunInstance(cred, { instance_name, instance_type, image_id, region, zone, ...diskOpts, extra: extra || {} });
    else if (platform === 'baidu')  result = await createBaiduInstance(cred, { instance_name, instance_type, image_id, zone, ...diskOpts, extra: extra || {} });
    else return res.status(400).json({ error: '不支持的云平台' });
  } catch (err) {
    return res.status(500).json({ error: '云主机创建失败: ' + err.message });
  }

  if (!result.success) return res.status(500).json({ error: result.message });

  // 写入数据库
  const saved = [];
  for (const inst of result.instances) {
    const localId = uuidv4();
    await db.run(
      'INSERT INTO cloud_instances (id, user_id, platform, instance_id, instance_name, status, region, zone, instance_type, image_id, public_ip, private_ip, config) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [localId, user_id || null, platform, inst.instanceId, inst.instanceName || instance_name || '', inst.status || 'pending', inst.region || region || '', inst.zone || zone || '', instance_type, image_id, inst.publicIp || '', inst.privateIp || '', JSON.stringify(inst.config || {})]
    );
    saved.push({ id: localId, ...inst });
  }

  res.status(201).json({ message: '云主机创建成功', instances: saved });
});

// ── 单机操作 ──

// 启动云主机
router.post('/:id/start', authenticate, async (req, res) => {
  const inst = await db.get('SELECT * FROM cloud_instances WHERE id = ?', [req.params.id]);
  if (!inst) return res.status(404).json({ error: '云主机不存在' });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [inst.platform]);
  if (!cred) return res.status(400).json({ error: '未配置主账号凭据' });

  try {
    if (inst.platform === 'aws')         await startAwsInstance(cred, inst.instance_id, inst.region);
    else if (inst.platform === 'aliyun') await startAliyunInstance(cred, inst.instance_id, inst.region);
    else if (inst.platform === 'baidu')  await startBaiduInstance(cred, inst.instance_id);
    else return res.status(400).json({ error: '不支持的云平台' });

    await db.run("UPDATE cloud_instances SET status = 'running' WHERE id = ?", [inst.id]);
    res.json({ message: '云主机已启动' });
  } catch (err) {
    res.status(500).json({ error: '启动失败: ' + err.message });
  }
});

// 停止云主机
router.post('/:id/stop', authenticate, async (req, res) => {
  const inst = await db.get('SELECT * FROM cloud_instances WHERE id = ?', [req.params.id]);
  if (!inst) return res.status(404).json({ error: '云主机不存在' });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [inst.platform]);
  if (!cred) return res.status(400).json({ error: '未配置主账号凭据' });

  try {
    if (inst.platform === 'aws')         await stopAwsInstance(cred, inst.instance_id, inst.region);
    else if (inst.platform === 'aliyun') await stopAliyunInstance(cred, inst.instance_id, inst.region);
    else if (inst.platform === 'baidu')  await stopBaiduInstance(cred, inst.instance_id);
    else return res.status(400).json({ error: '不支持的云平台' });

    await db.run("UPDATE cloud_instances SET status = 'stopped' WHERE id = ?", [inst.id]);
    res.json({ message: '云主机已停止' });
  } catch (err) {
    res.status(500).json({ error: '停止失败: ' + err.message });
  }
});

// 删除/终止云主机
router.delete('/:id', authenticate, async (req, res) => {
  const inst = await db.get('SELECT * FROM cloud_instances WHERE id = ?', [req.params.id]);
  if (!inst) return res.status(404).json({ error: '云主机不存在' });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [inst.platform]);
  if (!cred) return res.status(400).json({ error: '未配置主账号凭据' });

  try {
    if (inst.platform === 'aws')         await terminateAwsInstance(cred, inst.instance_id, inst.region);
    else if (inst.platform === 'aliyun') await terminateAliyunInstance(cred, inst.instance_id, inst.region);
    else if (inst.platform === 'baidu')  await terminateBaiduInstance(cred, inst.instance_id);
    else return res.status(400).json({ error: '不支持的云平台' });

    await db.run('DELETE FROM cloud_instances WHERE id = ?', [inst.id]);
    res.json({ message: '云主机已终止并删除' });
  } catch (err) {
    res.status(500).json({ error: '删除失败: ' + err.message });
  }
});

// ── AWS EC2 ──

async function createAwsInstance(cred, opts) {
  const { EC2Client, RunInstancesCommand, DescribeInstancesCommand, waitUntilInstanceRunning } = require('@aws-sdk/client-ec2');
  const client = new EC2Client({
    region: opts.region || cred.region || 'us-east-1',
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });

  const params = {
    ImageId: opts.image_id,
    InstanceType: opts.instance_type,
    MinCount: opts.count || 1,
    MaxCount: opts.count || 1,
    ...(opts.instance_name ? { TagSpecifications: [{ ResourceType: 'instance', Tags: [{ Key: 'Name', Value: opts.instance_name }] }] } : {}),
    ...opts.extra
  };

  // 磁盘：系统盘（覆盖镜像根设备大小）+ 可选数据盘，均用 gp3 高性能 SSD
  const sysSize = parseInt(opts.system_disk_size) || 0;
  const dataSize = parseInt(opts.data_disk_size) || 0;
  if (sysSize > 0 || dataSize > 0) {
    const { DescribeImagesCommand } = require('@aws-sdk/client-ec2');
    let rootDevice = '/dev/xvda';
    try {
      const imgResp = await client.send(new DescribeImagesCommand({ ImageIds: [opts.image_id] }));
      rootDevice = imgResp.Images?.[0]?.RootDeviceName || rootDevice;
    } catch (e) {
      console.warn('[createAwsInstance] 查询镜像根设备失败，使用默认 /dev/xvda:', e.message);
    }
    const mappings = [];
    if (sysSize > 0) {
      mappings.push({ DeviceName: rootDevice, Ebs: { VolumeSize: sysSize, VolumeType: 'gp3', DeleteOnTermination: true } });
    }
    if (dataSize > 0) {
      mappings.push({ DeviceName: '/dev/sdb', Ebs: { VolumeSize: dataSize, VolumeType: 'gp3', DeleteOnTermination: true } });
    }
    params.BlockDeviceMappings = mappings;
  }

  // 分配公网 IP：AWS 需将子网/安全组移入网卡定义，并开启 AssociatePublicIpAddress
  if (opts.public_ip) {
    params.NetworkInterfaces = [{
      DeviceIndex: 0,
      AssociatePublicIpAddress: true,
      DeleteOnTermination: true,
      ...(params.SubnetId ? { SubnetId: params.SubnetId } : {}),
      ...(params.SecurityGroupIds ? { Groups: params.SecurityGroupIds } : {})
    }];
    delete params.SubnetId;
    delete params.SecurityGroupIds;
  }

  const res = await client.send(new RunInstancesCommand(params));
  const instanceIds = (res.Instances || []).map(i => i.InstanceId);

  // 等待实例启动完成（最多等待5分钟）
  try {
    await waitUntilInstanceRunning({ client, maxWaitTime: 300 }, { InstanceIds: instanceIds });
  } catch (e) {
    console.warn('[createAwsInstance] 等待实例启动超时，使用初始状态:', e.message);
  }

  // 查询最新状态和 IP
  const descResp = await client.send(new DescribeInstancesCommand({ InstanceIds: instanceIds }));
  const instances = [];
  for (const reservation of (descResp.Reservations || [])) {
    for (const i of (reservation.Instances || [])) {
      instances.push({
        instanceId: i.InstanceId,
        instanceName: opts.instance_name || i.InstanceId,
        status: i.State?.Name || 'running',
        region: opts.region || cred.region || 'us-east-1',
        zone: i.Placement?.AvailabilityZone || '',
        publicIp: i.PublicIpAddress || '',
        privateIp: i.PrivateIpAddress || '',
        config: {
          vpcId: i.VpcId,
          subnetId: i.SubnetId,
          keyName: i.KeyName,
          securityGroups: (i.SecurityGroups || []).map(sg => ({ id: sg.GroupId, name: sg.GroupName }))
        }
      });
    }
  }

  return { success: true, instances };
}

async function startAwsInstance(cred, instanceId, region) {
  const { EC2Client, StartInstancesCommand } = require('@aws-sdk/client-ec2');
  const client = new EC2Client({
    region: region || cred.region || 'us-east-1',
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });
  await client.send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
}

async function stopAwsInstance(cred, instanceId, region) {
  const { EC2Client, StopInstancesCommand } = require('@aws-sdk/client-ec2');
  const client = new EC2Client({
    region: region || cred.region || 'us-east-1',
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });
  await client.send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
}

async function terminateAwsInstance(cred, instanceId, region) {
  const { EC2Client, TerminateInstancesCommand } = require('@aws-sdk/client-ec2');
  const client = new EC2Client({
    region: region || cred.region || 'us-east-1',
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });
  await client.send(new TerminateInstancesCommand({ InstanceIds: [instanceId] }));
}

async function fetchAwsInstances(cred) {
  const { EC2Client, DescribeInstancesCommand } = require('@aws-sdk/client-ec2');
  const all = [];
  let complete = true;
  const regionResults = await Promise.allSettled(AWS_REGIONS.map(async region => {
    const client = new EC2Client({ region, credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
    const instances = [];
    let nextToken;
    do {
      const res = await client.send(new DescribeInstancesCommand({ MaxResults: 100, NextToken: nextToken }));
      for (const r of res.Reservations || []) {
        for (const i of r.Instances || []) {
          const state = i.State?.Name || 'unknown';
          // 跳过已终止/正在终止的实例：它们云端很快消失，不应写回本地
          if (state === 'terminated' || state === 'shutting-down') continue;
          const nameTag = (i.Tags || []).find(t => t.Key === 'Name');
          instances.push({
            instanceId: i.InstanceId,
            instanceName: nameTag?.Value || i.InstanceId,
            status: state,
            region,
            zone: i.Placement?.AvailabilityZone || '',
            instanceType: i.InstanceType || '',
            imageId: i.ImageId || '',
            publicIp: i.PublicIpAddress || '',
            privateIp: i.PrivateIpAddress || '',
            config: {}
          });
        }
      }
      nextToken = res.NextToken;
    } while (nextToken);
    return instances;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else if (_isNonexistentRegionErr(r.reason)) console.warn(`[instances/aws] region 不存在，跳过: ${r.reason?.message}`);
    else { complete = false; console.warn(`[instances/aws] region failed: ${r.reason?.message}`); }
  }
  return { instances: all, complete };
}

// ── 阿里云 ECS ──

function aliyunEcsClient(cred, region) {
  const Core = require('@alicloud/pop-core');
  return new Core({
    accessKeyId: cred.access_key,
    accessKeySecret: cred.secret_key,
    endpoint: `https://ecs.${region || 'cn-hangzhou'}.aliyuncs.com`,
    apiVersion: '2014-05-26'
  });
}

async function createAliyunInstance(cred, opts) {
  const region = opts.region || 'cn-hangzhou';
  const client = aliyunEcsClient(cred, region);

  const params = {
    RegionId: region,
    ImageId: opts.image_id,
    InstanceType: opts.instance_type,
    InstanceName: opts.instance_name || '',
    ...(opts.zone ? { ZoneId: opts.zone } : {}),
    // 分配公网 IP：按流量计费，出网带宽上限 5Mbps；不需要时置 0
    ...(opts.public_ip
      ? { InternetChargeType: 'PayByTraffic', InternetMaxBandwidthOut: 5 }
      : { InternetMaxBandwidthOut: 0 }),
    ...opts.extra
  };

  // 磁盘：系统盘 + 可选数据盘，均用 cloud_essd 高性能 SSD
  const sysSizeA = parseInt(opts.system_disk_size) || 0;
  const dataSizeA = parseInt(opts.data_disk_size) || 0;
  if (sysSizeA > 0) {
    params['SystemDisk.Size'] = sysSizeA;
    params['SystemDisk.Category'] = 'cloud_essd';
  }
  if (dataSizeA > 0) {
    params['DataDisk.1.Size'] = dataSizeA;
    params['DataDisk.1.Category'] = 'cloud_essd';
    params['DataDisk.1.DeleteWithInstance'] = true;
  }

  const res = await client.request('RunInstances', params, { method: 'POST' });
  const ids = res.InstanceIdSets?.InstanceIdSet || [];

  // 轮询等待实例分配 IP（公网 IP 需实例进入 Running 后才可见），最多约 90 秒
  const ipMap = {};
  if (ids.length) {
    for (let attempt = 0; attempt < 18; attempt++) {
      await _sleep(5000);
      try {
        const dr = await client.request('DescribeInstances',
          { RegionId: region, 'InstanceIds': JSON.stringify(ids) }, { method: 'POST' });
        const list = dr.Instances?.Instance || [];
        let allReady = list.length === ids.length;
        for (const i of list) {
          const pub = (i.PublicIpAddress?.IpAddress || [])[0] || i.EipAddress?.IpAddress || '';
          const priv = (i.VpcAttributes?.PrivateIpAddress?.IpAddress || [])[0]
            || (i.InnerIpAddress?.IpAddress || [])[0] || '';
          ipMap[i.InstanceId] = { publicIp: pub, privateIp: priv, status: i.Status };
          // 需要公网 IP 时，等到公网 IP 出现；否则等到有内网 IP 即可
          if (opts.public_ip ? !pub : !priv) allReady = false;
        }
        if (allReady) break;
      } catch (e) {
        console.warn('[createAliyunInstance] 轮询 IP 失败:', e.message);
      }
    }
  }

  const instances = ids.map(id => ({
    instanceId: id,
    instanceName: opts.instance_name || id,
    status: ipMap[id]?.status || 'pending',
    region,
    zone: opts.zone || '',
    publicIp: ipMap[id]?.publicIp || '',
    privateIp: ipMap[id]?.privateIp || '',
    config: {}
  }));

  return { success: true, instances };
}

async function startAliyunInstance(cred, instanceId, region) {
  const client = aliyunEcsClient(cred, region);
  await client.request('StartInstance', { InstanceId: instanceId }, { method: 'POST' });
}

async function stopAliyunInstance(cred, instanceId, region) {
  const client = aliyunEcsClient(cred, region);
  await client.request('StopInstance', { InstanceId: instanceId, ForceStop: false }, { method: 'POST' });
}

async function terminateAliyunInstance(cred, instanceId, region) {
  const client = aliyunEcsClient(cred, region);
  await client.request('DeleteInstance', { InstanceId: instanceId, Force: true }, { method: 'POST' });
}

async function fetchAliyunInstances(cred) {
  const all = [];
  let complete = true;
  const regionResults = await Promise.allSettled(ALIYUN_REGIONS.map(async region => {
    const client = aliyunEcsClient(cred, region);
    const instances = [];
    let pageNumber = 1;
    while (true) {
      const res = await client.request('DescribeInstances', { RegionId: region, PageNumber: pageNumber, PageSize: 100 }, { method: 'POST' });
      const list = res.Instances?.Instance || [];
      for (const i of list) {
        instances.push({
          instanceId: i.InstanceId,
          instanceName: i.InstanceName || i.InstanceId,
          status: i.Status || 'unknown',
          region,
          zone: i.ZoneId || '',
          instanceType: i.InstanceType || '',
          imageId: i.ImageId || '',
          publicIp: (i.PublicIpAddress?.IpAddress || [])[0] || i.EipAddress?.IpAddress || '',
          privateIp: (i.VpcAttributes?.PrivateIpAddress?.IpAddress || [])[0] || (i.InnerIpAddress?.IpAddress || [])[0] || '',
          config: {}
        });
      }
      if (list.length < 100) break;
      pageNumber++;
    }
    return instances;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else if (_isNonexistentRegionErr(r.reason)) console.warn(`[instances/aliyun] region 不存在，跳过: ${r.reason?.message}`);
    else { complete = false; console.warn(`[instances/aliyun] region failed: ${r.reason?.message}`); }
  }
  return { instances: all, complete };
}

// ── 百度智能云 BCC ──

async function createBaiduInstance(cred, opts) {
  const sysSizeB = parseInt(opts.system_disk_size) || 0;
  const dataSizeB = parseInt(opts.data_disk_size) || 0;
  const body = {
    clientToken: uuidv4(),
    name: opts.instance_name || '',
    imageId: opts.image_id,
    billing: { paymentTiming: 'Postpaid' },
    spec: opts.instance_type,
    ...(opts.zone ? { zoneName: opts.zone } : {}),
    // 系统盘：hp1 高性能云磁盘（SSD）
    ...(sysSizeB > 0 ? { rootDiskSizeInGb: sysSizeB, rootDiskStorageType: 'hp1' } : {}),
    // 数据盘：可选一块 hp1 高性能云磁盘
    ...(dataSizeB > 0 ? { createCdsList: [{ cdsSizeInGB: dataSizeB, storageType: 'hp1' }] } : {}),
    // 分配公网 IP：按流量计费，出网带宽上限 5Mbps
    ...(opts.public_ip
      ? { networkCapacity: { internetChargeType: 'BANDWIDTH_TRAFFIC_POSTPAID', internetMaxBandwidthOutInMbps: 5 } }
      : {}),
    ...opts.extra
  };

  const res = await bceRequest(cred, 'POST', '/v2/instance', {}, body, BCC_HOST);
  const ids = res.instanceIds || (res.instanceId ? [res.instanceId] : []);

  // 并行轮询每台实例，等待分配 IP（公网 IP 需就绪后才可见），单台最多约 90 秒
  const pollOne = async (id) => {
    for (let attempt = 0; attempt < 18; attempt++) {
      await _sleep(5000);
      try {
        const dr = await bceRequest(cred, 'GET', `/v2/instance/${encodeURIComponent(id)}`, {}, null, BCC_HOST);
        const i = dr.instance || dr;
        const pub = i.publicIp || i.eip || '';
        const priv = i.internalIp || i.privateIp || i.nicInfo?.ip || '';
        const status = (i.status || 'pending').toLowerCase();
        if (opts.public_ip ? pub : priv) return { publicIp: pub, privateIp: priv, status };
        if (attempt === 17) return { publicIp: pub, privateIp: priv, status };
      } catch (e) {
        console.warn('[createBaiduInstance] 轮询 IP 失败:', e.message);
      }
    }
    return { publicIp: '', privateIp: '', status: 'pending' };
  };
  const polled = await Promise.all(ids.map(id => pollOne(id).then(r => [id, r])));
  const ipMap = Object.fromEntries(polled);

  const instances = ids.map(id => ({
    instanceId: id,
    instanceName: opts.instance_name || id,
    status: ipMap[id]?.status || 'pending',
    zone: opts.zone || '',
    publicIp: ipMap[id]?.publicIp || '',
    privateIp: ipMap[id]?.privateIp || '',
    config: {}
  }));

  return { success: true, instances };
}

async function startBaiduInstance(cred, instanceId) {
  await bceRequest(cred, 'PUT', `/v2/instance/${encodeURIComponent(instanceId)}`, { start: '' }, {}, BCC_HOST);
}

async function stopBaiduInstance(cred, instanceId) {
  await bceRequest(cred, 'PUT', `/v2/instance/${encodeURIComponent(instanceId)}`, { stop: '' }, { forceStop: false }, BCC_HOST);
}

async function terminateBaiduInstance(cred, instanceId) {
  await bceRequest(cred, 'DELETE', `/v2/instance/${encodeURIComponent(instanceId)}`, {}, null, BCC_HOST);
}

async function fetchBaiduInstances(cred) {
  const all = [];
  let complete = true;
  const regionResults = await Promise.allSettled(BAIDU_REGIONS.map(async region => {
    const bccHost = `bcc.${region}.baidubce.com`;
    const instances = [];
    let marker;
    do {
      const query = { maxKeys: 100 };
      if (marker) query.marker = marker;
      const res = await bceRequest(cred, 'GET', '/v2/instance', query, null, bccHost);
      for (const i of res.instances || []) {
        const instId = i.instanceId || i.id;
        if (!instId) continue;
        instances.push({
          instanceId: instId,
          instanceName: i.name || instId,
          status: (i.status || 'unknown').toLowerCase(),
          region,
          zone: i.zoneName || '',
          instanceType: i.spec || i.instanceType || '',
          imageId: i.imageId || '',
          publicIp: i.publicIp || i.eip || '',
          privateIp: i.internalIp || i.privateIp || i.nicInfo?.ip || '',
          config: {}
        });
      }
      marker = res.isTruncated ? (res.nextMarker || res.marker) : undefined;
    } while (marker);
    return instances;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else if (_isNonexistentRegionErr(r.reason)) console.warn(`[instances/baidu] region 不存在，跳过: ${r.reason?.message}`);
    else { complete = false; console.warn(`[instances/baidu] region failed: ${r.reason?.message}`); }
  }
  return { instances: all, complete };
}


module.exports = router;
module.exports.createAwsInstance = createAwsInstance;
module.exports.createAliyunInstance = createAliyunInstance;
module.exports.createBaiduInstance = createBaiduInstance;
