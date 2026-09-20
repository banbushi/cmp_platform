const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../utils/database');
const { authenticate } = require('../middleware/auth');
const bceRequest = require('../utils/bce');

const router = express.Router();

// 获取磁盘列表（本地缓存）
router.get('/disks', authenticate, async (req, res) => {
  const { platform } = req.query;
  let sql = 'SELECT * FROM cloud_disks WHERE 1=1';
  const params = [];
  if (platform && platform !== 'all') { sql += ' AND platform = ?'; params.push(platform); }
  sql += ' ORDER BY synced_at DESC';
  const disks = await db.all(sql, params);
  res.json({ disks });
});

// 同步指定平台磁盘到本地数据库
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
    try {
      if (p === 'aws')         remoteList = await fetchAwsDisks(cred);
      else if (p === 'aliyun') remoteList = await fetchAliyunDisks(cred);
      else if (p === 'baidu')  remoteList = await fetchBaiduDisks(cred);
    } catch (err) {
      results.push({ platform: p, success: false, message: err.message, count: 0 });
      continue;
    }

    let written = 0;
    for (const d of remoteList) {
      try {
        const existing = await db.get('SELECT id FROM cloud_disks WHERE platform = ? AND disk_id = ?', [p, d.diskId]);
        if (existing) {
          await db.run(
            'UPDATE cloud_disks SET disk_name=?, status=?, size_gb=?, disk_type=?, zone=?, instance_id=?, region=? WHERE id=?',
            [d.diskName, d.status, d.sizeGb, d.diskType, d.zone, d.instanceId || '', d.region || '', existing.id]
          );
        } else {
          await db.run(
            'INSERT INTO cloud_disks (id, platform, disk_id, disk_name, status, size_gb, disk_type, zone, instance_id, region) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [uuidv4(), p, d.diskId, d.diskName, d.status, d.sizeGb, d.diskType, d.zone, d.instanceId || '', d.region || '']
          );
        }
        written++;
      } catch (err) {
        console.error(`[storage] ${p} 写入 ${d.diskId} 失败:`, err.message);
      }
    }
    results.push({ platform: p, success: true, message: '同步成功', count: written });
  }

  res.json({ results });
});

// ── AWS EBS 卷 ──
async function fetchAwsDisks(cred) {
  const { EC2Client, DescribeVolumesCommand } = require('@aws-sdk/client-ec2');
  const client = new EC2Client({
    region: cred.region || 'us-east-1',
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });

  const disks = [];
  let nextToken;
  do {
    const res = await client.send(new DescribeVolumesCommand({ MaxResults: 100, NextToken: nextToken }));
    for (const v of res.Volumes || []) {
      const nameTag = (v.Tags || []).find(t => t.Key === 'Name');
      disks.push({
        diskId:     v.VolumeId,
        diskName:   nameTag?.Value || v.VolumeId,
        status:     v.State || 'unknown',
        sizeGb:     v.Size || 0,
        diskType:   v.VolumeType || '',
        zone:       v.AvailabilityZone || '',
        instanceId: (v.Attachments || [])[0]?.InstanceId || '',
        region:     cred.region || 'us-east-1'
      });
    }
    nextToken = res.NextToken;
  } while (nextToken);

  return disks;
}

// ── 阿里云磁盘 ──
async function fetchAliyunDisks(cred) {
  const Core = require('@alicloud/pop-core');
  const region = cred.region || 'cn-hangzhou';
  const client = new Core({
    accessKeyId: cred.access_key,
    accessKeySecret: cred.secret_key,
    endpoint: `https://ecs.${region}.aliyuncs.com`,
    apiVersion: '2014-05-26'
  });

  const disks = [];
  let pageNumber = 1;
  while (true) {
    const res = await client.request('DescribeDisks', { RegionId: region, PageNumber: pageNumber, PageSize: 100 }, { method: 'POST' });
    const list = res.Disks?.Disk || [];
    for (const d of list) {
      disks.push({
        diskId:     d.DiskId,
        diskName:   d.DiskName || d.DiskId,
        status:     d.Status || 'unknown',
        sizeGb:     d.Size || 0,
        diskType:   d.Category || '',
        zone:       d.ZoneId || '',
        instanceId: d.InstanceId || '',
        region
      });
    }
    if (list.length < 100) break;
    pageNumber++;
  }
  return disks;
}

// ── 百度云 CDS 云磁盘 ──
async function fetchBaiduDisks(cred) {
  const bccHost = `bcc.${cred.region || 'bj'}.baidubce.com`;
  const disks = [];
  let marker;

  do {
    const query = { maxKeys: 100 };
    if (marker) query.marker = marker;
    const res = await bceRequest(cred, 'GET', '/v2/volume', query, null, bccHost);
    for (const v of res.volumes || []) {
      const vId = v.id || v.volumeId;
      if (!vId) continue;
      disks.push({
        diskId:     vId,
        diskName:   v.name || vId,
        status:     (v.status || 'unknown').toLowerCase(),
        sizeGb:     v.diskSizeInGB || v.sizeInGB || 0,
        diskType:   v.storageType || v.type || '',
        zone:       v.zoneName || '',
        instanceId: (v.attachments || [])[0]?.instanceId || '',
        region:     cred.region || 'bj'
      });
    }
    marker = res.isTruncated ? res.nextMarker : undefined;
  } while (marker);

  return disks;
}

// ══════════════════════════════════════════════════
// 对象存储 Bucket 管理
// ══════════════════════════════════════════════════

// GET /api/storage/buckets?platform=X
router.get('/buckets', authenticate, async (req, res) => {
  const { platform } = req.query;
  let sql = 'SELECT * FROM cloud_buckets WHERE 1=1';
  const params = [];
  if (platform && platform !== 'all') { sql += ' AND platform = ?'; params.push(platform); }
  sql += ' ORDER BY name ASC';
  const buckets = await db.all(sql, params);
  res.json({ buckets });
});

// POST /api/storage/sync-buckets/:platform
router.post('/sync-buckets/:platform', authenticate, async (req, res) => {
  const { platform } = req.params;
  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  try {
    let list = [];
    if      (platform === 'aws')    list = await fetchAwsBuckets(cred);
    else if (platform === 'aliyun') list = await fetchAliyunBuckets(cred);
    else if (platform === 'baidu')  list = await fetchBaiduBuckets(cred);
    else return res.status(400).json({ error: '仅支持 aws / aliyun / baidu' });

    let count = 0;
    for (const b of list) {
      const existing = await db.get('SELECT id FROM cloud_buckets WHERE platform = ? AND name = ?', [platform, b.name]);
      if (existing) {
        await db.run('UPDATE cloud_buckets SET region=?, location=?, created_at_cloud=? WHERE id=?',
          [b.region, b.location, b.createdAt, existing.id]);
      } else {
        await db.run('INSERT INTO cloud_buckets (id, platform, name, region, location, created_at_cloud) VALUES (?,?,?,?,?,?)',
          [uuidv4(), platform, b.name, b.region, b.location, b.createdAt]);
      }
      count++;
    }
    res.json({ message: `同步完成，共 ${count} 个 Bucket`, count });
  } catch (err) {
    console.error(`[storage/buckets] ${platform} sync error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/storage/buckets  body: { platform, name, region }
router.post('/buckets', authenticate, async (req, res) => {
  const { platform, name, region } = req.body || {};
  if (!platform || !name) return res.status(400).json({ error: '缺少 platform 或 name' });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  try {
    if      (platform === 'aws')    await createAwsBucket(cred, name, region);
    else if (platform === 'aliyun') await createAliyunBucket(cred, name, region);
    else if (platform === 'baidu')  await createBaiduBucket(cred, name, region);
    else return res.status(400).json({ error: '仅支持 aws / aliyun / baidu' });

    const existing = await db.get('SELECT id FROM cloud_buckets WHERE platform = ? AND name = ?', [platform, name]);
    if (!existing) {
      await db.run('INSERT INTO cloud_buckets (id, platform, name, region, location, created_at_cloud) VALUES (?,?,?,?,?,?)',
        [uuidv4(), platform, name, region || '', region || '', new Date().toISOString()]);
    }
    res.json({ message: 'Bucket 创建成功', name });
  } catch (err) {
    console.error(`[storage/buckets] ${platform} create error:`, err.message);
    const friendly = friendlyBucketError(err, platform);
    res.status(500).json({ error: friendly });
  }
});

// ── 友好化存储桶错误信息 ──
function friendlyBucketError(err, platform) {
  const code = err.Code || err.code || err.name || '';
  const msg  = err.message || '';
  const NS = { aws: '整个 AWS S3', aliyun: '整个阿里云 OSS', baidu: '整个百度云 BOS' }[platform] || '该云平台';
  if (code === 'BucketAlreadyExists' || msg.includes('not available') || msg.includes('already exists'))
    return `Bucket 名称已被占用：${NS} 的桶名在该云内全局唯一（对所有账号共享，不同云之间互不影响）。该名称可能被其它账号占用、或删除后名称仍在保留期，即使在列表中看不到也无法复用。请换一个名称重试（如加上团队前缀或日期后缀）。`;
  if (code === 'BucketAlreadyOwnedByYou' || msg.includes('OwnedByYou'))
    return 'Bucket 已存在于您的账号下，无需重复创建';
  if (code === 'InvalidBucketName' || msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('naming'))
    return 'Bucket 名称不合法：仅允许小写字母、数字和连字符（-），长度 3~63 字符，不能以连字符开头或结尾';
  if (code === 'AuthorizationHeaderMalformed' || code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch')
    return '云平台凭据验证失败，请在"系统设置 → 云凭据"中检查 Access Key / Secret Key';
  return msg || '创建失败，请重试';
}

// ── AWS S3 ──
async function fetchAwsBuckets(cred) {
  const { S3Client, ListBucketsCommand, GetBucketLocationCommand } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    region: cred.region || 'us-east-1',
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });
  const res = await client.send(new ListBucketsCommand({}));
  const buckets = [];
  for (const b of res.Buckets || []) {
    let region = 'us-east-1';
    try {
      const loc = await client.send(new GetBucketLocationCommand({ Bucket: b.Name }));
      region = loc.LocationConstraint || 'us-east-1';
    } catch (_) {}
    buckets.push({ name: b.Name, region, location: region, createdAt: b.CreationDate?.toISOString() || '' });
  }
  return buckets;
}

async function createAwsBucket(cred, name, region) {
  const { S3Client, CreateBucketCommand } = require('@aws-sdk/client-s3');
  const r = region || cred.region || 'us-east-1';
  const client = new S3Client({
    region: r,
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });
  const params = { Bucket: name };
  if (r !== 'us-east-1') params.CreateBucketConfiguration = { LocationConstraint: r };
  await client.send(new CreateBucketCommand(params));
}

// ── 阿里云 OSS ──
async function fetchAliyunBuckets(cred) {
  const OSS = require('ali-oss');
  const client = new OSS({
    accessKeyId: cred.access_key,
    accessKeySecret: cred.secret_key,
    endpoint: 'https://oss.aliyuncs.com'
  });
  const res = await client.listBuckets({ 'max-keys': 1000 });
  return (res.buckets || []).map(b => ({
    name: b.name,
    region: b.region || '',
    location: b.location || '',
    createdAt: b.creationDate || ''
  }));
}

async function createAliyunBucket(cred, name, region) {
  const OSS = require('ali-oss');
  const r = region || cred.region || 'cn-hangzhou';
  const client = new OSS({
    accessKeyId: cred.access_key,
    accessKeySecret: cred.secret_key,
    region: r,
    endpoint: `https://oss-${r}.aliyuncs.com`
  });
  await client.putBucket(name);
}

// ── 百度云 BOS ──
async function fetchBaiduBuckets(cred) {
  const region  = cred.region || 'bj';
  const bosHost = `${region}.bcebos.com`;
  // BOS GET / 返回 JSON（不是 XML）
  const res = await bceRequest(cred, 'GET', '/', {}, null, bosHost);
  const list = res.buckets || [];
  console.log(`[bos] parsed ${list.length} bucket(s)`);
  return list.map(b => ({
    name: b.name, region: b.location || region, location: b.location || region,
    createdAt: b.creationDate || ''
  }));
}

async function createBaiduBucket(cred, name, region) {
  const r = region || cred.region || 'bj';
  const bosHost = `${r}.bcebos.com`;
  await bceRequest(cred, 'PUT', `/${name}`, {}, null, bosHost);
}

// ── Bucket 授权 ──────────────────────────────────────────────────────────────

// 获取本地用户列表（用于授权弹窗选择）
router.get('/local-users', authenticate, async (req, res) => {
  const users = await db.all(
    `SELECT id, name, email FROM users WHERE feishu_open_id IS NOT NULL OR role NOT IN ('admin', 'viewer', 'operator', 'billing') ORDER BY name ASC`
  );
  res.json({ users });
});

// 查询某 Bucket 的已授权用户列表
router.get('/bucket-grants', authenticate, async (req, res) => {
  const { platform, bucket } = req.query;
  if (!platform || !bucket) return res.status(400).json({ error: '缺少 platform 或 bucket' });
  const rows = await db.all(
    `SELECT cb.id, cb.user_id, cb.platform, cb.name as bucket,
            u.name as user_name, u.email as user_email
     FROM cloud_buckets cb
     LEFT JOIN users u ON u.id = cb.user_id
     WHERE cb.platform = ? AND cb.name = ? AND cb.user_id IS NOT NULL
     ORDER BY cb.synced_at DESC`,
    [platform, bucket]
  );
  res.json({ grants: rows });
});

/** GET /api/storage/grant-users?platform= — 返回该平台已创建或已同步的云子账号列表 */
router.get('/grant-users', authenticate, async (req, res) => {
  const { platform, userId } = req.query;
  if (!platform) return res.status(400).json({ error: '缺少 platform' });

  // 从 cloud_users（平台创建的子账号）和 cloud_synced_users（从云端同步的子账号）合并去重
  const managed = await db.all(
    "SELECT cloud_username FROM cloud_users WHERE platform = ? AND status = 'active'",
    [platform]
  );
  const synced = await db.all(
    'SELECT cloud_username FROM cloud_synced_users WHERE platform = ? AND cloud_username IS NOT NULL',
    [platform]
  );

  const seen = new Set();
  const users = [];
  for (const u of [...managed, ...synced]) {
    if (u.cloud_username && !seen.has(u.cloud_username)) {
      seen.add(u.cloud_username);
      users.push({ cloud_username: u.cloud_username });
    }
  }
  users.sort((a, b) => a.cloud_username.localeCompare(b.cloud_username));

  // 如果传入了 userId，查询该本地用户关联的云子账号列表
  if (userId) {
    const linked = await db.all(
      "SELECT cloud_username FROM cloud_users WHERE user_id = ? AND platform = ? AND status = 'active'",
      [userId, platform]
    );
    const linkedSet = new Set(linked.map(u => u.cloud_username));
    // 只返回该用户关联的云子账号
    const filtered = users.filter(u => linkedSet.has(u.cloud_username));
    return res.json({ users: filtered.length ? filtered : users });
  }

  res.json({ users });
});

/**
 * POST /api/storage/grant
 * body: {
 *   platform, bucket, path,
 *   permission: 'read' | 'readwrite' | 'existing',
 *   policyName,          // 新建策略时的策略名称
 *   existingPolicyName,  // 选用已有策略时的策略名称
 *   existingPolicyArn,   // AWS 专用
 *   cloudUsername,       // 可选：立即附加到此云用户
 * }
 */
/**
 * 创建 Bucket 策略并可选附加到云用户（核心逻辑，供路由和审批流程复用）
 * @param {string} platform - 'aws' | 'aliyun' | 'baidu'
 * @param {object} cred - platform_credentials 行
 * @param {object} opts - { bucket, path, permission, policyName, existingPolicyName, existingPolicyArn, cloudUsername }
 * @returns {{ ok: boolean, policyName: string|null, policyArn: string|null, attached: boolean, error: string|null }}
 */
async function grantBucketAccess(platform, cred, opts) {
  const { bucket, path = '*', permission, policyName,
          existingPolicyName, existingPolicyArn, cloudUsername } = opts;

  let finalPolicyArn  = existingPolicyArn  || null;
  let finalPolicyName = existingPolicyName || null;

  // 1. 如需新建策略，先生成文档并创建（若已存在则复用）
  if (permission !== 'existing') {
    if (!policyName?.trim()) return { ok: false, policyName: null, policyArn: null, attached: false, error: '请填写策略名称' };
    // 清洗策略名：AWS/阿里云允许 +=,.@_-，百度云只允许字母数字下划线
    let safeName = policyName.trim();
    if (platform === 'baidu') {
      safeName = safeName.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
    } else {
      safeName = safeName.replace(/[^a-zA-Z0-9+=,.@_-]/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
    }
    if (!safeName) return { ok: false, policyName: null, policyArn: null, attached: false, error: '策略名称包含非法字符' };
    const doc = generateBucketPolicyDoc(platform, bucket, path, permission);

    if (platform === 'aws') {
      const { IAMClient, CreatePolicyCommand, ListPoliciesCommand } = require('@aws-sdk/client-iam');
      const client = new IAMClient({
        region: cred.region || 'us-east-1',
        credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
      });
      try {
        const r = await client.send(new CreatePolicyCommand({
          PolicyName: safeName,
          PolicyDocument: doc,
          Description: `Bucket 授权：${bucket}/${path} (${permission})`
        }));
        finalPolicyArn = r.Policy.Arn;
      } catch (e) {
        if (e.name === 'EntityAlreadyExistsException' || (e.message && e.message.includes('already exists'))) {
          const listRes = await client.send(new ListPoliciesCommand({ Scope: 'Local', MaxItems: 1000 }));
          const existing = (listRes.Policies || []).find(p => p.PolicyName === safeName);
          if (existing) {
            finalPolicyArn = existing.Arn;
          } else {
            throw new Error(`策略 ${safeName} 已存在但无法获取 ARN`);
          }
        } else {
          throw e;
        }
      }
      finalPolicyName = safeName;
    } else if (platform === 'aliyun') {
      const Core = require('@alicloud/pop-core');
      const client = new Core({
        accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
        endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01'
      });
      try {
        await client.request('CreatePolicy', {
          PolicyName: safeName,
          PolicyDocument: doc,
          Description: `Bucket 授权：${bucket}/${path} (${permission})`
        }, { method: 'POST' });
      } catch (e) {
        if (!e.code || e.code !== 'EntityAlreadyExists.Policy') throw e;
      }
      finalPolicyName = safeName;
    } else if (platform === 'baidu') {
      try {
        await bceRequest(cred, 'POST', '/v1/policy', {}, {
          name: safeName,
          description: `Bucket auth ${bucket} ${permission}`,
          document: doc
        });
      } catch (e) {
        console.error('[storage/grant] baidu create policy error:', e.message);
        if (!e.message || !e.message.includes('already exist')) throw e;
      }
      finalPolicyName = safeName;
    }
  }

  // 2. 如需附加到用户
  let attached = false;
  if (cloudUsername && (finalPolicyArn || finalPolicyName)) {
    if (platform === 'aws') {
      const { IAMClient, AttachUserPolicyCommand } = require('@aws-sdk/client-iam');
      const client = new IAMClient({
        region: cred.region || 'us-east-1',
        credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
      });
      await client.send(new AttachUserPolicyCommand({ UserName: cloudUsername, PolicyArn: finalPolicyArn }));
      attached = true;
    } else if (platform === 'aliyun') {
      const Core = require('@alicloud/pop-core');
      const client = new Core({
        accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
        endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01'
      });
      await client.request('AttachPolicyToUser', {
        PolicyType: 'Custom', PolicyName: finalPolicyName, UserName: cloudUsername
      }, { method: 'POST' });
      attached = true;
    } else if (platform === 'baidu') {
      await bceRequest(cred, 'PUT', `/v1/user/${encodeURIComponent(cloudUsername)}/policy/${encodeURIComponent(finalPolicyName)}`, {}, {});
      attached = true;
    }
  }

  return { ok: true, policyName: finalPolicyName, policyArn: finalPolicyArn, attached, error: null };
}

router.post('/grant', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可操作' });

  const { platform, bucket, path, permission, policyName,
          existingPolicyName, existingPolicyArn, cloudUsername, userId } = req.body || {};
  if (!platform || !bucket || !permission) return res.status(400).json({ error: '缺少必填参数' });
  if (!cloudUsername?.trim()) return res.status(400).json({ error: 'Bucket 授权必须指定用户，请选择要授权的云账号用户' });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  try {
    const result = await grantBucketAccess(platform, cred, {
      bucket, path, permission, policyName, existingPolicyName, existingPolicyArn, cloudUsername
    });
    if (!result.ok) return res.status(400).json({ error: result.error });

    // 将授权记录写入 cloud_buckets（记录该 Bucket 已授权给指定本地用户）
    if (userId) {
      const existing = await db.get(
        'SELECT id FROM cloud_buckets WHERE platform = ? AND name = ?',
        [platform, bucket]
      );
      if (existing) {
        await db.run(
          'UPDATE cloud_buckets SET user_id = ?, synced_at = NOW() WHERE id = ?',
          [userId, existing.id]
        );
      } else {
        const bucketId = require('uuid').v4();
        await db.run(
          `INSERT INTO cloud_buckets (id, platform, name, user_id) VALUES (?, ?, ?, ?)`,
          [bucketId, platform, bucket, userId]
        );
      }
    }

    res.json({ ok: true, policyName: result.policyName, policyArn: result.policyArn, attached: result.attached });
  } catch (err) {
    console.error(`[storage/grant] ${platform} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/** 根据 platform/bucket/path/permission 生成策略文档字符串 */
function generateBucketPolicyDoc(platform, bucket, path, permission) {
  const isWrite = permission === 'readwrite';
  // path 统一处理：去掉前缀 /，末尾加 * 如果没有通配符
  const p = (path === '*' || path === '') ? '*' : path.replace(/^\//, '').replace(/\/*$/, '') + '/*';

  if (platform === 'aws') {
    const actions = ['s3:GetObject', 's3:HeadObject', 's3:GetObjectVersion'];
    if (isWrite) actions.push('s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload', 's3:PutObjectAcl');
    const resource = p === '*' ? `arn:aws:s3:::${bucket}/*` : `arn:aws:s3:::${bucket}/${p}`;
    return JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        { Effect: 'Allow', Action: actions, Resource: resource },
        { Effect: 'Allow', Action: ['s3:ListBucket', 's3:GetBucketLocation'],
          Resource: `arn:aws:s3:::${bucket}`,
          Condition: p === '*' ? undefined : { StringLike: { 's3:prefix': [p] } }
        }
      ].map(s => { if (!s.Condition) delete s.Condition; return s; })
    }, null, 2);
  }

  if (platform === 'aliyun') {
    const actions = ['oss:GetObject', 'oss:HeadObject', 'oss:GetObjectMeta'];
    if (isWrite) actions.push('oss:PutObject', 'oss:DeleteObject', 'oss:AbortMultipartUpload', 'oss:PutObjectAcl');
    const objRes = p === '*' ? `acs:oss:*:*:${bucket}/*` : `acs:oss:*:*:${bucket}/${p}`;
    return JSON.stringify({
      Version: '1',
      Statement: [
        { Effect: 'Allow', Action: actions, Resource: [objRes] },
        { Effect: 'Allow', Action: ['oss:ListObjects', 'oss:GetBucketStat', 'oss:GetBucketInfo'],
          Resource: [`acs:oss:*:*:${bucket}`] }
      ]
    }, null, 2);
  }

  if (platform === 'baidu') {
    const isWrite = permission === 'readwrite';
    const bcePerms = ['READ'];
    if (isWrite) bcePerms.push('WRITE');

    return JSON.stringify({
      accessControlList: [
        {
          service: "bce:bos",
          region: "*",
          effect: "Allow",
          resource: [bucket, `${bucket}/*`],
          permission: bcePerms
        }
      ]
    }, null, 2);
  }

  return '{}';
}

module.exports = router;
module.exports.grantBucketAccess = grantBucketAccess;
module.exports.createBucket = async function(platform, cred, name, region) {
  if      (platform === 'aws')    return createAwsBucket(cred, name, region);
  else if (platform === 'aliyun') return createAliyunBucket(cred, name, region);
  else if (platform === 'baidu')  return createBaiduBucket(cred, name, region);
  else throw new Error(`不支持的云平台：${platform}`);
};

// 检查 bucket 权限（用户提供 AK/SK，实际调用云 API 校验）
router.post('/check-permission', authenticate, async (req, res) => {
  const { platform, ak, sk, bucket, region, path } = req.body;
  if (!platform || !ak || !sk || !bucket) {
    return res.status(400).json({ error: '缺少必要参数' });
  }

  // 规范化路径前缀，与授权策略生成保持一致：非空路径统一按目录处理（补尾部 /），
  // 使 test 与 test/ 等价，避免"填 test/ 有权限、填 test 无权限"的困惑
  let prefix = path ? path.replace(/^\/+/, '').replace(/\/+$/, '') : '';
  if (prefix) prefix += '/';

  try {
    let readable = false;
    let writable = false;
    let readError = null;
    let writeError = null;

    if (platform === 'aws') {
      const { S3Client, HeadBucketCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
      const client = new S3Client({
        region: region || 'us-east-1',
        credentials: { accessKeyId: ak, secretAccessKey: sk }
      });

      // 测试读权限
      try {
        if (prefix) {
          await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }));
        } else {
          await client.send(new HeadBucketCommand({ Bucket: bucket }));
        }
        readable = true;
      } catch (e) {
        readError = e.message;
      }

      // 测试写权限
      try {
        const testKey = `${prefix}.perm-check-${Date.now()}.txt`;
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: testKey, Body: 'permission test' }));
        writable = true;
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: testKey })).catch(() => {});
      } catch (e) {
        writeError = e.message;
      }

    } else if (platform === 'aliyun') {
      const OSS = require('ali-oss');
      // OSS region 需带 oss- 前缀，容错用户只填 cn-beijing 的情况
      let ossRegion = region || 'oss-cn-beijing';
      if (ossRegion && !/^oss-/.test(ossRegion)) ossRegion = `oss-${ossRegion}`;
      const client = new OSS({
        region: ossRegion,
        accessKeyId: ak,
        accessKeySecret: sk,
        bucket
      });

      // 测试读权限
      try {
        if (prefix) {
          await client.list({ prefix, 'max-keys': 1 });
        } else {
          await client.getBucketInfo(bucket);
        }
        readable = true;
      } catch (e) {
        readError = e.message;
      }

      // 测试写权限
      try {
        const testKey = `${prefix}.perm-check-${Date.now()}.txt`;
        await client.put(testKey, Buffer.from('permission test'));
        writable = true;
        await client.delete(testKey).catch(() => {});
      } catch (e) {
        writeError = e.message;
      }

    } else if (platform === 'baidu') {
      const BosClient = require('@baiducloud/sdk').BosClient;
      const config = {
        endpoint: `https://${region || 'bj'}.bcebos.com`,
        credentials: { ak, sk }
      };
      const client = new BosClient(config);

      // 测试读权限
      try {
        if (prefix) {
          await client.listObjects(bucket, { prefix, maxKeys: 1 });
        } else {
          await client.headBucket(bucket);
        }
        readable = true;
      } catch (e) {
        readError = e.message;
      }

      // 测试写权限
      try {
        const testKey = `${prefix}.perm-check-${Date.now()}.txt`;
        await client.putObjectFromString(bucket, testKey, 'permission test');
        writable = true;
        await client.deleteObject(bucket, testKey).catch(() => {});
      } catch (e) {
        writeError = e.message;
      }

    } else {
      return res.status(400).json({ error: '不支持的云平台' });
    }

    res.json({
      readable, writable, bucket, platform,
      path: prefix || undefined,
      readError: readError || undefined,
      writeError: writeError || undefined,
      // 兼容旧字段：汇总一条错误信息
      error: (readError || writeError) || undefined
    });

  } catch (e) {
    res.status(500).json({ error: e.message, readable: false, writable: false });
  }
});

module.exports.friendlyBucketError = friendlyBucketError;
