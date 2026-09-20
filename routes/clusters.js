const express = require('express');
const https   = require('https');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('../utils/database');
const { authenticate } = require('../middleware/auth');
const bceRequest = require('../utils/bce');
const { AWS_REGIONS, ALIYUN_REGIONS, BAIDU_REGIONS } = require('../utils/regions');

const router = express.Router();

// ── 列表 ──

router.get('/', authenticate, async (req, res) => {
  const { platform } = req.query;
  let sql = 'SELECT * FROM cloud_clusters WHERE 1=1';
  const params = [];
  if (platform && platform !== 'all') { sql += ' AND platform = ?'; params.push(platform); }
  sql += ' ORDER BY platform, cluster_name';
  const clusters = await db.all(sql, params);
  res.json({ clusters });
});

// ── 同步 ──

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
      if (p === 'aws')         remoteList = await fetchAwsClusters(cred);
      else if (p === 'aliyun') remoteList = await fetchAliyunClusters(cred);
      else if (p === 'baidu')  remoteList = await fetchBaiduClusters(cred);
    } catch (err) {
      results.push({ platform: p, success: false, message: `拉取集群失败: ${err.message}`, count: 0 });
      continue;
    }

    let written = 0;
    for (const c of remoteList) {
      try {
        await db.run(`
          INSERT INTO cloud_clusters (id, platform, cluster_id, cluster_name, region, status, k8s_version, node_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            cluster_name = VALUES(cluster_name),
            region       = VALUES(region),
            status       = VALUES(status),
            k8s_version  = VALUES(k8s_version),
            node_count   = VALUES(node_count),
            synced_at    = CURRENT_TIMESTAMP
        `, [uuidv4(), p, c.clusterId, c.clusterName, c.region || '', c.status || '', c.k8sVersion || '', c.nodeCount || 0]);
        written++;
      } catch (err) {
        console.error(`[clusters] ${p} 写入 ${c.clusterId} 失败:`, err.message);
      }
    }

    // 对账清理：删除本地存在、但云端本次未返回的集群（如已删除的集群，避免残留脏数据导致 kubeconfig 404）。
    // 仅在拉取成功（fetch 未抛错走到这里）时执行，避免拉取异常时误删。
    let pruned = 0;
    try {
      const remoteIds = remoteList.map(c => c.clusterId).filter(Boolean);
      if (remoteIds.length) {
        const placeholders = remoteIds.map(() => '?').join(',');
        const r = await db.run(
          `DELETE FROM cloud_clusters WHERE platform = ? AND cluster_id NOT IN (${placeholders})`,
          [p, ...remoteIds]
        );
        pruned = r.affectedRows || 0;
      } else {
        // 云端一个集群都没有：清空该平台本地记录
        const r = await db.run('DELETE FROM cloud_clusters WHERE platform = ?', [p]);
        pruned = r.affectedRows || 0;
      }
      if (pruned) console.log(`[clusters] ${p} 清理已删除集群 ${pruned} 个`);
    } catch (err) {
      console.error(`[clusters] ${p} 对账清理失败:`, err.message);
    }

    results.push({ platform: p, success: true, message: `同步成功${pruned ? `，清理 ${pruned} 个已删除集群` : ''}`, count: written, pruned });
  }

  res.json({ results });
});

// ── AWS EKS（所有区域并发） ──

async function fetchAwsClusters(cred) {
  const {
    EKSClient, ListClustersCommand, DescribeClusterCommand,
    ListNodegroupsCommand, DescribeNodegroupCommand
  } = require('@aws-sdk/client-eks');

  const clientFor = region => new EKSClient({
    region,
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });

  // 阶段 1：全地域并发只做轻量 ListClusters，收集 (region, name)，跳过空地域后续请求
  const listResults = await Promise.allSettled(AWS_REGIONS.map(async region => {
    const client = clientFor(region);
    const names = [];
    let nextToken;
    do {
      const res = await client.send(new ListClustersCommand({ nextToken }));
      names.push(...(res.clusters || []));
      nextToken = res.nextToken;
    } while (nextToken);
    return { region, names };
  }));

  const targets = [];  // 只保留真有集群的地域
  for (const r of listResults) {
    if (r.status === 'fulfilled') {
      for (const name of r.value.names) targets.push({ region: r.value.region, name });
    } else {
      console.warn(`[clusters/aws] region list failed: ${r.reason?.message}`);
    }
  }

  // 阶段 2：对每个集群并发查 detail + nodegroup（节点组详情也并发）
  const detailResults = await Promise.allSettled(targets.map(async ({ region, name }) => {
    const client = clientFor(region);
    let status = '', k8sVersion = '', nodeCount = 0;
    try {
      const detail = await client.send(new DescribeClusterCommand({ name }));
      status     = detail.cluster?.status  || '';
      k8sVersion = detail.cluster?.version || '';
    } catch {}
    try {
      const ngRes = await client.send(new ListNodegroupsCommand({ clusterName: name }));
      const ngDetails = await Promise.allSettled((ngRes.nodegroups || []).map(ng =>
        client.send(new DescribeNodegroupCommand({ clusterName: name, nodegroupName: ng }))
      ));
      for (const d of ngDetails) {
        if (d.status === 'fulfilled') nodeCount += d.value.nodegroup?.scalingConfig?.desiredSize || 0;
      }
    } catch {}
    return { clusterId: name, clusterName: name, region, status, k8sVersion, nodeCount };
  }));

  const allClusters = [];
  for (const r of detailResults) {
    if (r.status === 'fulfilled') allClusters.push(r.value);
    else console.warn(`[clusters/aws] cluster detail failed: ${r.reason?.message}`);
  }

  return allClusters;
}

// ── 阿里云 ACK（所有区域并发） ──

function aliyunRoaRequest(accessKey, secretKey, region, path) {
  return new Promise((resolve, reject) => {
    const date = new Date().toUTCString();
    const nonce = Math.random().toString(36).slice(2);
    const host  = `cs.${region}.aliyuncs.com`;

    const headers = {
      'accept':                  'application/json',
      'date':                    date,
      'host':                    host,
      'x-acs-signature-method':  'HMAC-SHA1',
      'x-acs-signature-nonce':   nonce,
      'x-acs-signature-version': '1.0'
    };

    const acsHeaders = Object.keys(headers)
      .filter(k => k.startsWith('x-acs-'))
      .sort()
      .map(k => `${k}:${headers[k]}`)
      .join('\n');

    const toSign = ['GET', 'application/json', '', '', date, acsHeaders, path].join('\n');
    const signature = crypto.createHmac('sha1', secretKey).update(toSign).digest('base64');
    headers['authorization'] = `acs ${accessKey}:${signature}`;

    const req = https.request({ hostname: host, path, method: 'GET', headers }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
          else reject(new Error(parsed.message || parsed.code || `HTTP ${res.statusCode}`));
        } catch {
          reject(new Error(`解析失败(${res.statusCode}): ${body.slice(0, 100)}`));
        }
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchAliyunClusters(cred) {
  // 阿里云 GET /clusters (DescribeClustersV1) 返回账号下【全部地域】的集群，
  // 只需请求一次；之前对每个地域各调一次会把全量列表重复累加 N 倍。
  const region = cred.region || (ALIYUN_REGIONS && ALIYUN_REGIONS[0]) || 'cn-hangzhou';
  const data = await aliyunRoaRequest(cred.access_key, cred.secret_key, region, '/clusters');
  const list = Array.isArray(data) ? data : (data.clusters || []);

  const seen = new Set();
  const allClusters = [];
  for (const c of list) {
    if (!c.cluster_id || seen.has(c.cluster_id)) continue;
    seen.add(c.cluster_id);
    allClusters.push({
      clusterId:   c.cluster_id,
      clusterName: c.name,
      region:      c.region_id || region,
      status:      c.state || '',
      k8sVersion:  c.current_version || '',
      nodeCount:   c.size || 0
    });
  }
  return allClusters;
}

// ── 百度云 CCE（所有区域并发） ──

async function fetchBaiduClusters(cred) {
  const allClusters = [];

  const regionResults = await Promise.allSettled(
    BAIDU_REGIONS.map(async region => {
      const cceHost = `cce.${region}.baidubce.com`;
      const res = await bceRequest(cred, 'GET', '/v2/clusters', {}, null, cceHost);
      const list = res.clusterPage?.clusterList || res.clusters || res.items || [];
      return list.map(c => {
        const spec   = c.spec   || c;
        const status = c.status || {};
        return {
          clusterId:   spec.clusterID   || c.clusterUuid || c.id,
          clusterName: spec.clusterName || c.name || '',
          region,
          status:      status.clusterPhase || status.phase || '',
          k8sVersion:  spec.k8sVersion  || '',
          nodeCount:   status.nodeNum   || 0
        };
      });
    })
  );

  for (const r of regionResults) {
    if (r.status === 'fulfilled') allClusters.push(...r.value);
    else console.warn(`[clusters/baidu] region failed: ${r.reason?.message}`);
  }

  return allClusters;
}

// ── 集群业务组管理 ────────────────────────────────────────

// GET /api/clusters/groups — 列出业务组（含关联集群数）
router.get('/groups', authenticate, async (req, res) => {
  const groups = await db.all(`
    SELECT g.*, (SELECT COUNT(*) FROM cluster_group_members m WHERE m.group_id = g.id) AS cluster_count
    FROM cluster_groups g ORDER BY g.name
  `);
  res.json({ groups });
});

// GET /api/clusters/groups/:id — 业务组详情（含关联的集群列表）
router.get('/groups/:id', authenticate, async (req, res) => {
  const group = await db.get('SELECT * FROM cluster_groups WHERE id = ?', [req.params.id]);
  if (!group) return res.status(404).json({ error: '业务组不存在' });
  const members = await db.all(`
    SELECT c.cluster_id, c.cluster_name, c.platform, c.region, c.status
    FROM cluster_group_members m JOIN cloud_clusters c ON m.cluster_id = c.cluster_id
    WHERE m.group_id = ?
  `, [group.id]);
  res.json({ group, clusters: members });
});

// POST /api/clusters/groups — 创建业务组（admin）
router.post('/groups', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { name, description, cluster_ids } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: '请填写业务组名称' });
  const id = uuidv4();
  try {
    await db.run('INSERT INTO cluster_groups (id, name, description) VALUES (?, ?, ?)', [id, name.trim(), description || '']);
    if (Array.isArray(cluster_ids)) {
      for (const cid of cluster_ids) {
        await db.run('INSERT IGNORE INTO cluster_group_members (id, group_id, cluster_id) VALUES (?, ?, ?)', [uuidv4(), id, cid]);
      }
    }
    res.status(201).json({ ok: true, id });
  } catch (e) {
    if (e.message && e.message.includes('Duplicate')) return res.status(400).json({ error: '该名称的业务组已存在' });
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/clusters/groups/:id — 更新业务组（admin）
router.put('/groups/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  const { name, description, cluster_ids } = req.body || {};
  const group = await db.get('SELECT * FROM cluster_groups WHERE id = ?', [req.params.id]);
  if (!group) return res.status(404).json({ error: '业务组不存在' });
  if (name?.trim()) await db.run('UPDATE cluster_groups SET name=?, description=? WHERE id=?', [name.trim(), description || '', group.id]);
  if (Array.isArray(cluster_ids)) {
    await db.run('DELETE FROM cluster_group_members WHERE group_id = ?', [group.id]);
    for (const cid of cluster_ids) {
      await db.run('INSERT IGNORE INTO cluster_group_members (id, group_id, cluster_id) VALUES (?, ?, ?)', [uuidv4(), group.id, cid]);
    }
  }
  res.json({ ok: true });
});

// DELETE /api/clusters/groups/:id — 删除业务组（admin）
router.delete('/groups/:id', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  await db.run('DELETE FROM cluster_group_members WHERE group_id = ?', [req.params.id]);
  await db.run('DELETE FROM cluster_groups WHERE id = ?', [req.params.id]);
  res.json({ ok: true });
});

module.exports = router;
