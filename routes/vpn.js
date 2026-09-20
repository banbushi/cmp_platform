const express = require('express');
const crypto  = require('crypto');
const db = require('../utils/database');
const { authenticate } = require('../middleware/auth');
const bceRequest = require('../utils/bce');

const router = express.Router();

// ── POST /api/vpn/sync/:platform ── 同步云端已有的 VPN 客户端到本地
router.post('/sync/:platform', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '仅管理员可操作' });
  }

  const { platform } = req.params;
  if (platform !== 'aliyun' && platform !== 'baidu') {
    return res.status(400).json({ error: '仅支持阿里云和百度云' });
  }

  const cred = await db.get(
    'SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1',
    [platform]
  );
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  try {
    console.log(`[vpn/sync] ${platform} 开始同步...`);
    let clients = [];
    let fetchOk = false;
    if (platform === 'aliyun') {
      ({ clients, fetchOk } = await syncAliyunVpnClients(cred));
    } else if (platform === 'baidu') {
      ({ clients, fetchOk } = await syncBaiduVpnClients(cred));
    }
    console.log(`[vpn/sync] ${platform} 获取到 ${clients.length} 个客户端 (fetchOk=${fetchOk})`);

    // UPSERT 到数据库
    let upserted = 0;
    for (const c of clients) {
      await db.run(`
        INSERT INTO vpn_clients (id, platform, server_id, server_name, client_id, client_name, region, notes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          server_name = VALUES(server_name),
          client_name = VALUES(client_name),
          region = VALUES(region),
          notes = VALUES(notes)
      `, [
        crypto.randomUUID(),
        c.platform,
        c.server_id,
        c.server_name || '',
        c.client_id,
        c.client_name,
        c.region || '',
        c.notes || null
      ]);
      upserted++;
    }

    // 对账清理：删除本地存在、但云端本次已不返回的记录（如换 AK/SK 后的旧账号残留）。
    // 仅在拉取可靠（所有区域/网关都成功）时执行，避免网络抖动导致误删。
    let pruned = 0;
    if (fetchOk) {
      const cloudIds = clients.map(c => c.client_id).filter(Boolean);
      if (cloudIds.length) {
        const placeholders = cloudIds.map(() => '?').join(',');
        const r = await db.run(
          `DELETE FROM vpn_clients WHERE platform = ? AND client_id NOT IN (${placeholders})`,
          [platform, ...cloudIds]
        );
        pruned = r.affectedRows || 0;
      } else {
        // 云端一个客户端都没有：清空该平台本地记录
        const r = await db.run('DELETE FROM vpn_clients WHERE platform = ?', [platform]);
        pruned = r.affectedRows || 0;
      }
      if (pruned) console.log(`[vpn/sync] ${platform} 清理旧记录 ${pruned} 条`);
    } else {
      console.warn(`[vpn/sync] ${platform} 拉取不完整，跳过清理以防误删`);
    }

    console.log(`[vpn/sync] ${platform} 完成，写入 ${upserted} 条，清理 ${pruned} 条`);
    res.json({
      success: true,
      results: clients,
      pruned,
      message: `同步完成，共 ${clients.length} 个客户端${pruned ? `，清理旧记录 ${pruned} 条` : ''}${fetchOk ? '' : '（部分区域拉取失败，未清理旧数据）'}`
    });
  } catch (err) {
    console.error(`[vpn/sync] ${platform} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/vpn/servers?platform=aliyun|baidu&region=xxx ──
router.get('/servers', authenticate, async (req, res) => {
  const { platform, region } = req.query;
  if (!platform) return res.status(400).json({ error: '缺少 platform 参数' });

  const cred = await db.get(
    'SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1',
    [platform]
  );
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  try {
    let servers = [];
    if (platform === 'aliyun')     servers = await fetchAliyunVpnServers(cred);
    else if (platform === 'baidu') servers = await fetchBaiduVpnServers(cred);
    else return res.status(400).json({ error: '仅支持阿里云和百度云' });
    if (region) {
      servers = servers.filter(s => String(s.region || '').trim() === String(region).trim());
    }
    res.json({ servers });
  } catch (err) {
    console.error(`[vpn/servers] ${platform} error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/vpn/ssl-users?platform=baidu ── 诊断：列出云端 SSL VPN 用户
router.get('/ssl-users', authenticate, async (req, res) => {
  const { platform } = req.query;
  if (platform !== 'baidu') return res.status(400).json({ error: '仅支持 baidu' });

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: '未配置凭据' });

  const region  = normBaiduRegion(cred.region || 'bj');
  const bccHost = `bcc.${region}.baidubce.com`;

  const results = {};
  try {
    // 获取 VPN 网关
    const vpcRes = await bceRequest(cred, 'GET', '/v1/vpc', {}, null, bccHost);
    const vpcs = vpcRes.vpcs || vpcRes.items || [];
    for (const vpc of vpcs) {
      const vpcId = vpc.vpcId || vpc.id;
      const vpnRes = await bceRequest(cred, 'GET', '/v1/vpn', { vpcId }, null, bccHost);
      const gws = vpnRes.vpns || vpnRes.vpnGateways || vpnRes.items || [];
      for (const gw of gws) {
        const vpnId = gw.vpnId || gw.id;
        // 获取 SSL VPN 服务端
        try {
          const sr = await bceRequest(cred, 'GET', `/v1/vpn/${vpnId}/sslVpnServer`, {}, null, bccHost);
          const sslId = sr.sslVpnServerId;
          results[vpnId] = { sslVpnServer: sr };
          // 获取 SSL 用户（尝试多路径）
          for (const p of [
            `/v1/vpn/${vpnId}/sslVpnServer/${sslId}/sslVpnUser`,
            `/v1/vpn/${vpnId}/sslVpnUser`
          ]) {
            try {
              const ur = await bceRequest(cred, 'GET', p, {}, null, bccHost);
              results[vpnId][`users@${p}`] = ur;
            } catch (e) {
              results[vpnId][`users@${p}`] = `ERROR: ${e.message}`;
            }
          }
        } catch (e) {
          results[vpnId] = { error: e.message };
        }
      }
    }
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/vpn/raw-test?platform=aliyun|baidu ──
// 调试用：直接返回云端原始响应，不做任何处理
router.get('/raw-test', authenticate, async (req, res) => {
  const { platform } = req.query;
  if (!platform) return res.status(400).json({ error: '缺少 platform 参数' });

  const cred = await db.get(
    'SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1',
    [platform]
  );
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  if (platform === 'baidu') {
    const region  = normBaiduRegion(cred.region || 'bj');
    const bccHost = `bcc.${region}.baidubce.com`;
    // 并发探测几个可能的路径
    const candidates = ['/v2/vpnGateway', '/v2/vpn', '/v1/vpnGateway', '/v1/vpn'];
    const results = {};
    await Promise.allSettled(candidates.map(async path => {
      try {
        const raw = await bceRequest(cred, 'GET', path, {}, null, bccHost);
        results[path] = { status: 'ok', keys: Object.keys(raw), raw };
      } catch (e) {
        results[path] = { status: 'error', error: e.message };
      }
    }));
    res.json({ host: bccHost, region, results });

  } else if (platform === 'aliyun') {
    const Core = require('@alicloud/pop-core');
    const credRegion = cred.region || 'cn-hangzhou';
    const regions = [credRegion, ...ALIYUN_VPN_REGIONS.filter(r => r !== credRegion)];
    const results = {};
    await Promise.allSettled(regions.map(async region => {
      const client = new Core({
        accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
        endpoint: `https://vpc.${region}.aliyuncs.com`, apiVersion: '2016-04-28'
      });
      try {
        const r = await client.request('DescribeSslVpnServers', { RegionId: region, PageSize: 50 }, { method: 'POST' });
        results[region] = { count: (r.SslVpnServers?.SslVpnServer || []).length, raw: r };
      } catch (e) {
        results[region] = { error: e.message };
      }
    }));
    res.json({ results });
  } else {
    res.status(400).json({ error: '仅支持 aliyun / baidu' });
  }
});

// ── POST /api/vpn/clients ──
// body: { platform, serverId, serverName, clientName, password?, region?, notes? }
router.post('/clients', authenticate, async (req, res) => {
  const { platform, serverId, serverName, clientName, password, region, notes } = req.body || {};
  if (!platform || !serverId || !clientName) {
    return res.status(400).json({ error: '缺少必填字段: platform / serverId / clientName' });
  }
  if (platform === 'baidu' && !password) {
    return res.status(400).json({ error: '百度云 VPN 客户端必须填写密码' });
  }

  const cred = await db.get(
    'SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1',
    [platform]
  );
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  try {
    let clientId = '';
    let clientRegion = (region || '').trim();

    if (platform === 'aliyun') {
      clientId = await createAliyunVpnClient(cred, serverId, clientName, clientRegion || undefined);
      clientRegion = clientRegion || cred.region || '';
    } else if (platform === 'baidu') {
      clientId = await createBaiduVpnClient(cred, serverId, clientName, password, notes || '');
      clientRegion = clientRegion || normBaiduRegion(cred.region || 'bj');
    } else {
      return res.status(400).json({ error: '仅支持阿里云和百度云' });
    }

    const id = crypto.randomUUID();
    await db.run(
      'INSERT INTO vpn_clients (id, platform, server_id, server_name, client_id, client_name, region, notes) VALUES (?,?,?,?,?,?,?,?)',
      [id, platform, serverId, serverName || '', clientId, clientName, clientRegion, notes || null]
    );

    const client = { id, platform, server_id: serverId, server_name: serverName || '', client_id: clientId, client_name: clientName, region: clientRegion, notes: notes || null, created_at: new Date() };
    res.json({ client });
  } catch (err) {
    console.error(`[vpn/clients] create error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/vpn/clients?platform=X ──
router.get('/clients', authenticate, async (req, res) => {
  const { platform } = req.query;
  let sql = 'SELECT * FROM vpn_clients';
  const params = [];
  if (platform && platform !== 'all') {
    sql += ' WHERE platform = ?';
    params.push(platform);
  }
  sql += ' ORDER BY created_at DESC';
  const clients = await db.all(sql, params);
  res.json({ clients });
});

// ── PUT /api/vpn/clients/:id ── 更新备注 / clientName（同步到云端）
router.put('/clients/:id', authenticate, async (req, res) => {
  const { notes, clientName } = req.body || {};
  const client = await db.get('SELECT * FROM vpn_clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: '记录不存在' });

  // 构造 DB 更新（只更新传入的字段）
  const updates = [];
  const vals    = [];
  if (notes     !== undefined) { updates.push('notes = ?');       vals.push(notes || null); }
  if (clientName !== undefined) { updates.push('client_name = ?'); vals.push(clientName);   }
  if (updates.length) {
    vals.push(req.params.id);
    await db.run(`UPDATE vpn_clients SET ${updates.join(', ')} WHERE id = ?`, vals);
  }

  // 同步到百度云（best-effort）
  if (client.platform === 'baidu' && client.client_id) {
    const cred = await db.get(
      'SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', ['baidu']
    );
    if (cred) {
      try {
        const region  = normBaiduRegion(cred.region || 'bj');
        const bccHost = `bcc.${region}.baidubce.com`;
        const vpnId   = client.server_id.includes('|') ? client.server_id.split('|')[0] : client.server_id;
        const body = {};
        if (notes      !== undefined) body.description = notes || '';
        if (clientName !== undefined) body.clientName  = clientName;
        if (Object.keys(body).length) {
          await bceRequest(cred, 'PUT', `/v1/vpn/${vpnId}/sslVpnUser/${client.client_id}`,
            {}, body, bccHost);
          console.log(`[vpn/baidu] updated ${Object.keys(body).join('+')} for ${client.client_id}`);
        }
      } catch (e) {
        console.warn(`[vpn/update] cloud sync failed (ignored): ${e.message}`);
      }
    }
  }

  res.json({ message: '更新成功' });
});

// ── DELETE /api/vpn/clients/:id ──
router.delete('/clients/:id', authenticate, async (req, res) => {
  const client = await db.get('SELECT * FROM vpn_clients WHERE id = ?', [req.params.id]);
  if (!client) return res.status(404).json({ error: '记录不存在' });

  const cred = await db.get(
    'SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1',
    [client.platform]
  );

  // 尝试从云端删除（best-effort，失败不影响 DB 删除）
  let cloudDeleted = false;
  if (cred && client.client_id) {
    try {
      if (client.platform === 'aliyun') {
        await deleteAliyunVpnClient(cred, client.client_id);
      } else if (client.platform === 'baidu') {
        await deleteBaiduVpnClient(cred, client.server_id, client.client_id);
      }
      cloudDeleted = true;
    } catch (e) {
      console.warn(`[vpn/delete] cloud delete failed (ignored): ${e.message}`);
    }
  }

  await db.run('DELETE FROM vpn_clients WHERE id = ?', [req.params.id]);
  res.json({ message: '删除成功', cloud_deleted: cloudDeleted });
});

// ── 阿里云：拉取 SSL VPN 服务器列表（动态区域 + 兜底列表）──
const ALIYUN_VPN_REGIONS = [
  'cn-hangzhou', 'cn-shanghai', 'cn-beijing', 'cn-shenzhen',
  'cn-chengdu', 'cn-hongkong', 'cn-zhangjiakou', 'cn-qingdao',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-5',
  'ap-northeast-1', 'ap-south-1', 'eu-central-1', 'eu-west-1',
  'us-east-1', 'us-west-1'
];

function createAliyunVpcClient(cred, region) {
  const Core = require('@alicloud/pop-core');
  return new Core({
    accessKeyId:     cred.access_key,
    accessKeySecret: cred.secret_key,
    endpoint: `https://vpc.${region}.aliyuncs.com`,
    apiVersion: '2016-04-28'
  });
}

async function getAliyunVpnRegions(cred) {
  const credRegion = cred.region || 'cn-hangzhou';
  const fallbackRegions = [...new Set([credRegion, ...ALIYUN_VPN_REGIONS].filter(Boolean))];

  try {
    const client = createAliyunVpcClient(cred, credRegion);
    const res = await client.request('DescribeRegions', {}, { method: 'POST' });
    const dynamicRegions = (res.Regions?.Region || [])
      .map(r => r.RegionId)
      .filter(Boolean);
    return [...new Set([credRegion, ...dynamicRegions, ...fallbackRegions])];
  } catch (e) {
    console.warn(`[vpn/aliyun] DescribeRegions failed, fallback to preset regions: ${e.message}`);
    return fallbackRegions;
  }
}

async function fetchAliyunVpnServers(cred) {
  const regions = await getAliyunVpnRegions(cred);

  const results = await Promise.allSettled(regions.map(async region => {
    const client = createAliyunVpcClient(cred, region);
    const res = await client.request('DescribeSslVpnServers', { RegionId: region, PageSize: 50 }, { method: 'POST' });
    const list = res.SslVpnServers?.SslVpnServer || [];
    return list.map(s => ({
      id:     s.SslVpnServerId,
      name:   s.Name ? `${s.Name}（${region}）` : `${s.SslVpnServerId}（${region}）`,
      region
    }));
  }));

  const servers = [];
  const errors = [];
  let fulfilledCount = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      fulfilledCount += 1;
      servers.push(...r.value);
    } else {
      errors.push(`${regions[i]}: ${r.reason?.message || 'unknown error'}`);
    }
  }

  if (fulfilledCount === 0) {
    const sample = errors.slice(0, 3).join(' | ');
    throw new Error(`阿里云 VPN 查询失败：全部地域请求都报错。${sample ? `示例错误：${sample}` : ''}`);
  }

  return dedupVpnServers(servers);
}

// ── 阿里云：创建 SSL VPN 客户端证书 ──
async function createAliyunVpnClient(cred, sslVpnServerId, name, preferredRegion) {
  // serverId 格式: "vss-xxx"；从数据库服务器列表中选择时已包含正确值
  // 需要先反查该 server 所在区域；简化处理：遍历常用区域找到匹配的
  const regionsFromApi = await getAliyunVpnRegions(cred);
  const ordered = [preferredRegion, ...regionsFromApi];
  const regions = [...new Set(ordered.filter(Boolean))];

  for (const region of regions) {
    try {
      const client = createAliyunVpcClient(cred, region);
      const res = await client.request('CreateSslVpnClientCert', {
        RegionId:       region,
        SslVpnServerId: sslVpnServerId,
        Name:           name
      }, { method: 'POST' });
      if (res.SslVpnClientCertId) return res.SslVpnClientCertId;
    } catch (e) {
      // 该区域找不到此 server，继续试下一个
      continue;
    }
  }
  throw new Error(`未能在任何区域找到 SSL VPN 服务器 ${sslVpnServerId}`);
}

// ── 百度云：拉取 SSL VPN 服务端列表 ──
// 层级：VPC → VPN 网关 → SSL VPN 服务端
// 下拉显示 SSL VPN 服务端，value 编码为 "{vpnId}|{sslServerId}"
async function fetchBaiduVpnServers(cred) {
  const region  = normBaiduRegion(cred.region || 'bj');
  const bccHost = `bcc.${region}.baidubce.com`;

  // ① 获取 VPC 列表
  const vpcRes = await bceRequest(cred, 'GET', '/v1/vpc', {}, null, bccHost);
  const vpcs   = vpcRes.vpcs || vpcRes.items || [];
  console.log(`[vpn/baidu] found ${vpcs.length} VPC(s)`);
  if (!vpcs.length) return [];

  // ② 获取每个 VPC 下的 VPN 网关
  const gatewayResults = await Promise.allSettled(vpcs.map(async vpc => {
    const vpcId = vpc.vpcId || vpc.id;
    const r = await bceRequest(cred, 'GET', '/v1/vpn', { vpcId }, null, bccHost);
    return r.vpns || r.vpnGateways || r.items || [];
  }));

  const gateways = [];
  for (const r of gatewayResults) {
    if (r.status === 'fulfilled') gateways.push(...r.value);
  }
  console.log(`[vpn/baidu] found ${gateways.length} VPN gateway(s)`);
  if (!gateways.length) return [];

  // ③ 获取每个网关下的 SSL VPN 服务端
  const sslPaths = ['/v1/vpn/{vpnId}/sslServer', '/v1/vpn/{vpnId}/sslVpnServer'];
  const servers  = [];

  for (const gw of gateways) {
    const vpnId = gw.vpnId || gw.id;
    for (const pathTpl of sslPaths) {
      const path = pathTpl.replace('{vpnId}', vpnId);
      try {
        const r = await bceRequest(cred, 'GET', path, {}, null, bccHost);
        console.log(`[vpn/baidu] ${path} raw keys:`, Object.keys(r));

        // 响应可能是单个对象（直接含 sslVpnServerId）或数组包装
        let list = [];
        if (r.sslVpnServerId) {
          // 单对象：直接就是 SSL VPN 服务端
          list = [r];
        } else {
          list = r.sslServers || r.sslVpnServers || r.sslVpnServerList || r.items || [];
        }

        console.log(`[vpn/baidu] ${path} → ${list.length} ssl server(s)`);
        for (const s of list) {
          const sslId = s.sslVpnServerId || s.sslServerId || s.id;
          servers.push({
            // value 编码：vpnId|sslServerId，创建时解析
            id:     `${vpnId}|${sslId}`,
            name:   s.sslVpnServerName || s.name || sslId,
            region
          });
        }
        break; // 找到可用路径就跳出 path 循环
      } catch (e) {
        console.log(`[vpn/baidu] ${path} failed: ${e.message}`);
      }
    }
  }

  // 如果没有 SSL VPN 服务端，退回显示 VPN 网关（兼容）
  if (!servers.length) {
    console.log('[vpn/baidu] no ssl servers found, falling back to gateways');
    return gateways.map(gw => ({
      id:   gw.vpnId || gw.id,
      name: gw.name || gw.vpnId || gw.id,
      region
    }));
  }

  return servers;
}

// ── 百度云：在指定 SSL VPN 服务端下创建用户 ──
async function createBaiduVpnClient(cred, serverId, userName, password, description) {
  const region      = normBaiduRegion(cred.region || 'bj');
  const bccHost     = `bcc.${region}.baidubce.com`;
  const clientToken = crypto.randomUUID().replace(/-/g, '');

  // serverId 格式："{vpnId}|{sslServerId}"（fetchBaiduVpnServers 编码）
  const vpnId = serverId.includes('|') ? serverId.split('|')[0] : serverId;

  const userEntry = { userName, password };
  if (description) userEntry.description = description;

  try {
    // 百度 VPN SSL 用户创建：POST /v1/vpn/{vpnId}/sslVpnUser
    const res = await bceRequest(
      cred, 'POST', `/v1/vpn/${vpnId}/sslVpnUser`,
      { clientToken }, { sslVpnUsers: [userEntry] }, bccHost
    );
    console.log(`[vpn/baidu] create ssl user OK, keys: ${Object.keys(res)}, ids: ${JSON.stringify(res.sslVpnUserIds)}`);
    return (res.sslVpnUserIds || [])[0] || '';
  } catch (e) {
    console.error(`[vpn/baidu] create ssl user FAILED: ${e.message}`);
    if (e.message && (e.message.includes('already exist') || e.message.includes('AlreadyExist') || e.message.includes('Duplicated') || e.message.includes('already been bindded') || e.message.includes('already'))) {
      throw new Error(`VPN 用户 ${userName} 已存在，无需重复创建`);
    }
    throw e;
  }
}

// ── 阿里云：删除 SSL VPN 客户端证书 ──
async function deleteAliyunVpnClient(cred, certId) {
  const regions = await getAliyunVpnRegions(cred);
  for (const region of regions) {
    try {
      const client = createAliyunVpcClient(cred, region);
      await client.request('DeleteSslVpnClientCert', { RegionId: region, SslVpnClientCertId: certId }, { method: 'POST' });
      return;
    } catch (e) { continue; }
  }
}

function dedupVpnServers(servers) {
  const seen = new Set();
  const deduped = [];
  for (const s of servers) {
    const key = `${s.region || ''}:${s.id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(s);
  }
  return deduped;
}

// ── 百度云：删除 SSL VPN 用户 ──
async function deleteBaiduVpnClient(cred, serverId, clientId) {
  const region  = normBaiduRegion(cred.region || 'bj');
  const bccHost = `bcc.${region}.baidubce.com`;
  // serverId 可能是 "vpnId|sslServerId" 或纯 vpnId
  const vpnId = serverId.includes('|') ? serverId.split('|')[0] : serverId;
  await bceRequest(cred, 'DELETE', `/v1/vpn/${vpnId}/sslVpnUser/${clientId}`, {}, null, bccHost);
}

// 将各种格式的百度区域码统一为 BCE 短码 (bj / gz / su / ...)
function normBaiduRegion(region) {
  const map = {
    'cn-bj':       'bj',
    'cn-gz':       'gz',
    'cn-su':       'su',
    'cn-bd':       'bd',
    'cn-hkg':      'hkg',
    'cn-fwh':      'fwh',
    'cn-cd':       'cd',
    'cn-sin':      'sin',
    'bj':  'bj', 'gz':  'gz', 'su':  'su', 'hkg': 'hkg',
    'fwh': 'fwh', 'bd': 'bd', 'cd':  'cd', 'sin': 'sin'
  };
  return map[region] || region;
}

// ── 阿里云：同步所有 SSL VPN 客户端证书 ──
async function syncAliyunVpnClients(cred) {
  const regions = await getAliyunVpnRegions(cred);
  const clients = [];
  let fetchOk = true;
  let serverFulfilled = 0;

  console.log(`[vpn/sync/aliyun] 扫描 ${regions.length} 个区域: ${regions.join(', ')}`);

  // 并发拉取所有区域的 SSL VPN 服务器
  const serverResults = await Promise.allSettled(regions.map(async region => {
    const client = createAliyunVpcClient(cred, region);
    const res = await client.request('DescribeSslVpnServers', {
      RegionId: region, PageSize: 50
    }, { method: 'POST' });
    return { region, servers: res.SslVpnServers?.SslVpnServer || [] };
  }));

  // 收集所有 (region, server) 对
  const serverList = [];
  for (let i = 0; i < serverResults.length; i++) {
    const r = serverResults[i];
    if (r.status === 'fulfilled') {
      serverFulfilled += 1;
      if (r.value.servers.length) {
        console.log(`[vpn/sync/aliyun] ${r.value.region} → ${r.value.servers.length} 个 SSL VPN server`);
      }
      for (const server of r.value.servers) {
        serverList.push({ region: r.value.region, server });
      }
    } else {
      // 某个区域拉取失败 → 结果不完整，禁止清理
      fetchOk = false;
      console.warn(`[vpn/sync/aliyun] ${regions[i]} server 拉取失败: ${r.reason?.message}`);
    }
  }

  // 所有区域都失败：拉不到任何 server，明确报错而不是静默返回空
  if (serverFulfilled === 0) {
    throw new Error('阿里云 VPN 同步失败：全部区域 DescribeSslVpnServers 都报错，请检查 AK/SK 权限');
  }

  console.log(`[vpn/sync/aliyun] 共找到 ${serverList.length} 个 SSL VPN server`);
  if (!serverList.length) return { clients, fetchOk };

  // 并发拉取所有服务器的客户端证书
  const certResults = await Promise.allSettled(serverList.map(async ({ region, server }) => {
    const client = createAliyunVpcClient(cred, region);
    const certsRes = await client.request('DescribeSslVpnClientCerts', {
      RegionId: region,
      SslVpnServerId: server.SslVpnServerId,
      PageSize: 50
    }, { method: 'POST' });
    // 阿里云返回字段为 SslVpnClientCertKeys.SslVpnClientCertKey（非 SslVpnClientCerts.SslVpnClientCert）
    const certs = certsRes.SslVpnClientCertKeys?.SslVpnClientCertKey
               || certsRes.SslVpnClientCerts?.SslVpnClientCert
               || [];
    console.log(`[vpn/sync/aliyun] server ${server.SslVpnServerId}（${region}）→ ${certs.length} 个客户端证书`);
    return certs.map(cert => ({
      platform: 'aliyun',
      server_id: server.SslVpnServerId,
      server_name: server.Name ? `${server.Name}（${region}）` : `${server.SslVpnServerId}（${region}）`,
      client_id: cert.SslVpnClientCertId,
      client_name: cert.Name || cert.SslVpnClientCertId,
      region,
      notes: null
    }));
  }));

  for (let i = 0; i < certResults.length; i++) {
    const r = certResults[i];
    if (r.status === 'fulfilled') clients.push(...r.value);
    else {
      fetchOk = false;
      const s = serverList[i];
      console.warn(`[vpn/sync/aliyun] server ${s.server.SslVpnServerId}（${s.region}）证书拉取失败: ${r.reason?.message}`);
    }
  }

  console.log(`[vpn/sync/aliyun] 汇总 ${clients.length} 个客户端证书 (fetchOk=${fetchOk})`);
  return { clients, fetchOk };
}

// ── 百度云：同步所有 SSL VPN 用户 ──
async function syncBaiduVpnClients(cred) {
  const region = normBaiduRegion(cred.region || 'bj');
  const bccHost = `bcc.${region}.baidubce.com`;
  const clients = [];
  let fetchOk = true;

  // ① 获取 VPC 列表
  const vpcRes = await bceRequest(cred, 'GET', '/v1/vpc', {}, null, bccHost);
  const vpcs = vpcRes.vpcs || vpcRes.items || [];

  // ② 获取每个 VPC 下的 VPN 网关
  for (const vpc of vpcs) {
    const vpcId = vpc.vpcId || vpc.id;
    try {
      const vpnRes = await bceRequest(cred, 'GET', '/v1/vpn', { vpcId }, null, bccHost);
      const gateways = vpnRes.vpns || vpnRes.vpnGateways || vpnRes.items || [];

      // ③ 获取每个网关下的 SSL VPN 服务端和用户
      for (const gw of gateways) {
        const vpnId = gw.vpnId || gw.id;

        // 尝试获取 SSL VPN 服务端
        const sslPaths = ['/v1/vpn/{vpnId}/sslServer', '/v1/vpn/{vpnId}/sslVpnServer'];
        let sslServers = [];

        for (const pathTpl of sslPaths) {
          const path = pathTpl.replace('{vpnId}', vpnId);
          try {
            const r = await bceRequest(cred, 'GET', path, {}, null, bccHost);
            if (r.sslVpnServerId) {
              sslServers = [r];
            } else {
              sslServers = r.sslServers || r.sslVpnServers || r.sslVpnServerList || r.items || [];
            }
            if (sslServers.length) break;
          } catch (e) {
            continue;
          }
        }

        // ④ 获取每个 SSL 服务端下的用户
        for (const sslServer of sslServers) {
          const sslId = sslServer.sslVpnServerId || sslServer.sslServerId || sslServer.id;
          const serverName = sslServer.sslVpnServerName || sslServer.name || sslId;

          // 尝试多个可能的用户列表路径
          const userPaths = [
            `/v1/vpn/${vpnId}/sslVpnServer/${sslId}/sslVpnUser`,
            `/v1/vpn/${vpnId}/sslVpnUser`
          ];

          for (const userPath of userPaths) {
            try {
              const usersRes = await bceRequest(cred, 'GET', userPath, {}, null, bccHost);
              const users = usersRes.sslVpnUsers || usersRes.users || usersRes.items || [];

              for (const user of users) {
                clients.push({
                  platform: 'baidu',
                  server_id: `${vpnId}|${sslId}`,
                  server_name: serverName,
                  client_id: user.userId || user.sslVpnUserId || user.id,
                  client_name: user.userName || user.name || user.userId,
                  region: region,
                  notes: user.description || null
                });
              }

              if (users.length) break; // 找到用户就跳出路径循环
            } catch (e) {
              console.warn(`[vpn/sync/baidu] ${userPath} failed: ${e.message}`);
            }
          }
        }
      }
    } catch (e) {
      fetchOk = false;
      console.warn(`[vpn/sync/baidu] skip vpc ${vpcId}: ${e.message}`);
    }
  }

  return { clients, fetchOk };
}

/** 供审批流调用：创建 VPN 客户端，返回 { success, clientId, message } */
async function createVpnClient(platform, cred, serverId, clientName, password, notes, region) {
  try {
    let clientId = '';
    if (platform === 'aliyun') {
      clientId = await createAliyunVpnClient(cred, serverId, clientName, region || undefined);
    } else if (platform === 'baidu') {
      clientId = await createBaiduVpnClient(cred, serverId, clientName, password || '', notes || '');
    } else {
      throw new Error('仅支持阿里云和百度云 VPN');
    }
    return { success: true, clientId, message: 'VPN 客户端创建成功' };
  } catch (e) {
    return { success: false, clientId: '', message: e.message };
  }
}

async function updateVpnClientPassword(platform, cred, clientName, newPassword) {
  if (platform === 'baidu') {
    const region = normBaiduRegion(cred.region || 'bj');
    const bccHost = `bcc.${region}.baidubce.com`;

    // 从 vpn_clients 表找到 client_id 和 server_id
    const client = await db.get(
      'SELECT client_id, server_id FROM vpn_clients WHERE platform = ? AND client_name = ?',
      [platform, clientName]
    );
    if (!client) return { success: false, message: `VPN 客户端 ${clientName} 未找到` };

    const vpnId = client.server_id.includes('|') ? client.server_id.split('|')[0] : client.server_id;
    const userId = client.client_id;

    await bceRequest(cred, 'PUT', `/v1/vpn/${vpnId}/sslVpnUser/${userId}`, {},
      { password: newPassword }, bccHost
    );
    return { success: true, message: `百度云 VPN 用户 ${clientName} 密码已重置` };
  }

  return { success: false, message: `${platform} VPN 密码重置暂不支持` };
}

module.exports = router;
module.exports.createVpnClient = createVpnClient;
module.exports.updateVpnClientPassword = updateVpnClientPassword;
