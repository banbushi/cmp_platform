const express = require('express');
const dns = require('dns');
const { v4: uuidv4 } = require('uuid');
const db = require('../utils/database');
const { authenticate } = require('../middleware/auth');
const bceRequest = require('../utils/bce');
const { AWS_REGIONS, ALIYUN_REGIONS, BAIDU_REGIONS } = require('../utils/regions');

const router = express.Router();

const { PLATFORM_NAMES: PNAMES } = require('../utils/constants');

// ── 创建用户组（多云同时） ──
router.post('/groups/create', authenticate, async (req, res) => {
  const { group_name, display_name, description, platforms } = req.body;
  if (!group_name) return res.status(400).json({ error: '请填写组名' });
  if (!platforms || !platforms.length) return res.status(400).json({ error: '请选择至少一个云平台' });

  const results = [];
  for (const p of platforms) {
    const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [p]);
    if (!cred) { results.push({ platform: p, success: false, message: `${PNAMES[p]} 未配置主账号凭据` }); continue; }
    try {
      if (p === 'aws') {
        const { IAMClient, CreateGroupCommand } = require('@aws-sdk/client-iam');
        const client = new IAMClient({ region: cred.region || 'us-east-1', credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
        await client.send(new CreateGroupCommand({ GroupName: group_name }));
      } else if (p === 'aliyun') {
        const Core = require('@alicloud/pop-core');
        const client = new Core({ accessKeyId: cred.access_key, accessKeySecret: cred.secret_key, endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01' });
        await client.request('CreateGroup', { GroupName: group_name, DisplayName: display_name || group_name, Comments: description || '' }, { method: 'POST' });
      } else if (p === 'baidu') {
        await bceRequest(cred, 'POST', '/v1/group', {}, { name: group_name, description: description || '' });
      }
      await db.run(`
        INSERT INTO cloud_groups (id, platform, group_name, group_id, display_name, description, member_count, members, synced_at)
        VALUES (?, ?, ?, '', ?, ?, 0, '[]', NOW())
        ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), description=VALUES(description), synced_at=NOW()
      `, [uuidv4(), p, group_name, display_name || group_name, description || '']);
      results.push({ platform: p, success: true, message: '创建成功' });
    } catch (err) {
      results.push({ platform: p, success: false, message: err.message });
    }
  }
  res.json({ results });
});

// ── 删除用户组 ──
router.delete('/groups/:platform/:groupName', authenticate, async (req, res) => {
  const { platform, groupName } = req.params;
  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置凭据` });

  try {
    if (platform === 'aws') {
      const { IAMClient, GetGroupCommand, RemoveUserFromGroupCommand, DeleteGroupCommand } = require('@aws-sdk/client-iam');
      const client = new IAMClient({ region: cred.region || 'us-east-1', credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
      const gr = await client.send(new GetGroupCommand({ GroupName: groupName }));
      for (const u of gr.Users || []) {
        await client.send(new RemoveUserFromGroupCommand({ GroupName: groupName, UserName: u.UserName }));
      }
      await client.send(new DeleteGroupCommand({ GroupName: groupName }));
    } else if (platform === 'aliyun') {
      const Core = require('@alicloud/pop-core');
      const client = new Core({ accessKeyId: cred.access_key, accessKeySecret: cred.secret_key, endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01' });
      try {
        const mr = await client.request('ListUsersForGroup', { GroupName: groupName }, { method: 'POST' });
        for (const u of mr.Users?.User || []) {
          await client.request('RemoveUserFromGroup', { GroupName: groupName, UserName: u.UserName }, { method: 'POST' });
        }
      } catch {}
      await client.request('DeleteGroup', { GroupName: groupName }, { method: 'POST' });
    } else if (platform === 'baidu') {
      try {
        const gr = await bceRequest(cred, 'GET', `/v1/group/${encodeURIComponent(groupName)}/user`, {}, null);
        for (const u of gr.users || []) {
          if (u.name) await bceRequest(cred, 'DELETE', `/v1/group/${encodeURIComponent(groupName)}/user/${encodeURIComponent(u.name)}`, {}, null);
        }
      } catch {}
      await bceRequest(cred, 'DELETE', `/v1/group/${encodeURIComponent(groupName)}`, {}, null);
    } else {
      return res.status(400).json({ error: '不支持的云平台' });
    }
    await db.run('DELETE FROM cloud_groups WHERE platform = ? AND group_name = ?', [platform, groupName]);
    res.json({ message: '用户组已删除' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 同步用户组 ──

// 同步指定平台或全部平台的用户组
router.post('/groups/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  const platforms = platform === 'all' ? ['aws', 'aliyun', 'baidu'] : [platform];
  const results = [];

  console.log(`\n[sync-groups] ▶ 开始同步用户组: ${platforms.join(', ')}`);

  try {
    for (const p of platforms) {
      const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [p]);
      if (!cred) {
        results.push({ platform: p, success: false, message: `${PNAMES[p]} 未配置主账号凭据`, count: 0 });
        continue;
      }

      let groups = [];
      try {
        if (p === 'aws')         groups = await syncAwsGroups(cred);
        else if (p === 'aliyun') groups = await syncAliyunGroups(cred);
        else if (p === 'baidu')  groups = await syncBaiduGroups(cred);
      } catch (err) {
        results.push({ platform: p, success: false, message: `拉取用户组失败: ${err.message}`, count: 0 });
        continue;
      }

      let written = 0;
      const cloudGroupNames = new Set();
      for (const g of groups) {
        cloudGroupNames.add(g.groupName);
        try {
          await db.run(`
            INSERT INTO cloud_groups
              (id, platform, group_name, group_id, display_name, description, member_count, members, synced_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
            ON DUPLICATE KEY UPDATE
              group_id     = VALUES(group_id),
              display_name = VALUES(display_name),
              description  = VALUES(description),
              member_count = VALUES(member_count),
              members      = VALUES(members),
              synced_at    = NOW()
          `, [uuidv4(), p, g.groupName, g.groupId || '', g.displayName || g.groupName, g.description || '', g.memberCount || 0, JSON.stringify(g.members || [])]);
          written++;
        } catch (err) {
          console.error(`[sync-groups] ${p} 写入组 "${g.groupName}" 失败:`, err.message);
        }
      }

      // 清理云端已删除的组
      const localGroups = await db.all('SELECT group_name FROM cloud_groups WHERE platform = ?', [p]);
      let deleted = 0;
      for (const local of localGroups) {
        if (!cloudGroupNames.has(local.group_name)) {
          await db.run('DELETE FROM cloud_groups WHERE platform = ? AND group_name = ?', [p, local.group_name]);
          deleted++;
        }
      }

      console.log(`[sync-groups] ${p} 完成，写入 ${written}/${groups.length} 个组，清理 ${deleted} 个`);
      results.push({ platform: p, success: true, message: `同步成功，${deleted ? `清理 ${deleted} 个已删除的组` : ''}`, count: written });
    }
  } catch (err) {
    return res.status(500).json({ error: `同步失败: ${err.message}` });
  }

  res.json({ results });
});

// 获取已同步的用户组列表
router.get('/groups', authenticate, async (req, res) => {
  const { platform, keyword } = req.query;

  let sql = 'SELECT * FROM cloud_groups WHERE 1=1';
  const params = [];

  if (platform && platform !== 'all') {
    sql += ' AND platform = ?';
    params.push(platform);
  }
  if (keyword) {
    sql += ' AND (group_name LIKE ? OR display_name LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`);
  }

  sql += ' ORDER BY platform, group_name';

  const groups = await db.all(sql, params);
  res.json({ groups });
});

// 实时从云平台拉取指定组的成员列表
router.get('/groups/:platform/:groupName/members', authenticate, async (req, res) => {
  const { platform, groupName } = req.params;
  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置凭据` });

  try {
    let members = [];
    if (platform === 'aws') {
      const { IAMClient, GetGroupCommand } = require('@aws-sdk/client-iam');
      const client = new IAMClient({
        region: cred.region || 'us-east-1',
        credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
      });
      const gr = await client.send(new GetGroupCommand({ GroupName: groupName }));
      members = (gr.Users || []).map(u => u.UserName);
    } else if (platform === 'aliyun') {
      const Core = require('@alicloud/pop-core');
      const client = new Core({
        accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
        endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01'
      });
      const mr = await client.request('ListUsersForGroup', { GroupName: groupName }, { method: 'POST' });
      members = (mr.Users?.User || []).map(u => u.UserName);
    } else if (platform === 'baidu') {
      const mr = await bceRequest(cred, 'GET', `/v1/group/${encodeURIComponent(groupName)}/user`, {});
      members = (mr.users || []).map(u => u.name);
    } else {
      return res.status(400).json({ error: '不支持的云平台' });
    }
    res.json({ members });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 同步用户账号 ──

// ── 安全组同步函数 ──
async function syncAwsSecurityGroups(cred) {
  const { EC2Client, DescribeSecurityGroupsCommand } = require('@aws-sdk/client-ec2');
  const all = [];
  const regionResults = await Promise.allSettled(AWS_REGIONS.map(async region => {
    const client = new EC2Client({ region, credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
    const result = [];
    let nextToken;
    do {
      const resp = await client.send(new DescribeSecurityGroupsCommand({ MaxResults: 100, ...(nextToken ? { NextToken: nextToken } : {}) }));
      for (const sg of resp.SecurityGroups || []) {
        result.push({ region, sgId: sg.GroupId, sgName: sg.GroupName, description: sg.Description || '' });
      }
      nextToken = resp.NextToken;
    } while (nextToken);
    return result;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[sync-sg/aws] region failed: ${r.reason?.message}`);
  }
  return all;
}

async function syncAliyunSecurityGroups(cred) {
  const Core = require('@alicloud/pop-core');
  const all = [];
  const regionResults = await Promise.allSettled(ALIYUN_REGIONS.map(async region => {
    const client = new Core({ accessKeyId: cred.access_key, accessKeySecret: cred.secret_key, endpoint: `https://ecs.${region}.aliyuncs.com`, apiVersion: '2014-05-26' });
    const result = [];
    let pageNumber = 1;
    while (true) {
      const resp = await client.request('DescribeSecurityGroups', { RegionId: region, PageSize: 50, PageNumber: pageNumber }, { method: 'POST' });
      const sgs = resp.SecurityGroups?.SecurityGroup || [];
      for (const sg of sgs) {
        result.push({ region, sgId: sg.SecurityGroupId, sgName: sg.SecurityGroupName, description: sg.Description || '' });
      }
      if (sgs.length < 50) break;
      pageNumber++;
    }
    return result;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[sync-sg/aliyun] region failed: ${r.reason?.message}`);
  }
  return all;
}

async function syncBaiduSecurityGroups(cred) {
  const all = [];
  const regionResults = await Promise.allSettled(BAIDU_REGIONS.map(async region => {
    const bccHost = `bcc.${region}.baidubce.com`;
    const result = [];
    let marker;
    do {
      const query = { maxKeys: 100 };
      if (marker) query.marker = marker;
      const resp = await bceRequest(cred, 'GET', '/v2/securityGroup', query, null, bccHost);
      for (const sg of resp.securityGroups || []) {
        result.push({ region, sgId: sg.id, sgName: sg.name, description: sg.description || '' });
      }
      marker = resp.isTruncated ? resp.nextMarker : undefined;
    } while (marker);
    return result;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[sync-sg/baidu] region failed: ${r.reason?.message}`);
  }
  return all;
}

router.post('/security-groups/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  const platforms = platform === 'all' ? ['aws', 'aliyun', 'baidu'] : [platform];
  const results = [];

  for (const p of platforms) {
    const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [p]);
    if (!cred) {
      results.push({ platform: p, success: false, message: `${PNAMES[p]} 未配置凭据`, count: 0 });
      continue;
    }
    let sgs = [];
    try {
      if      (p === 'aws')    sgs = await syncAwsSecurityGroups(cred);
      else if (p === 'aliyun') sgs = await syncAliyunSecurityGroups(cred);
      else if (p === 'baidu')  sgs = await syncBaiduSecurityGroups(cred);
    } catch (err) {
      results.push({ platform: p, success: false, message: err.message, count: 0 });
      continue;
    }
    let written = 0;
    const cloudSgIds = new Set();
    for (const sg of sgs) {
      cloudSgIds.add(sg.sgId);
      try {
        await db.run(`
          INSERT INTO cloud_security_groups (id, platform, region, sg_id, sg_name, description, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            sg_name = VALUES(sg_name),
            description = VALUES(description),
            synced_at = NOW()
        `, [uuidv4(), p, sg.region, sg.sgId, sg.sgName, sg.description]);
        written++;
      } catch (err) {
        console.error(`[sync-sg] ${p} write failed:`, err.message);
      }
    }

    // 清理云端已删除的安全组
    const localSgs = await db.all('SELECT sg_id FROM cloud_security_groups WHERE platform = ?', [p]);
    let deleted = 0;
    for (const local of localSgs) {
      if (!cloudSgIds.has(local.sg_id)) {
        await db.run('DELETE FROM cloud_security_groups WHERE platform = ? AND sg_id = ?', [p, local.sg_id]);
        deleted++;
      }
    }

    results.push({ platform: p, success: true, count: written, deleted });
  }
  res.json({ results });
});

router.get('/security-groups', authenticate, async (req, res) => {
  const { platform, region } = req.query;
  let sql = 'SELECT * FROM cloud_security_groups WHERE 1=1';
  const params = [];
  if (platform && platform !== 'all') { sql += ' AND platform = ?'; params.push(platform); }
  if (region) { sql += ' AND region = ?'; params.push(region); }
  sql += ' ORDER BY platform, region, sg_name';
  const security_groups = await db.all(sql, params);
  res.json({ security_groups });
});

// ── VPC 同步函数 ──
async function syncAwsVpcs(cred) {
  const { EC2Client, DescribeVpcsCommand } = require('@aws-sdk/client-ec2');
  const all = [];
  const regionResults = await Promise.allSettled(AWS_REGIONS.map(async region => {
    const client = new EC2Client({ region, credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
    const result = [];
    let nextToken;
    do {
      const resp = await client.send(new DescribeVpcsCommand({ MaxResults: 100, ...(nextToken ? { NextToken: nextToken } : {}) }));
      for (const vpc of resp.Vpcs || []) {
        const name = vpc.Tags?.find(t => t.Key === 'Name')?.Value || '';
        const desc = vpc.Tags?.find(t => t.Key === 'Description')?.Value || (vpc.IsDefault ? '默认VPC' : '');
        result.push({ region, vpcId: vpc.VpcId, vpcName: name, description: desc, cidr: vpc.CidrBlock || '' });
      }
      nextToken = resp.NextToken;
    } while (nextToken);
    return result;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[sync-vpc/aws] region failed: ${r.reason?.message}`);
  }
  return all;
}

async function syncAliyunVpcs(cred) {
  const Core = require('@alicloud/pop-core');
  const all = [];
  const regionResults = await Promise.allSettled(ALIYUN_REGIONS.map(async region => {
    const client = new Core({ accessKeyId: cred.access_key, accessKeySecret: cred.secret_key, endpoint: `https://vpc.${region}.aliyuncs.com`, apiVersion: '2016-04-28' });
    const result = [];
    let pageNumber = 1;
    while (true) {
      const resp = await client.request('DescribeVpcs', { RegionId: region, PageSize: 50, PageNumber: pageNumber }, { method: 'POST' });
      const vpcs = resp.Vpcs?.Vpc || [];
      for (const vpc of vpcs) {
        result.push({ region, vpcId: vpc.VpcId, vpcName: vpc.VpcName || '', description: vpc.Description || '', cidr: vpc.CidrBlock || '' });
      }
      if (vpcs.length < 50) break;
      pageNumber++;
    }
    return result;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[sync-vpc/aliyun] region failed: ${r.reason?.message}`);
  }
  return all;
}

async function syncBaiduVpcs(cred) {
  const all = [];
  const regionResults = await Promise.allSettled(BAIDU_REGIONS.map(async region => {
    const bccHost = `bcc.${region}.baidubce.com`;
    const result = [];
    let marker;
    do {
      const query = { maxKeys: 100 };
      if (marker) query.marker = marker;
      const resp = await bceRequest(cred, 'GET', '/v1/vpc', query, null, bccHost);
      for (const vpc of resp.vpcs || []) {
        result.push({ region, vpcId: vpc.vpcId || vpc.id, vpcName: vpc.name || '', description: vpc.description || '', cidr: vpc.cidr || '' });
      }
      marker = resp.isTruncated ? resp.nextMarker : undefined;
    } while (marker);
    return result;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[sync-vpc/baidu] region failed: ${r.reason?.message}`);
  }
  return all;
}

router.post('/vpcs/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  const platforms = platform === 'all' ? ['aws', 'aliyun', 'baidu'] : [platform];
  const results = [];
  for (const p of platforms) {
    const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [p]);
    if (!cred) { results.push({ platform: p, success: false, message: `${PNAMES[p]} 未配置凭据`, count: 0 }); continue; }
    let vpcs = [];
    try {
      if      (p === 'aws')    vpcs = await syncAwsVpcs(cred);
      else if (p === 'aliyun') vpcs = await syncAliyunVpcs(cred);
      else if (p === 'baidu')  vpcs = await syncBaiduVpcs(cred);
    } catch (err) {
      results.push({ platform: p, success: false, message: err.message, count: 0 }); continue;
    }
    let written = 0;
    const cloudVpcIds = new Set();
    for (const vpc of vpcs) {
      cloudVpcIds.add(`${vpc.region}:${vpc.vpcId}`);
      try {
        await db.run(`
          INSERT INTO cloud_vpcs (id, platform, region, vpc_id, vpc_name, description, cidr, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            vpc_name = VALUES(vpc_name), description = VALUES(description),
            cidr = VALUES(cidr), synced_at = NOW()
        `, [uuidv4(), p, vpc.region, vpc.vpcId, vpc.vpcName, vpc.description, vpc.cidr]);
        written++;
      } catch (err) { console.error(`[sync-vpc] ${p}:`, err.message); }
    }
    // 清理云端已删除的 VPC
    const localVpcs = await db.all('SELECT region, vpc_id FROM cloud_vpcs WHERE platform = ?', [p]);
    for (const local of localVpcs) {
      if (!cloudVpcIds.has(`${local.region}:${local.vpc_id}`)) {
        await db.run('DELETE FROM cloud_vpcs WHERE platform = ? AND region = ? AND vpc_id = ?', [p, local.region, local.vpc_id]);
      }
    }
    results.push({ platform: p, success: true, count: written });
  }
  res.json({ results });
});

router.get('/vpcs', authenticate, async (req, res) => {
  const { platform, region } = req.query;
  let sql = 'SELECT * FROM cloud_vpcs WHERE 1=1';
  const params = [];
  if (platform && platform !== 'all') { sql += ' AND platform = ?'; params.push(platform); }
  if (region) { sql += ' AND region = ?'; params.push(region); }
  sql += ' ORDER BY platform, region, vpc_name';
  const vpcs = await db.all(sql, params);
  res.json({ vpcs });
});

// ── AWS DBSubnetGroup 同步（RDS 建实例需选子网组，须含 ≥2 子网跨 ≥2 AZ）──
async function syncAwsDbSubnetGroups(cred) {
  const { RDSClient, DescribeDBSubnetGroupsCommand } = require('@aws-sdk/client-rds');
  const all = [];
  const regionResults = await Promise.allSettled(AWS_REGIONS.map(async region => {
    const client = new RDSClient({ region, credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
    const result = [];
    let marker;
    do {
      const resp = await client.send(new DescribeDBSubnetGroupsCommand({ Marker: marker }));
      for (const g of resp.DBSubnetGroups || []) {
        const subnetIds = (g.Subnets || []).map(s => s.SubnetIdentifier).filter(Boolean);
        result.push({
          region, groupName: g.DBSubnetGroupName, vpcId: g.VpcId || '',
          subnetIds: subnetIds.join(','), description: g.DBSubnetGroupDescription || '',
        });
      }
      marker = resp.Marker;
    } while (marker);
    return result;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[sync-db-subnet-group/aws] region failed: ${r.reason?.message}`);
  }
  return all;
}

router.post('/db-subnet-groups/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  if (platform !== 'aws') return res.json({ results: [{ platform, success: true, count: 0, message: '仅 AWS 支持子网组' }] });
  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.json({ results: [{ platform, success: false, message: `${PNAMES[platform]} 未配置凭据`, count: 0 }] });
  let groups = [];
  try {
    groups = await syncAwsDbSubnetGroups(cred);
  } catch (err) {
    return res.json({ results: [{ platform, success: false, message: err.message, count: 0 }] });
  }
  let written = 0;
  const cloudKeys = new Set();
  for (const g of groups) {
    cloudKeys.add(`${g.region}:${g.groupName}`);
    try {
      await db.run(`
        INSERT INTO cloud_db_subnet_groups (id, platform, region, group_name, vpc_id, subnet_ids, description, synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          vpc_id = VALUES(vpc_id), subnet_ids = VALUES(subnet_ids),
          description = VALUES(description), synced_at = NOW()
      `, [uuidv4(), platform, g.region, g.groupName, g.vpcId, g.subnetIds, g.description]);
      written++;
    } catch (err) { console.error(`[sync-db-subnet-group] ${platform}:`, err.message); }
  }
  // 清理云端已删除的子网组
  const locals = await db.all('SELECT region, group_name FROM cloud_db_subnet_groups WHERE platform = ?', [platform]);
  for (const local of locals) {
    if (!cloudKeys.has(`${local.region}:${local.group_name}`)) {
      await db.run('DELETE FROM cloud_db_subnet_groups WHERE platform = ? AND region = ? AND group_name = ?', [platform, local.region, local.group_name]);
    }
  }
  res.json({ results: [{ platform, success: true, count: written }] });
});

router.get('/db-subnet-groups', authenticate, async (req, res) => {
  const { platform, region, vpc_id } = req.query;
  let sql = 'SELECT * FROM cloud_db_subnet_groups WHERE 1=1';
  const params = [];
  if (platform && platform !== 'all') { sql += ' AND platform = ?'; params.push(platform); }
  if (region) { sql += ' AND region = ?'; params.push(region); }
  if (vpc_id) { sql += ' AND vpc_id = ?'; params.push(vpc_id); }
  sql += ' ORDER BY platform, region, group_name';
  const subnet_groups = await db.all(sql, params);
  res.json({ subnet_groups });
});

// ── 按单用户同步权限（只拉取该用户在各云的当前策略，更新其画像） ──
router.post('/user/:id', authenticate, async (req, res) => {
  const targetId = req.params.id;
  if (req.user.role !== 'admin' && req.user.id !== targetId) {
    return res.status(403).json({ error: '无权限' });
  }

  const user = await db.get('SELECT id, cloud_username FROM users WHERE id = ?', [targetId]);
  if (!user) return res.status(404).json({ error: '用户不存在' });

  // 确定该用户在各云拥有的账号(username)
  const IAM = ['aws', 'aliyun', 'baidu'];
  const managed = await db.all(
    "SELECT platform, cloud_username FROM cloud_users WHERE user_id = ? AND status != 'failed' AND platform IN ('aws','aliyun','baidu')",
    [targetId]
  );
  const synced = user.cloud_username
    ? await db.all(
        "SELECT platform, cloud_username FROM cloud_synced_users WHERE (local_user_id = ? OR cloud_username = ?) AND platform IN ('aws','aliyun','baidu')",
        [targetId, user.cloud_username]
      )
    : await db.all(
        "SELECT platform, cloud_username FROM cloud_synced_users WHERE local_user_id = ? AND platform IN ('aws','aliyun','baidu')",
        [targetId]
      );

  // 合并去重：platform -> cloud_username
  const accountsMap = new Map();
  for (const row of [...managed, ...synced]) {
    if (!accountsMap.has(row.platform)) accountsMap.set(row.platform, row.cloud_username);
  }

  if (accountsMap.size === 0) return res.json({ results: [], message: '该用户无云平台账号可同步' });

  const results = [];
  for (const [platform, cloudUsername] of accountsMap) {
    const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
    if (!cred) {
      results.push({ platform, success: false, message: '未配置主账号凭据' });
      continue;
    }
    try {
      const policies = await _fetchSingleUserPolicies(platform, cred, cloudUsername);
      const managedRow = await db.get('SELECT id, user_id FROM cloud_users WHERE platform = ? AND cloud_username = ?', [platform, cloudUsername]);
      await db.run(`
        INSERT INTO cloud_synced_users
          (id, platform, cloud_username, cloud_user_id, display_name, email, policies, created_at_cloud, synced_at, is_managed, local_user_id)
        VALUES (?, ?, ?, '', '', '', ?, '', NOW(), ?, ?)
        ON DUPLICATE KEY UPDATE
          policies = VALUES(policies),
          synced_at = NOW(),
          is_managed = VALUES(is_managed),
          local_user_id = VALUES(local_user_id)
      `, [
        uuidv4(), platform, cloudUsername,
        JSON.stringify(policies),
        managedRow ? 1 : 0,
        managedRow ? managedRow.user_id : targetId
      ]);
      results.push({ platform, success: true, policies: policies.length });
    } catch (e) {
      // 云端用户不存在（换主账号/被删除）→ 清理本地旧记录(两张表都清)，不报红色错误
      const notExist = /not exist|not found|NoSuchEntity|EntityNotExist/i.test(e.message || '');
      if (notExist) {
        await db.run('DELETE FROM cloud_synced_users WHERE platform = ? AND cloud_username = ?', [platform, cloudUsername]);
        await db.run('DELETE FROM cloud_users WHERE platform = ? AND cloud_username = ?', [platform, cloudUsername]);
        results.push({ platform, success: true, message: `用户 ${cloudUsername} 在云端已不存在，已清理本地记录` });
      } else {
        results.push({ platform, success: false, message: e.message });
      }
    }
  }

  res.json({ results });
});

// 拉取单个用户在指定云平台的当前策略列表
async function _fetchSingleUserPolicies(platform, cred, username) {
  if (platform === 'aws') {
    const { IAMClient, ListAttachedUserPoliciesCommand, ListGroupsForUserCommand } = require('@aws-sdk/client-iam');
    const client = new IAMClient({
      region: cred.region || 'us-east-1',
      credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
    });
    const pr = await client.send(new ListAttachedUserPoliciesCommand({ UserName: username }));
    const policies = (pr.AttachedPolicies || []).map(p => p.PolicyName);
    // 也拉组内继承的策略（可选但更准确）——暂跳过，保持和全量同步一致
    return policies;
  }
  if (platform === 'aliyun') {
    const Core = require('@alicloud/pop-core');
    const client = new Core({
      accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
      endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01'
    });
    const pr = await client.request('ListPoliciesForUser', { UserName: username }, { method: 'POST' });
    return (pr.Policies?.Policy || []).map(p => p.PolicyName);
  }
  if (platform === 'baidu') {
    const pr = await bceRequest(cred, 'GET', `/v1/user/${encodeURIComponent(username)}/policy`, {});
    return (pr.policies || []).map(p => p.name || p.policyName).filter(Boolean);
  }
  return [];
}

// ── 同步用户账号（全量） ──
router.post('/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  const platforms = platform === 'all' ? ['aws', 'aliyun', 'baidu', 'jumpserver']
                  : platform === 'third-all' ? ['jumpserver', 'kuboard']
                  : [platform];
  const results = [];

  console.log(`\n[sync] ▶ 开始同步: ${platforms.join(', ')}`);

  try {
    for (const p of platforms) {
      console.log(`[sync] ── 平台: ${p} ──`);

      let cred;
      try {
        cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [p]);
      } catch (err) {
        console.error(`[sync] ${p} 读取凭据失败:`, err.message);
        results.push({ platform: p, success: false, message: `数据库读取失败: ${err.message}`, count: 0 });
        continue;
      }

      if (!cred) {
        console.log(`[sync] ${p} 未找到凭据，跳过`);
        results.push({ platform: p, success: false, message: `${PNAMES[p]} 未配置主账号凭据`, count: 0 });
        continue;
      }
      console.log(`[sync] ${p} 凭据已找到`);

      let users = [];
      try {
        console.log(`[sync] ${p} 正在拉取云账号...`);
        if (p === 'aws')         users = await syncAwsUsers(cred);
        else if (p === 'aliyun') users = await syncAliyunUsers(cred);
        else if (p === 'baidu')  users = await syncBaiduUsers(cred);
        else if (p === 'jumpserver') users = await syncJumpServerUsers(cred);
        else if (p === 'kuboard')    users = await syncKuboardUsers(cred);
        console.log(`[sync] ${p} 拉取完成，共 ${users.length} 个账号`);
      } catch (err) {
        console.error(`[sync] ${p} 拉取云账号失败:`, err.message);
        results.push({ platform: p, success: false, message: `拉取账号失败: ${err.message}`, count: 0 });
        continue;
      }

      let written = 0;
      const cloudUsernames = new Set();
      for (const u of users) {
        cloudUsernames.add(u.username);
        try {
          const managed = await db.get(
            'SELECT id, user_id FROM cloud_users WHERE platform = ? AND cloud_username = ?',
            [p, u.username]
          );

          await db.run(`
            INSERT INTO cloud_synced_users
              (id, platform, cloud_username, cloud_user_id, display_name, email, policies, created_at_cloud, synced_at, is_managed, local_user_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?)
            ON DUPLICATE KEY UPDATE
              policies         = VALUES(policies),
              display_name     = VALUES(display_name),
              email            = VALUES(email),
              synced_at        = NOW(),
              is_managed       = VALUES(is_managed),
              local_user_id    = VALUES(local_user_id)
          `, [
            uuidv4(), p, u.username, u.userId || '', u.displayName || '', u.email || '',
            JSON.stringify(u.policies || []), u.createdAt || '',
            managed ? 1 : 0, managed ? managed.user_id : null
          ]);
          written++;
          console.log(`[sync] ${p} 写入成功: ${u.username}`);
        } catch (err) {
          console.error(`[sync] ${p} 写入用户 "${u.username}" 失败:`, err.message);
        }
      }

      // 清理云端已删除的用户
      const localUsers = await db.all('SELECT cloud_username FROM cloud_synced_users WHERE platform = ?', [p]);
      let deleted = 0;
      for (const local of localUsers) {
        if (!cloudUsernames.has(local.cloud_username)) {
          await db.run('DELETE FROM cloud_synced_users WHERE platform = ? AND cloud_username = ?', [p, local.cloud_username]);
          deleted++;
        }
      }

      console.log(`[sync] ${p} 完成，写入 ${written}/${users.length} 个账号，清理 ${deleted} 个`);
      results.push({ platform: p, success: true, message: '同步成功', count: written, deleted });
    }
  } catch (err) {
    console.error('[sync] 同步过程发生意外错误:', err);
    return res.status(500).json({ error: `同步失败: ${err.message}` });
  }

  console.log('[sync] ▶ 全部完成\n');
  res.json({ results });
});

// 获取同步结果
router.get('/results', authenticate, async (req, res) => {
  const { platform, keyword } = req.query;

  let sql = `SELECT csu.*, u.id AS lu_id, u.name AS lu_name, u.email AS lu_email, u.department AS lu_dept
    FROM cloud_synced_users csu
    LEFT JOIN users u ON csu.local_user_id = u.id
    WHERE 1=1`;
  const params = [];

  if (platform && platform !== 'all') {
    sql += ' AND csu.platform = ?';
    params.push(platform);
  }
  if (keyword) {
    sql += ' AND (csu.cloud_username LIKE ? OR csu.display_name LIKE ? OR csu.email LIKE ?)';
    params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
  }

  sql += ' ORDER BY csu.is_managed DESC, csu.synced_at DESC';

  const rows = await db.all(sql, params);
  const enriched = rows.map(r => {
    const localUser = r.lu_id ? { id: r.lu_id, name: r.lu_name, email: r.lu_email, department: r.lu_dept } : null;
    return { ...r, lu_id: undefined, lu_name: undefined, lu_email: undefined, lu_dept: undefined, policies: JSON.parse(r.policies || '[]'), local_user: localUser };
  });

  const statsRows = await db.all(
    `SELECT platform, COUNT(*) AS total, SUM(is_managed) AS managed, MAX(synced_at) AS lastSync
     FROM cloud_synced_users GROUP BY platform`
  );
  const stats = {};
  for (const p of ['aws', 'aliyun', 'baidu']) {
    const row = statsRows.find(r => r.platform === p);
    stats[p] = { total: row?.total || 0, managed: row?.managed || 0, lastSync: row?.lastSync || null };
  }

  res.json({ users: enriched, stats });
});

// 获取同步状态
router.get('/status', authenticate, async (req, res) => {
  const platforms = ['aws', 'aliyun', 'baidu'];
  const status = {};
  for (const p of platforms) {
    const row     = await db.get('SELECT COUNT(*) as total, MAX(synced_at) as last_sync FROM cloud_synced_users WHERE platform = ?', [p]);
    const managed = (await db.get('SELECT COUNT(*) as c FROM cloud_synced_users WHERE platform = ? AND is_managed = 1', [p])).c;
    const hasCred = !!(await db.get('SELECT id FROM platform_credentials WHERE platform = ? AND enabled = 1', [p]));
    status[p] = { total: row.total, managed, last_sync: row.last_sync, has_cred: hasCred };
  }
  res.json({ status });
});

// ── 云平台 API 调用 ──

async function syncAwsUsers(cred) {
  const { IAMClient, ListUsersCommand, ListAttachedUserPoliciesCommand } = require('@aws-sdk/client-iam');
  const client = new IAMClient({
    region: cred.region || 'us-east-1',
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });

  const users = [];
  let marker;
  do {
    const res = await client.send(new ListUsersCommand({ MaxItems: 100, Marker: marker }));
    for (const u of res.Users || []) {
      let policies = [];
      try {
        const pr = await client.send(new ListAttachedUserPoliciesCommand({ UserName: u.UserName }));
        policies = (pr.AttachedPolicies || []).map(p => p.PolicyName);
      } catch {}
      users.push({ username: u.UserName, userId: u.UserId, displayName: u.UserName, email: '', policies, createdAt: u.CreateDate?.toISOString?.() || '' });
    }
    marker = res.IsTruncated ? res.Marker : undefined;
  } while (marker);

  return users;
}

async function syncAliyunUsers(cred) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({
    accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
    endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01'
  });

  const users = [];
  let marker;
  do {
    const params = { MaxItems: 100 };
    if (marker) params.Marker = marker;
    const res = await client.request('ListUsers', params, { method: 'POST' });
    for (const u of res.Users?.User || []) {
      let policies = [];
      try {
        const pr = await client.request('ListPoliciesForUser', { UserName: u.UserName }, { method: 'POST' });
        policies = (pr.Policies?.Policy || []).map(p => p.PolicyName);
      } catch {}
      users.push({ username: u.UserName, userId: u.UserId || '', displayName: u.DisplayName || u.UserName, email: u.Email || '', policies, createdAt: u.CreateDate || '' });
    }
    marker = res.IsTruncated ? res.Marker : undefined;
  } while (marker);

  return users;
}

async function syncBaiduUsers(cred) {
  const users = [];
  let marker;

  do {
    const query = { maxKeys: 100 };
    if (marker) query.marker = marker;

    const res = await bceRequest(cred, 'GET', '/v1/user', query);

    for (const u of res.users || []) {
      let policies = [];
      try {
        const pr = await bceRequest(cred, 'GET', `/v1/user/${encodeURIComponent(u.name)}/policy`, {});
        policies = (pr.policies || []).map(p => p.name || p.policyName).filter(Boolean);
      } catch {}
      users.push({ username: u.name, userId: u.id || u.userId || '', displayName: u.description || u.name, email: '', policies, createdAt: u.createTime || '' });
    }

    marker = res.isTruncated ? (res.nextMarker || res.marker) : undefined;
  } while (marker);

  return users;
}

async function syncJumpServerUsers(cred) {
  const { listJumpServerResource } = require('../utils/jumpserver');
  const users = [];
  let page = 1;
  const pageSize = 100;

  while (true) {
    const { items, total } = await listJumpServerResource(cred, '/api/v1/users/users/', page, pageSize, '');
    for (const u of items) {
      users.push({
        username: u.username,
        userId: u.id || '',
        displayName: u.name || u.username,
        email: u.email || '',
        policies: [],
        createdAt: u.date_joined || ''
      });
    }
    if (page * pageSize >= total) break;
    page++;
  }

  return users;
}

async function syncKuboardUsers(cred) {
  const loginUser = cred.account_name || 'admin';
  const base = (cred.access_key || '').replace(/\/$/, '');
  const headers = { 'Cookie': `KuboardUsername=${loginUser}; KuboardAccessKey=${cred.secret_key}` };
  if (cred.cf_client_id && cred.cf_client_secret) {
    headers['CF-Access-Client-Id'] = cred.cf_client_id;
    headers['CF-Access-Client-Secret'] = cred.cf_client_secret;
  }
  const resp = await fetch(`${base}/kuboard-api/cluster/GLOBAL/kind/KuboardAuthUser`, { headers });
  if (resp.status === 403) throw new Error('鉴权失败：请检查登录用户名与访问密钥（用户名须为生成密钥的账号）');
  if (resp.status !== 200) throw new Error(`Kuboard 返回 HTTP ${resp.status}`);
  const data = await resp.json();
  return (data.items || []).map(u => ({
    username: u.metadata?.name || '',
    userId: u.metadata?.uid || '',
    displayName: u.spec?.fullName || u.metadata?.name || '',
    email: u.spec?.email || '',
    policies: [],
    createdAt: (u.metadata?.createTime || '').slice(0, 19).replace('T', ' '),
  }));
}

// ── 用户组同步函数 ──

async function syncAwsGroups(cred) {
  const { IAMClient, ListGroupsCommand, GetGroupCommand } = require('@aws-sdk/client-iam');
  const client = new IAMClient({
    region: cred.region || 'us-east-1',
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });

  const groups = [];
  let marker;
  do {
    const res = await client.send(new ListGroupsCommand({ MaxItems: 100, Marker: marker }));
    for (const g of res.Groups || []) {
      let memberCount = 0;
      let members = [];
      try {
        const gr = await client.send(new GetGroupCommand({ GroupName: g.GroupName }));
        members = (gr.Users || []).map(u => u.UserName);
        memberCount = members.length;
      } catch {}
      groups.push({ groupName: g.GroupName, groupId: g.GroupId, displayName: g.GroupName, description: '', memberCount, members });
    }
    marker = res.IsTruncated ? res.Marker : undefined;
  } while (marker);

  return groups;
}

async function syncAliyunGroups(cred) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({
    accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
    endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01'
  });

  const groups = [];
  let marker;
  do {
    const params = { MaxItems: 100 };
    if (marker) params.Marker = marker;
    const res = await client.request('ListGroups', params, { method: 'POST' });
    for (const g of res.Groups?.Group || []) {
      let memberCount = 0;
      let members = [];
      try {
        const mr = await client.request('ListUsersForGroup', { GroupName: g.GroupName }, { method: 'POST' });
        members = (mr.Users?.User || []).map(u => u.UserName);
        memberCount = members.length;
      } catch {}
      groups.push({ groupName: g.GroupName, groupId: g.GroupId || '', displayName: g.DisplayName || g.GroupName, description: g.Comments || '', memberCount, members });
    }
    marker = res.IsTruncated ? res.Marker : undefined;
  } while (marker);

  return groups;
}

async function syncBaiduGroups(cred) {
  const groups = [];
  let marker;

  do {
    const query = { maxKeys: 100 };
    if (marker) query.marker = marker;
    const res = await bceRequest(cred, 'GET', '/v1/group', query);

    for (const g of res.groups || []) {
      let memberCount = 0;
      let members = [];
      try {
        const mr = await bceRequest(cred, 'GET', `/v1/group/${encodeURIComponent(g.name)}/user`, {});
        members = (mr.users || []).map(u => u.name);
        memberCount = members.length;
      } catch {}
      groups.push({ groupName: g.name, groupId: g.id || '', displayName: g.description || g.name, description: g.description || '', memberCount, members });
    }

    marker = res.isTruncated ? (res.nextMarker || res.marker) : undefined;
  } while (marker);

  return groups;
}

// ── 子网同步函数 ──
async function syncAwsSubnets(cred) {
  const { EC2Client, DescribeSubnetsCommand } = require('@aws-sdk/client-ec2');
  const all = [];
  const regionResults = await Promise.allSettled(AWS_REGIONS.map(async region => {
    const client = new EC2Client({ region, credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
    const result = [];
    let nextToken;
    do {
      const resp = await client.send(new DescribeSubnetsCommand({ MaxResults: 100, ...(nextToken ? { NextToken: nextToken } : {}) }));
      for (const s of resp.Subnets || []) {
        const name = s.Tags?.find(t => t.Key === 'Name')?.Value || '';
        result.push({ region, subnetId: s.SubnetId, subnetName: name, vpcId: s.VpcId || '', cidr: s.CidrBlock || '', zone: s.AvailabilityZone || '', description: '' });
      }
      nextToken = resp.NextToken;
    } while (nextToken);
    return result;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[sync-subnet/aws] region failed: ${r.reason?.message}`);
  }
  return all;
}

async function syncAliyunSubnets(cred) {
  const Core = require('@alicloud/pop-core');
  const all = [];
  const regionResults = await Promise.allSettled(ALIYUN_REGIONS.map(async region => {
    const client = new Core({ accessKeyId: cred.access_key, accessKeySecret: cred.secret_key, endpoint: `https://vpc.${region}.aliyuncs.com`, apiVersion: '2016-04-28' });
    const result = [];
    let pageNumber = 1;
    while (true) {
      const resp = await client.request('DescribeVSwitches', { RegionId: region, PageSize: 50, PageNumber: pageNumber }, { method: 'POST' });
      const vswitches = resp.VSwitches?.VSwitch || [];
      for (const v of vswitches) {
        result.push({ region, subnetId: v.VSwitchId, subnetName: v.VSwitchName || '', vpcId: v.VpcId || '', cidr: v.CidrBlock || '', zone: v.ZoneId || '', description: v.Description || '' });
      }
      if (vswitches.length < 50) break;
      pageNumber++;
    }
    return result;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[sync-subnet/aliyun] region failed: ${r.reason?.message}`);
  }
  return all;
}

async function syncBaiduSubnets(cred) {
  const all = [];
  const regionResults = await Promise.allSettled(BAIDU_REGIONS.map(async region => {
    const bccHost = `bcc.${region}.baidubce.com`;
    const result = [];
    let marker;
    do {
      const query = { maxKeys: 100 };
      if (marker) query.marker = marker;
      const resp = await bceRequest(cred, 'GET', '/v1/subnet', query, null, bccHost);
      for (const s of resp.subnets || []) {
        result.push({ region, subnetId: s.subnetId || s.id, subnetName: s.name || '', vpcId: s.vpcId || '', cidr: s.cidr || '', zone: s.zoneName || '', description: s.description || '' });
      }
      marker = resp.isTruncated ? resp.nextMarker : undefined;
    } while (marker);
    return result;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[sync-subnet/baidu] region failed: ${r.reason?.message}`);
  }
  return all;
}

router.post('/subnets/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  const platforms = platform === 'all' ? ['aws', 'aliyun', 'baidu'] : [platform];
  const results = [];
  for (const p of platforms) {
    const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [p]);
    if (!cred) { results.push({ platform: p, success: false, message: `${PNAMES[p]} 未配置凭据`, count: 0 }); continue; }
    let subnets = [];
    try {
      if      (p === 'aws')    subnets = await syncAwsSubnets(cred);
      else if (p === 'aliyun') subnets = await syncAliyunSubnets(cred);
      else if (p === 'baidu')  subnets = await syncBaiduSubnets(cred);
    } catch (err) {
      results.push({ platform: p, success: false, message: err.message, count: 0 }); continue;
    }
    let written = 0;
    const cloudSubnetIds = new Set();
    for (const s of subnets) {
      cloudSubnetIds.add(`${s.region}:${s.subnetId}`);
      try {
        await db.run(`
          INSERT INTO cloud_subnets
            (id, platform, region, subnet_id, subnet_name, vpc_id, cidr, zone, description, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            subnet_name = VALUES(subnet_name), vpc_id = VALUES(vpc_id),
            cidr = VALUES(cidr), zone = VALUES(zone),
            description = VALUES(description), synced_at = NOW()
        `, [uuidv4(), p, s.region, s.subnetId, s.subnetName, s.vpcId, s.cidr, s.zone, s.description]);
        written++;
      } catch (err) { console.error(`[sync-subnet] ${p}:`, err.message); }
    }
    // 清理云端已删除的子网
    const localSubnets = await db.all('SELECT region, subnet_id FROM cloud_subnets WHERE platform = ?', [p]);
    for (const local of localSubnets) {
      if (!cloudSubnetIds.has(`${local.region}:${local.subnet_id}`)) {
        await db.run('DELETE FROM cloud_subnets WHERE platform = ? AND region = ? AND subnet_id = ?', [p, local.region, local.subnet_id]);
      }
    }
    results.push({ platform: p, success: true, count: written });
  }
  res.json({ results });
});

router.get('/subnets', authenticate, async (req, res) => {
  const { platform, region, vpc_id } = req.query;
  let sql = 'SELECT * FROM cloud_subnets WHERE 1=1';
  const params = [];
  if (platform && platform !== 'all') { sql += ' AND platform = ?'; params.push(platform); }
  if (region)  { sql += ' AND region = ?';  params.push(region); }
  if (vpc_id)  { sql += ' AND vpc_id = ?';  params.push(vpc_id); }
  sql += ' ORDER BY platform, region, zone, subnet_name';
  const subnets = await db.all(sql, params);
  res.json({ subnets });
});

// ══════════════════════════════════════════════════════════
// SSL 证书同步
// ══════════════════════════════════════════════════════════

async function syncAwsCerts(cred) {
  const { ACMClient, ListCertificatesCommand, DescribeCertificateCommand } = require('@aws-sdk/client-acm');
  const all = [];
  console.log('[sync-certs/aws] 开始同步，检查区域数:', AWS_REGIONS.length);
  const regionResults = await Promise.allSettled(AWS_REGIONS.map(async region => {
    const client = new ACMClient({ region, credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
    const result = [];
    let nextToken;
    do {
      const resp = await client.send(new ListCertificatesCommand({ MaxItems: 100, ...(nextToken ? { NextToken: nextToken } : {}) }));
      for (const c of resp.CertificateSummaryList || []) {
        let domain = c.DomainName || '', sans = [], status = c.Status || '', expiresAt = null;
        try {
          const detail = await client.send(new DescribeCertificateCommand({ CertificateArn: c.CertificateArn }));
          const cert = detail.Certificate || {};
          domain = cert.DomainName || domain;
          sans = cert.SubjectAlternativeNames || [];
          status = cert.Status || status;
          expiresAt = cert.NotAfter ? new Date(cert.NotAfter) : null;
        } catch {}
        result.push({ certId: c.CertificateArn, certName: domain, domain, sans: JSON.stringify(sans), status, expiresAt, region });
      }
      nextToken = resp.NextToken;
    } while (nextToken);
    console.log(`[sync-certs/aws] ${region}: ${result.length} 条证书`);
    return result;
  }));
  for (const r of regionResults) {
    if (r.status === 'fulfilled') all.push(...r.value);
    else console.warn(`[sync-cert/aws] region failed: ${r.reason?.message}`);
  }
  console.log(`[sync-certs/aws] 总计: ${all.length} 条证书`);
  return all;
}

async function syncAliyunCerts(cred) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({
    accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
    endpoint: 'https://cas.aliyuncs.com', apiVersion: '2018-07-13'
  });
  const result = [];
  let currentPage = 1;
  try {
    while (true) {
      const resp = await client.request('DescribeUserCertificateList', {
        CurrentPage: currentPage,
        ShowSize: 50
      }, { method: 'POST' });
      const certs = resp.CertificateList || [];
      for (const c of certs) {
        const sans = c.sans ? c.sans.split(',').map(s => s.trim()).filter(Boolean) : [];
        const expiresAt = c.endDate ? new Date(c.endDate) : null;
        result.push({
          certId:   String(c.id || c.certId),
          certName: c.name || c.common || '',
          domain:   c.common || c.name || '',
          sans:     JSON.stringify(sans),
          status:   c.buyInAliyun ? 'active' : 'uploaded',
          expiresAt,
          region:   '',
        });
      }
      if (certs.length < 50) break;
      currentPage++;
    }
  } catch (e) {
    console.error('[sync-certs/aliyun] 证书列表获取失败:', e.message);
  }
  return result;
}

async function syncBaiduCerts(cred) {
  const certHost = 'certificate.baidubce.com';
  const result = [];
  try {
    console.log(`[sync-certs/baidu] 开始请求证书列表... (host: ${certHost})`);
    const resp = await bceRequest(cred, 'GET', '/v1/certificate', {}, null, certHost);
    console.log('[sync-certs/baidu] 证书列表响应:', JSON.stringify(resp).slice(0, 500));
    const certs = resp.certs || resp.certificates || resp.certList || resp.items || [];
    for (const c of certs) {
      const expiresAt = (c.certStopTime || c.certEndTime || c.expireTime) ? new Date(c.certStopTime || c.certEndTime || c.expireTime) : null;
      result.push({
        certId:   c.certId || c.id || '',
        certName: c.certName || c.name || '',
        domain:   c.certCommonName || c.commonName || '',
        sans:     JSON.stringify([]),
        status:   c.certStopTime && new Date(c.certStopTime) < new Date() ? 'expired' : 'active',
        expiresAt,
        region:   '',
      });
    }
    console.log(`[sync-certs/baidu] 获取到 ${certs.length} 个证书`);
  } catch (e) {
    console.error('[sync-cert/baidu]', e.message);
  }
  return result;
}

router.post('/certs/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  const platforms = platform === 'all' ? ['aws', 'aliyun', 'baidu'] : [platform];
  const results = [];
  for (const p of platforms) {
    const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [p]);
    if (!cred) { results.push({ platform: p, success: false, message: `${PNAMES[p]} 未配置凭据`, count: 0 }); continue; }
    let certs = [];
    try {
      if      (p === 'aws')    certs = await syncAwsCerts(cred);
      else if (p === 'aliyun') certs = await syncAliyunCerts(cred);
      else if (p === 'baidu')  certs = await syncBaiduCerts(cred);
    } catch (err) {
      results.push({ platform: p, success: false, message: err.message, count: 0 }); continue;
    }
    let written = 0;
    const cloudCertIds = new Set();
    for (const c of certs) {
      cloudCertIds.add(`${c.region || ''}:${c.certId}`);
      try {
        await db.run(`
          INSERT INTO cloud_certs (id, platform, region, cert_id, cert_name, domain, sans, status, expires_at, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            cert_name = VALUES(cert_name), domain = VALUES(domain), sans = VALUES(sans),
            status = VALUES(status), expires_at = VALUES(expires_at), synced_at = NOW()
        `, [uuidv4(), p, c.region || '', c.certId, c.certName, c.domain, c.sans, c.status, c.expiresAt || null]);
        written++;
      } catch (err) { console.error(`[sync-cert] ${p}:`, err.message); }
    }
    // 清理云端已删除的证书
    const localCerts = await db.all('SELECT region, cert_id FROM cloud_certs WHERE platform = ?', [p]);
    for (const local of localCerts) {
      if (!cloudCertIds.has(`${local.region || ''}:${local.cert_id}`)) {
        await db.run('DELETE FROM cloud_certs WHERE platform = ? AND cert_id = ?', [p, local.cert_id]);
      }
    }
    results.push({ platform: p, success: true, count: written });
  }
  res.json({ results });
});

router.get('/certs', authenticate, async (req, res) => {
  const { platform } = req.query;
  let sql = 'SELECT * FROM cloud_certs WHERE 1=1';
  const params = [];
  if (platform && platform !== 'all') { sql += ' AND platform = ?'; params.push(platform); }
  sql += ' ORDER BY platform, expires_at ASC';
  const certs = await db.all(sql, params);
  res.json({ certs });
});

// 即将过期 / 已过期的证书（默认 30 天内），供首页告警卡片、侧边栏红点、汇总条用
router.get('/certs/expiring', authenticate, async (req, res) => {
  const days = Math.max(1, parseInt(req.query.days, 10) || 30);
  const rows = await db.all(
    `SELECT * FROM cloud_certs
     WHERE expires_at IS NOT NULL AND expires_at <= DATE_ADD(NOW(), INTERVAL ? DAY)
     ORDER BY expires_at ASC`,
    [days]
  );
  const now = Date.now();
  const certs = rows.map(r => ({
    ...r,
    days_left: Math.ceil((new Date(r.expires_at).getTime() - now) / 86400000),
  }));
  const expired  = certs.filter(c => c.days_left < 0).length;
  const expiring = certs.filter(c => c.days_left >= 0).length;
  res.json({ threshold_days: days, total: certs.length, expired, expiring, certs });
});

// ══════════════════════════════════════════════════════════
// DNS 解析同步
// ══════════════════════════════════════════════════════════

async function syncAwsDns(cred) {
  const { Route53Client, ListHostedZonesCommand, ListResourceRecordSetsCommand } = require('@aws-sdk/client-route-53');
  const client = new Route53Client({ region: 'us-east-1', credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key } });
  const result = [];
  let marker;
  do {
    const zonesResp = await client.send(new ListHostedZonesCommand({ ...(marker ? { Marker: marker } : {}) }));
    for (const zone of zonesResp.HostedZones || []) {
      const zoneId   = zone.Id.replace('/hostedzone/', '');
      const zoneName = zone.Name.replace(/\.$/, '');
      let rrMarker;
      do {
        const rrsResp = await client.send(new ListResourceRecordSetsCommand({
          HostedZoneId: zoneId, ...(rrMarker ? { StartRecordName: rrMarker } : {})
        }));
        for (const rr of rrsResp.ResourceRecordSets || []) {
          const value = (rr.ResourceRecords || []).map(r => r.Value).join('\n') || (rr.AliasTarget?.DNSName || '');
          result.push({
            zoneId, zoneName,
            recordId:    `${zoneId}:${rr.Name}:${rr.Type}`,
            recordName:  rr.Name.replace(/\.$/, '').replace(new RegExp(`\\.?${zoneName}$`), '') || '@',
            recordType:  rr.Type,
            recordValue: value,
            ttl:         rr.TTL || 300,
            status:      '',
            region:      '',
          });
        }
        rrMarker = rrsResp.IsTruncated ? rrsResp.NextRecordName : undefined;
      } while (rrMarker);
    }
    marker = zonesResp.IsTruncated ? zonesResp.NextMarker : undefined;
  } while (marker);
  return result;
}

async function syncAliyunDns(cred) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({
    accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
    endpoint: 'https://alidns.aliyuncs.com', apiVersion: '2015-01-09'
  });
  const result = [];
  let domainPage = 1;
  while (true) {
    const domainsResp = await client.request('DescribeDomains', { PageNumber: domainPage, PageSize: 20 }, { method: 'POST' });
    const domains = domainsResp.Domains?.Domain || [];
    for (const domain of domains) {
      const zoneName = domain.DomainName;
      const zoneId   = domain.DomainId || zoneName;
      let recPage = 1;
      while (true) {
        const recsResp = await client.request('DescribeDomainRecords', { DomainName: zoneName, PageNumber: recPage, PageSize: 100 }, { method: 'POST' });
        const records = recsResp.DomainRecords?.Record || [];
        for (const r of records) {
          result.push({
            zoneId, zoneName,
            recordId:    r.RecordId,
            recordName:  r.RR || '@',
            recordType:  r.Type,
            recordValue: r.Value,
            ttl:         r.TTL || 600,
            status:      r.Status || '',
            region:      '',
          });
        }
        if (records.length < 100) break;
        recPage++;
      }
    }
    if (domains.length < 20) break;
    domainPage++;
  }
  return result;
}

async function syncBaiduDns(cred) {
  const dnsHost = 'dns.baidubce.com';
  const result = [];
  try {
    console.log(`[sync-dns/baidu] 开始请求域名列表... (host: ${dnsHost})`);
    const domainsResp = await bceRequest(cred, 'GET', '/v1/dns/zone', {}, null, dnsHost);
    console.log('[sync-dns/baidu] 域名列表响应:', JSON.stringify(domainsResp, null, 2));

    const zones = domainsResp.zones || [];
    console.log(`[sync-dns/baidu] 解析到 ${zones.length} 个域名`);

    for (const zone of zones) {
      const zoneName = zone.name || '';
      const zoneId = zone.id || zoneName;
      console.log(`[sync-dns/baidu] 处理域名: ${zoneName}`);
      try {
        const recsResp = await bceRequest(cred, 'GET', `/v1/dns/zone/${zoneName}/record`, {}, null, dnsHost);
        console.log(`[sync-dns/baidu] 域名 ${zoneName} 解析记录:`, JSON.stringify(recsResp).slice(0, 500));
        const records = recsResp.records || [];
        for (const r of records) {
          result.push({
            zoneId, zoneName,
            recordId:    r.recordId || r.id || '',
            recordName:  r.rr || '@',
            recordType:  r.type || '',
            recordValue: r.value || '',
            ttl:         r.ttl || 600,
            status:      r.status || '',
            region:      '',
          });
        }
      } catch (e) {
        console.error(`[sync-dns/baidu] 域名 ${zoneName} 记录获取失败:`, e.message);
      }
    }
  } catch (e) {
    console.error('[sync-dns/baidu] 域名列表获取失败:', e.message, e.stack);
  }
  console.log(`[sync-dns/baidu] 最终返回 ${result.length} 条记录`);
  return result;
}

router.post('/dns-records/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  const platforms = platform === 'all' ? ['aws', 'aliyun', 'baidu'] : [platform];
  const results = [];
  for (const p of platforms) {
    const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [p]);
    if (!cred) { results.push({ platform: p, success: false, message: `${PNAMES[p]} 未配置凭据`, count: 0 }); continue; }
    let records = [];
    try {
      if      (p === 'aws')    records = await syncAwsDns(cred);
      else if (p === 'aliyun') records = await syncAliyunDns(cred);
      else if (p === 'baidu')  records = await syncBaiduDns(cred);
    } catch (err) {
      results.push({ platform: p, success: false, message: err.message, count: 0 }); continue;
    }
    let written = 0;
    const cloudRecordIds = new Set();
    for (const r of records) {
      cloudRecordIds.add(r.recordId);
      try {
        await db.run(`
          INSERT INTO cloud_dns_records (id, platform, region, zone_id, zone_name, record_id, record_name, record_type, record_value, ttl, status, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
          ON DUPLICATE KEY UPDATE
            zone_name = VALUES(zone_name), record_name = VALUES(record_name),
            record_type = VALUES(record_type), record_value = VALUES(record_value),
            ttl = VALUES(ttl), status = VALUES(status), synced_at = NOW()
        `, [uuidv4(), p, r.region || '', r.zoneId, r.zoneName, r.recordId, r.recordName, r.recordType, r.recordValue, r.ttl, r.status]);
        written++;
      } catch (err) { console.error(`[sync-dns] ${p}:`, err.message); }
    }
    // 清理云端已删除的 DNS 记录
    const localRecords = await db.all('SELECT record_id FROM cloud_dns_records WHERE platform = ?', [p]);
    for (const local of localRecords) {
      if (!cloudRecordIds.has(local.record_id)) {
        await db.run('DELETE FROM cloud_dns_records WHERE platform = ? AND record_id = ?', [p, local.record_id]);
      }
    }
    results.push({ platform: p, success: true, count: written });
  }
  res.json({ results });
});

router.get('/dns-records', authenticate, async (req, res) => {
  const { platform, zone_id } = req.query;
  let sql = 'SELECT * FROM cloud_dns_records WHERE 1=1';
  const params = [];
  if (platform && platform !== 'all') { sql += ' AND platform = ?'; params.push(platform); }
  if (zone_id)  { sql += ' AND zone_id = ?'; params.push(zone_id); }
  sql += ' ORDER BY platform, zone_name, record_name, record_type';
  const records = await db.all(sql, params);
  res.json({ records });
});

// 检查 DNS 域名是否已使用（后端拼接匹配）
router.get('/check-dns', authenticate, async (req, res) => {
  const { domain, platform, zone_name } = req.query;
  if (!domain || !domain.trim()) return res.status(400).json({ error: '请输入域名' });

  const input = domain.trim().toLowerCase();
  let whereConditions = [];
  let params = [];

  // 平台过滤
  if (platform && platform !== 'all') {
    whereConditions.push('platform = ?');
    params.push(platform);
  }

  // 域名区域过滤
  if (zone_name) {
    whereConditions.push('zone_name = ?');
    params.push(zone_name);
  }

  const whereClause = whereConditions.length > 0 ? ' AND ' + whereConditions.join(' AND ') : '';

  // 策略1: 精确匹配 record_name（用户输入短名如 api）
  let records = await db.all(
    `SELECT platform, zone_name, record_name, record_type, record_value, ttl, status FROM cloud_dns_records WHERE LOWER(record_name) = ?${whereClause}`,
    [input, ...params]
  );

  // 策略1b: 用户输入完整域名(如 api.example.com)但 record_name 存短名(api)——去掉 zone 后缀再匹配
  if (!records.length) {
    let zonesSql = 'SELECT DISTINCT zone_name FROM cloud_dns_records WHERE zone_name IS NOT NULL AND zone_name != ""';
    const zp = [];
    if (platform && platform !== 'all') { zonesSql += ' AND platform = ?'; zp.push(platform); }
    if (zone_name) { zonesSql += ' AND zone_name = ?'; zp.push(zone_name); }
    const zones = await db.all(zonesSql, zp);
    for (const z of zones) {
      const suffix = `.${z.zone_name}`.toLowerCase();
      if (input.endsWith(suffix)) {
        const shortName = input.slice(0, -suffix.length);
        if (shortName) {
          const found = await db.all(
            `SELECT platform, zone_name, record_name, record_type, record_value, ttl, status FROM cloud_dns_records WHERE LOWER(record_name) = ? AND LOWER(zone_name) = ?${whereClause}`,
            [shortName, z.zone_name.toLowerCase(), ...params]
          );
          if (found.length) { records = records.concat(found); }
        }
      }
    }
  }

  // 策略2: 输入可能不含 zone 后缀，拼接已有 zone 再匹配
  if (!records.length) {
    let zonesSql = 'SELECT DISTINCT zone_name FROM cloud_dns_records WHERE zone_name IS NOT NULL AND zone_name != ""';
    const zoneParams = [];
    if (platform && platform !== 'all') { zonesSql += ' AND platform = ?'; zoneParams.push(platform); }
    if (zone_name) { zonesSql += ' AND zone_name = ?'; zoneParams.push(zone_name); }

    const zones = await db.all(zonesSql, zoneParams);
    for (const z of zones) {
      const full = `${input}.${z.zone_name}`.toLowerCase();
      const found = await db.all(
        `SELECT platform, zone_name, record_name, record_type, record_value, ttl, status FROM cloud_dns_records WHERE LOWER(record_name) = ?${whereClause}`,
        [full, ...params]
      );
      if (found.length) { records = records.concat(found); }
    }
  }

  // 策略3: 仍无结果，做模糊匹配兜底
  if (!records.length) {
    records = await db.all(
      `SELECT platform, zone_name, record_name, record_type, record_value, ttl, status FROM cloud_dns_records WHERE LOWER(record_name) LIKE ?${whereClause}`,
      [`%${input}%`, ...params]
    );
  }

  res.json({ domain: input, found: records.length > 0, records });
});

// 获取已同步的 DNS 域名区域列表
router.get('/dns-zones', authenticate, async (req, res) => {
  const { platform } = req.query;
  let sql = 'SELECT DISTINCT platform, zone_name FROM cloud_dns_records WHERE zone_name IS NOT NULL AND zone_name != ""';
  const params = [];
  if (platform && platform !== 'all') { sql += ' AND platform = ?'; params.push(platform); }
  sql += ' ORDER BY platform, zone_name';
  const zones = await db.all(sql, params);
  res.json({ zones });
});

// IP 地址查询：调用外部服务返回归属地/ISP/AS 等公网信息
router.get('/ip-info', authenticate, async (req, res) => {
  const ip = (req.query.ip || '').trim();
  if (!ip) return res.status(400).json({ error: '请输入 IP 地址' });

  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/;
  const isIpv4 = ipv4.test(ip) && ip.split('.').every(o => Number(o) <= 255);
  const isIpv6 = ip.includes(':') && /^[0-9a-fA-F:]+$/.test(ip);
  if (!isIpv4 && !isIpv6) return res.status(400).json({ error: 'IP 地址格式不正确' });

  try {
    // 百度开放接口，国内可访问，返回“地区 + 运营商”中文归属地
    const url = `https://opendata.baidu.com/api.php?query=${encodeURIComponent(ip)}&co=&resource_id=6006&oe=utf8`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await resp.json();
    const item = data && Array.isArray(data.data) ? data.data[0] : null;
    const location = (item && item.location || '').trim();
    if (data.status !== '0' || !location) {
      return res.status(404).json({ error: '未查询到该 IP 的归属信息', ip });
    }
    res.json({ ip, location });
  } catch (e) {
    const msg = e.name === 'TimeoutError' ? '查询超时，请稍后重试' : (e.message || String(e));
    res.status(500).json({ error: '查询失败: ' + msg });
  }
});

// DNS 全球解析效果查询：用多个公共 DNS 分别解析，对比各家返回的 IP 是否一致
const PUBLIC_DNS_SERVERS = [
  // 国内
  { name: '阿里 DNS', server: '223.5.5.5', region: '中国' },
  { name: '腾讯 DNSPod', server: '119.29.29.29', region: '中国' },
  { name: '114 DNS', server: '114.114.114.114', region: '中国' },
  { name: '百度 DNS', server: '180.76.76.76', region: '中国' },
  // 海外
  { name: 'Google DNS', server: '8.8.8.8', region: '美国' },
  { name: 'Cloudflare', server: '1.1.1.1', region: '全球' },
  { name: 'OpenDNS', server: '208.67.222.222', region: '美国' },
  { name: 'Quad9', server: '9.9.9.9', region: '欧洲' },
];

router.get('/dns-nationwide', authenticate, async (req, res) => {
  const raw = (req.query.domain || '').trim();
  if (!raw) return res.status(400).json({ error: '请输入域名' });

  // 兼容用户粘贴完整 URL：去掉协议、路径、端口
  const host = raw.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].trim();
  if (!host || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    return res.status(400).json({ error: '请输入有效域名' });
  }

  const queryOne = (r) => new Promise((resolve) => {
    const resolver = new dns.Resolver();
    resolver.setServers([r.server]);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { resolver.cancel(); } catch { /* ignore */ }
      resolve({ name: r.name, server: r.server, region: r.region, ok: false, error: '解析超时' });
    }, 5000);
    resolver.resolve4(host, (err, addrs) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (err) resolve({ name: r.name, server: r.server, region: r.region, ok: false, error: err.code || err.message });
      else resolve({ name: r.name, server: r.server, region: r.region, ok: true, ips: (addrs || []).sort() });
    });
  });

  const results = await Promise.all(PUBLIC_DNS_SERVERS.map(queryOne));
  const okSigs = results.filter(x => x.ok).map(x => x.ips.join(','));
  const distinct = [...new Set(okSigs)];
  res.json({ domain: host, results, consistent: distinct.length <= 1, distinctCount: distinct.length });
});

module.exports = router;
