const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { ROAClient, RPCClient } = require('@alicloud/pop-core');
const db = require('../utils/database');
const { authenticate, requireGroup, requireOperate } = require('../middleware/auth');
const { ALIYUN_REGIONS } = require('../utils/regions');
const bceRequest = require('../utils/bce');

const router = express.Router();

// PAI DSW 与 AIWorkspace 的 OpenAPI 版本
const DSW_API_VERSION = '2022-01-01';
const WS_API_VERSION  = '2021-02-04';
const PAI_API_VERSION = '2022-01-12';   // pai 服务：资源配额（灵骏/通用计算）
const NAS_API_VERSION = '2017-06-26';   // NAS 服务：CPFS fileset 管理

// 新建 OSS 数据集用的固定 bucket 与共享前缀
const OSS_DATASET_BUCKET = 'sh-algo-pub-rw';
const OSS_DATASET_PREFIX = 'share';     // OSS 路径 share/{实例名}/

// workspace 可分配的 PAI 角色
// 内置 PAI 角色（value=云上角色标识，label=中文名）
const PAI_BUILTIN_ROLES = [
  { value: 'PAI.AlgoDeveloper',   label: '算法开发' },
  { value: 'PAI.AlgoOperator',    label: '算法运维' },
  { value: 'PAI.LabelManager',    label: '标注管理员' },
  { value: 'PAI.LabelOperator',   label: '标注员' },
  { value: 'PAI.WorkspaceAdmin',  label: '工作空间管理员' },
  { value: 'PAI.WorkspaceOwner',  label: '工作空间所有者' },
];
const PAI_BUILTIN_ROLE_VALUES = PAI_BUILTIN_ROLES.map(r => r.value);

// ── 阿里云凭据 & 客户端工厂 ────────────────────────────────

async function getAliyunCred() {
  return db.get("SELECT * FROM platform_credentials WHERE platform = 'aliyun' AND enabled = 1");
}

// region 三级回退：入参 || 凭据默认 || cn-hangzhou
function resolveRegion(cred, region) {
  return region || (cred && cred.region) || 'cn-hangzhou';
}

// pop-core/httpx 默认读超时仅 3s，DSW 创建等重操作会 ReadTimeout，统一放宽到 60s
const PAI_HTTP_OPTS = { timeout: 60000 };

// PAI DSW 客户端（RESTful/ROA 风格，路径前缀 /api/v2）
function dswClient(cred, region) {
  return new ROAClient({
    accessKeyId:     cred.access_key,
    accessKeySecret: cred.secret_key,
    endpoint:        `https://pai-dsw.${region}.aliyuncs.com`,
    apiVersion:      DSW_API_VERSION,
    opts:            PAI_HTTP_OPTS,
  });
}

// PAI AIWorkspace 客户端（工作区/数据集，路径前缀 /api/v1）
function wsClient(cred, region) {
  return new ROAClient({
    accessKeyId:     cred.access_key,
    accessKeySecret: cred.secret_key,
    endpoint:        `https://aiworkspace.${region}.aliyuncs.com`,
    apiVersion:      WS_API_VERSION,
    opts:            PAI_HTTP_OPTS,
  });
}

// RAM 里当前的用户名映射，同时按 UserId 和 login 名(小写) 索引 -> 当前 DisplayName。
// AIWorkspace /users、/members 返回的 DisplayName 是用户加入工作区时的快照，RAM 改名后不会同步，
// 因此用 RAM ListUsers 的实时 DisplayName 覆盖。
async function fetchRamDisplayNames(cred) {
  const client = new RPCClient({
    accessKeyId:     cred.access_key,
    accessKeySecret: cred.secret_key,
    endpoint:        'https://ram.aliyuncs.com',
    apiVersion:      '2015-05-01',
    opts:            PAI_HTTP_OPTS,
  });
  const map = {};
  let marker;
  do {
    const params = { MaxItems: 100 };
    if (marker) params.Marker = marker;
    const out = await client.request('ListUsers', params, { method: 'POST' });
    (out.Users?.User || []).forEach(u => {
      const name = u.DisplayName || u.UserName;
      if (!name) return;
      if (u.UserId)   map[String(u.UserId)] = name;
      if (u.UserName) map[String(u.UserName).split('@')[0].toLowerCase()] = name;
    });
    marker = out.IsTruncated ? out.Marker : null;
  } while (marker);
  return map;
}

// 用 RAM 实时 DisplayName 覆盖工作区快照名：优先按 UserId 匹配，回退按 login 名
function liveRamName(ramNames, userId, loginName, fallback) {
  const byId = userId != null ? ramNames[String(userId)] : undefined;
  if (byId) return byId;
  const login = String(loginName || '').split('@')[0].toLowerCase();
  return ramNames[login] || fallback || '';
}

// PAI 客户端（资源配额：灵骏/通用计算，路径前缀 /api/v1）
function paiClient(cred, region) {
  return new ROAClient({
    accessKeyId:     cred.access_key,
    accessKeySecret: cred.secret_key,
    endpoint:        `https://pai.${region}.aliyuncs.com`,
    apiVersion:      PAI_API_VERSION,
    opts:            PAI_HTTP_OPTS,
  });
}

// NAS 客户端（RPC 风格）：CPFS fileset 管理
function nasClient(cred, region) {
  return new RPCClient({
    accessKeyId:     cred.access_key,
    accessKeySecret: cred.secret_key,
    endpoint:        `https://nas.${region}.aliyuncs.com`,
    apiVersion:      NAS_API_VERSION,
    opts:            PAI_HTTP_OPTS,
  });
}

// 取 CPFS 文件系统信息（含 VPC 挂载点域名，用于拼 bmcpfs:// URI）
async function getCpfsInfo(nas, region) {
  const fs = await nas.request('DescribeFileSystems', { RegionId: region, PageSize: 20 }, { method: 'POST' });
  const list = (fs.FileSystems && fs.FileSystems.FileSystem) || [];
  const cpfs = list.find(f => f.FileSystemType === 'bmcpfs') || list[0];
  if (!cpfs) return null;
  const mts = (cpfs.MountTargets && cpfs.MountTargets.MountTarget) || [];
  const vpcMt = mts.find(m => m.VpcId) || mts[0];
  return {
    fileSystemId:  cpfs.FileSystemId,
    description:   cpfs.Description || '',
    vpcMountDomain: vpcMt ? vpcMt.MountTargetDomain : '',
  };
}

// 确保 CPFS fileset 存在（判重→建→配额），返回 { filesetPath, mountUri }
// 失败时回滚已建的 fileset，避免脏数据
async function ensureCpfsFileset(nas, region, { fileSystemId, vpcMountDomain, name, sizeGiB, fileCount }) {
  const filesetPath = `/${name}/`;
  // 判重
  const existing = await nas.request('DescribeFilesets', { RegionId: region, FileSystemId: fileSystemId, PageSize: 100 }, { method: 'POST' });
  const entries = (existing.Entries && existing.Entries.Entrie) || existing.Entries || [];
  const hit = entries.find(e => e.FileSystemPath === filesetPath);
  const mountUri = `bmcpfs://${vpcMountDomain}${filesetPath}`;
  if (hit) {
    return { filesetPath, mountUri, reused: true };
  }
  // 新建 fileset（Description=实例名即控制台显示的"名称"；默认开启删除保护，与现有 fileset 一致）
  const created = await nas.request('CreateFileset', { RegionId: region, FileSystemId: fileSystemId, FileSystemPath: filesetPath, Description: name, DeletionProtection: true }, { method: 'POST' });
  const fsetId = created.FsetId;

  // 回滚辅助
  const rollback = async () => {
    try {
      await nas.request('ModifyFileset', { RegionId: region, FileSystemId: fileSystemId, FsetId: fsetId, DeletionProtection: false }, { method: 'POST' });
      await nas.request('DeleteFileset', { RegionId: region, FileSystemId: fileSystemId, FsetId: fsetId }, { method: 'POST' });
    } catch (_) { /* 回滚失败仅记录 */ }
  };

  // 先等 fileset 就绪：CreateFileset 返回即时，但云端实际创建有几秒延迟，
  // 未到 CREATED 状态就设配额/建实例都会失败。轮询 DescribeFilesets 最多 ~30s。
  let ready = false;
  for (let i = 0; i < 15; i++) {
    const chk = await nas.request('DescribeFilesets', { RegionId: region, FileSystemId: fileSystemId, PageSize: 100 }, { method: 'POST' });
    const es = (chk.Entries && chk.Entries.Entrie) || chk.Entries || [];
    const me = es.find(e => e.FsetId === fsetId || e.FileSystemPath === filesetPath);
    if (me && me.Status === 'CREATED') { ready = true; break; }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!ready) {
    await rollback();
    throw new Error('fileset 创建超时未就绪，请稍后重试');
  }

  // 就绪后再设配额（SizeLimit 字节，FileCountLimit 文件数）
  try {
    await nas.request('SetFilesetQuota', {
      RegionId: region, FileSystemId: fileSystemId, FsetId: fsetId,
      SizeLimit: Math.round(Number(sizeGiB) * 1024 * 1024 * 1024),
      FileCountLimit: Number(fileCount),
    }, { method: 'POST' });
  } catch (err) {
    await rollback();
    throw new Error('设置 fileset 配额失败: ' + err.message);
  }
  return { filesetPath, mountUri, fsetId, reused: false };
}

// ResourceType -> 中文标签
function quotaTypeLabel(t) {
  if (t === 'Lingjun') return '灵骏智算';
  if (t === 'ECS')     return '通用计算';
  return t || '';
}

// OSS 客户端（bucket 可指定，默认走 OSS_DATASET_BUCKET）
function ossClient(cred, region, bucket) {
  const OSS = require('ali-oss');
  return new OSS({
    accessKeyId:     cred.access_key,
    accessKeySecret: cred.secret_key,
    bucket:          bucket || OSS_DATASET_BUCKET,
    region:          `oss-${region}`,
  });
}

// 归一化用户填写的 OSS 参数
// prefix: 去掉首尾斜杠，空则回落默认；mountPath: 保证以 / 开头和结尾
function normalizeOssPrefix(v) {
  const s = String(v == null ? '' : v).trim().replace(/^\/+|\/+$/g, '');
  return s || OSS_DATASET_PREFIX;
}
function normalizeMountPath(v, prefix) {
  let s = String(v == null ? '' : v).trim();
  if (!s) s = `/mnt/${prefix}`;
  if (!s.startsWith('/')) s = '/' + s;
  if (!s.endsWith('/'))   s = s + '/';
  return s.replace(/\/{2,}/g, '/');
}

// 确保 OSS 数据集存在：建 OSS 目录 → 判重 → 建数据集，返回挂载项
// bucket / prefix / mountPath 均可由调用方指定，未传则回落到默认常量
// OSS 路径 {prefix}/{name}/；挂载点 {mountPath}
async function ensureOssDataset(cred, ws, region, { workspaceId, name, mountAccess, ownerUserId, bucket, prefix, mountPath: mountPathIn, roleArn, extraOptions }) {
  const bkt       = (bucket || OSS_DATASET_BUCKET).trim();
  const pfx       = normalizeOssPrefix(prefix);
  const ossPath   = `${pfx}/${name}/`;                                // {prefix}/{name}/
  const uri       = `oss://${bkt}.oss-${region}.aliyuncs.com/${ossPath}`;
  const mountPath = normalizeMountPath(mountPathIn, pfx);             // 默认 /mnt/{prefix}/
  const access    = mountAccess === 'RO' ? 'RO' : 'RW';
  // 高级挂载参数（字段名取自真实环境探测：Datasets[] 支持 RoleArn / Options）
  const adv = {
    roleArn:      (roleArn || '').trim(),
    extraOptions: extraOptions && typeof extraOptions === 'object' ? extraOptions : null,
  };

  // 1) 建 OSS 目录（put 以 / 结尾的空对象，幂等）
  const oss = ossClient(cred, region, bkt);
  await oss.put(ossPath, Buffer.from(''));

  // 2) 判重：已有同 Uri 数据集则复用
  const existing = await ws.request('GET', '/api/v1/datasets', { WorkspaceId: workspaceId, PageSize: 100, PageNumber: 1 }, '', JSON_HEADER);
  const hit = (existing.Datasets || []).find(d => d.Uri === uri);
  if (hit) {
    return { datasetId: hit.DatasetId, mountPath, mountAccess: access, reused: true, bucket: bkt, ossPath, adv };
  }

  // 权限角色：可见=数据所有者+管理员；读写=数据所有者
  const visibleRoles = ['owner', 'PAI.WorkspaceAdmin'];

  // 数据集 Options：mountPath 之外允许合并用户填写的高级配置 JSON
  const dsOptions = { mountPath, ...(adv.extraOptions || {}) };

  // 3) 建 OSS 数据集
  const body = {
    Name:           `dataset-oss-${name}`,
    WorkspaceId:    workspaceId,
    Property:       'DIRECTORY',
    DataSourceType: 'OSS',
    Uri:            uri,
    ImportInfo:     JSON.stringify({ bucket: bkt, path: ossPath, region }),
    Options:        JSON.stringify(dsOptions),
    MountAccess:    access,
    Accessibility:  'ROLE_PUBLIC',
    AccessibleRoleIdList: visibleRoles,          // 可见范围
    MountAccessReadWriteRoleIdList: ['owner'],   // 读写权限：仅数据所有者
  };
  // 数据集所有者 = 创建 DSW 时选的归属人（与实例 owner 一致）
  if (ownerUserId) body.UserId = ownerUserId;
  // RAM 角色：数据集侧字段名为 DatasetTaskRamRole（实测存在，现网取值均为 null）
  if (adv.roleArn) body.DatasetTaskRamRole = adv.roleArn;
  const out = await ws.request('POST', '/api/v1/datasets', {}, JSON.stringify(body), JSON_HEADER);
  return { datasetId: out.DatasetId, mountPath, mountAccess: access, reused: false, bucket: bkt, ossPath, adv };
}

const JSON_HEADER = { 'content-type': 'application/json' };

// 把云上返回的 DSW 实例对象归一化
function normalizeDswInstance(it) {
  // 内网 IP：优先取用户网(eth1/user)，其次系统网
  const pods = Array.isArray(it.PodIps) ? it.PodIps : [];
  const userPod = pods.find(p => p.Type === 'user') || pods[0];
  return {
    instanceId:   it.InstanceId,
    instanceName: it.InstanceName || '',
    status:       it.Status || '',
    workspaceId:  it.WorkspaceId || '',
    ecsSpec:      it.EcsSpec || '',
    imageId:      it.ImageId || '',
    jupyterUrl:   it.JupyterlabUrl || it.InstanceUrl || '',
    ownerName:    it.UserName || '',
    ownerId:      it.UserId || '',
    accessibility: it.Accessibility || '',
    privateIp:    userPod ? (userPod.Ip || '') : '',
    datasets:     it.Datasets || [],
    raw:          it,
  };
}

// ── 列表 ──────────────────────────────────────────────────

// GET /api/pai/dsw?platform=aliyun
router.get('/dsw', authenticate, async (req, res) => {
  const rows = await db.all('SELECT * FROM cloud_pai_dsw ORDER BY created_at DESC');
  res.json({ instances: rows });
});

// ── 同步 ──────────────────────────────────────────────────

// POST /api/pai/dsw/sync/:platform  （PAI 仅阿里云）
router.post('/dsw/sync/:platform', authenticate, requireOperate('compute'), async (req, res) => {
  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, req.body && req.body.region);

  let list = [];
  try {
    const dsw = dswClient(cred, region);
    const ws  = wsClient(cred, region);
    // 列出全部工作区，逐个用 ResourceId=ALL 拉取工作区内所有成员创建的实例
    const wl = await ws.request('GET', '/api/v1/workspaces', { PageSize: 100, PageNumber: 1 }, '', JSON_HEADER);
    for (const w of (wl.Workspaces || [])) {
      let page = 1;
      while (true) {
        const out = await dsw.request('GET', '/api/v2/instances',
          { WorkspaceId: w.WorkspaceId, ResourceId: 'ALL', SortBy: 'GmtCreateTime', Order: 'DESC', PageSize: 100, PageNumber: page },
          '', JSON_HEADER);
        const arr = out.Instances || [];
        list = list.concat(arr.map(normalizeDswInstance));
        if (arr.length < 100) break;
        page++;
      }
    }
    // 内网 IP 只在 GetInstance(详情)返回、且仅 Running 实例有 —— 对运行中的实例补拉一次
    for (const it of list) {
      if ((it.status || '').toLowerCase() !== 'running') continue;
      try {
        const detail = await dsw.request('GET', `/api/v2/instances/${it.instanceId}`, {}, '', JSON_HEADER);
        const pods = Array.isArray(detail.PodIps) ? detail.PodIps : [];
        const userPod = pods.find(p => p.Type === 'user') || pods[0];
        if (userPod) it.privateIp = userPod.Ip || '';
      } catch (_) { /* 单个详情失败不影响整体同步 */ }
    }
  } catch (err) {
    return res.status(500).json({ error: `拉取 DSW 实例失败: ${err.message}` });
  }

  let written = 0;
  for (const it of list) {
    try {
      await db.run(`
        INSERT INTO cloud_pai_dsw
          (id, platform, instance_id, instance_name, status, region, workspace_id, ecs_spec, image_id, jupyter_url, owner_name, owner_uid, accessibility, private_ip, datasets, config)
        VALUES (?, 'aliyun', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          instance_name = VALUES(instance_name),
          status        = VALUES(status),
          region        = VALUES(region),
          workspace_id  = VALUES(workspace_id),
          ecs_spec      = VALUES(ecs_spec),
          image_id      = VALUES(image_id),
          jupyter_url   = VALUES(jupyter_url),
          owner_name    = VALUES(owner_name),
          owner_uid     = VALUES(owner_uid),
          accessibility = VALUES(accessibility),
          private_ip    = VALUES(private_ip),
          datasets      = VALUES(datasets),
          config        = VALUES(config),
          synced_at     = CURRENT_TIMESTAMP
      `, [
        uuidv4(), it.instanceId, it.instanceName, it.status, region,
        it.workspaceId, it.ecsSpec, it.imageId, it.jupyterUrl,
        it.ownerName, it.ownerId, it.accessibility, it.privateIp,
        JSON.stringify(it.datasets || []), JSON.stringify(it.raw || {}),
      ]);
      written++;
    } catch (err) {
      console.error(`[pai] 写入 DSW ${it.instanceId} 失败:`, err.message);
    }
  }

  // 对账：删除本地存在但云上已不存在的僵尸记录（云上已删的实例应从平台移除）
  let removed = 0;
  try {
    const cloudIds = new Set(list.map(it => it.instanceId));
    const localRows = await db.all("SELECT id, instance_id FROM cloud_pai_dsw WHERE platform = 'aliyun'");
    for (const row of localRows) {
      if (!cloudIds.has(row.instance_id)) {
        await db.run('DELETE FROM cloud_pai_dsw WHERE id = ?', [row.id]);
        removed++;
      }
    }
  } catch (err) {
    console.error('[pai] 清理僵尸 DSW 记录失败:', err.message);
  }

  res.json({ results: [{ platform: 'aliyun', success: true, message: `同步成功（新增/更新 ${written}，清理 ${removed}）`, count: written }] });
});

// ── 创建（一键，关联已有 CPFS/数据集） ────────────────────

async function createAliyunDswInstance(cred, opts) {
  const region = resolveRegion(cred, opts.region);
  const client = dswClient(cred, region);

  const body = {
    WorkspaceId:  opts.workspace_id,
    InstanceName: opts.instance_name,
  };
  // 基于已有资源池创建：ResourceId 指定配额，RequestedResource 从配额里切出实例规格
  // 注意：Memory/SharedMemory 必须带单位 GB（云端要求，纯数字会被误解析导致 "unable to set memory limit to 1"）；CPU/GPU 为纯数字
  if (opts.resource_id) body.ResourceId = opts.resource_id;
  const withGB = v => /[a-zA-Z]/.test(String(v)) ? String(v) : `${v}GB`;
  const rr = {};
  if (opts.cpu != null && opts.cpu !== '')       rr.CPU = String(opts.cpu);
  if (opts.memory != null && opts.memory !== '') rr.Memory = withGB(opts.memory);
  if (opts.gpu != null && opts.gpu !== '')       rr.GPU = String(opts.gpu);
  if (opts.shared_memory != null && opts.shared_memory !== '') rr.SharedMemory = withGB(opts.shared_memory);
  if (Object.keys(rr).length) body.RequestedResource = rr;
  // 优先级 1-9（低→高），默认 1
  body.Priority = (opts.priority != null && opts.priority !== '') ? Number(opts.priority) : 1;
  if (opts.image_id) body.ImageId = opts.image_id;
  // 系统盘大小（GiB）：CloudDisks rootfs
  if (opts.system_disk_size != null && opts.system_disk_size !== '') {
    body.CloudDisks = [{ Capacity: `${opts.system_disk_size}Gi`, SubType: 'rootfs', MountPath: '/mnt/systemDisk' }];
  }
  // 指定节点调度：AssignNodeSpec.NodeNames；不指定则由平台自动调度
  if (opts.node_name) body.AssignNodeSpec = { NodeNames: opts.node_name };
  // 指定实例归属人：owner 必须已是该 workspace 成员，否则创建失败
  if (opts.owner_user_id) body.UserId = opts.owner_user_id;
  // 挂载集合（数据集 + CPFS 工作目录，统一走 Datasets 数组）
  const mounts = [];
  // 关联已有数据集：必须带上数据集自身的 MountPath（DSW 要求每个挂载项有挂载路径，否则报错）
  if (Array.isArray(opts.dataset_mounts) && opts.dataset_mounts.length) {
    opts.dataset_mounts.forEach(m => {
      const item = { DatasetId: m.datasetId };
      if (m.mountPath) item.MountPath = m.mountPath;
      // 每个数据集可单独指定挂载参数（如 ossfs 的 mountType / mem.limit / ossfs.args）
      if (m.options) item.Options = JSON.stringify(m.options);
      mounts.push(item);
    });
  }
  // CPFS 工作目录：自动建的 fileset 以 bmcpfs:// URI 挂到 /mnt/pfs/users/{实例名}
  if (opts.cpfs_mount) {
    mounts.push({ Uri: opts.cpfs_mount.mountUri, MountPath: `/mnt/pfs/users/${opts.instance_name}` });
  }
  // 新建的 OSS 数据集：{ DatasetId, MountPath, MountAccess } + 高级参数
  // 字段名取自真实环境探测。Datasets[] 还支持 EnableCache/Dynamic，但按需求只暴露 RoleArn/Options
  if (opts.oss_dataset) {
    const item = {
      DatasetId:   opts.oss_dataset.datasetId,
      MountPath:   opts.oss_dataset.mountPath,
      MountAccess: opts.oss_dataset.mountAccess,
    };
    const adv = opts.oss_dataset.adv || {};
    if (adv.roleArn)      item.RoleArn = adv.roleArn;
    if (adv.extraOptions) item.Options = JSON.stringify(adv.extraOptions);
    mounts.push(item);
  }
  if (mounts.length) body.Datasets = mounts;

  const script = (opts.start_script || '').trim();
  if (script) body.UserCommand = { OnStart: { Content: script } };

  // 启用 SSH：挂进 VPC + 转发 22 端口。VPC 三件套复用同 region 已有实例的 UserVpc（该账号该 region 固定一套）
  if (opts.enable_ssh && opts.ssh_public_key) {
    const uv = await resolveRegionUserVpc(region);
    if (!uv) throw new Error('该地域暂无可复用的 VPC 配置（需先有一个已挂 VPC 的 DSW 实例），无法启用 SSH');
    body.UserVpc = {
      VpcId:           uv.VpcId,
      VSwitchId:       uv.VSwitchId,
      SecurityGroupId: uv.SecurityGroupId,
      DefaultRoute:    uv.DefaultRoute || 'eth1',
      ForwardInfos: [{
        Name: 'SSH', ForwardPort: '22',
        SSHPublicKey: opts.ssh_public_key.trim(),
        Enable: true, AccessType: [],
      }],
    };
  }

  const out = await client.request('POST', '/api/v2/instances', {}, JSON.stringify(body), JSON_HEADER);
  return { instanceId: out.InstanceId, region, raw: out };
}

// 从同 region 已有实例的 config 里取一套 UserVpc（VpcId/VSwitchId/SecurityGroupId/DefaultRoute）
// DSW 挂 VPC 需要这套网络配置；同一账号同一 region 固定一套，可安全复用
async function resolveRegionUserVpc(region) {
  const rows = await db.all(
    "SELECT config FROM cloud_pai_dsw WHERE region = ? AND config LIKE '%UserVpc%' ORDER BY synced_at DESC LIMIT 20",
    [region]
  );
  for (const r of rows) {
    try {
      const uv = JSON.parse(r.config || '{}').UserVpc;
      if (uv && uv.VpcId && uv.VSwitchId && uv.SecurityGroupId) return uv;
    } catch (_) { /* skip */ }
  }
  return null;
}

// POST /api/pai/dsw
router.post('/dsw', authenticate, requireOperate('compute'), async (req, res) => {
  const { region, workspace_id, instance_name, image_id, dataset_ids, dataset_options, owner_user_id,
          resource_id, resource_name, cpu, memory, gpu, shared_memory, system_disk_size, priority, node_name,
          cpfs_enabled, cpfs_size_gib, cpfs_file_count,
          oss_dataset_enabled, oss_dataset_access,
          oss_bucket, oss_prefix, oss_mount_path,
          oss_role_arn, oss_options_json,
          enable_ssh, ssh_public_key, start_script } = req.body || {};
  if (!workspace_id || !instance_name) {
    return res.status(400).json({ error: '请填写 workspace_id、instance_name' });
  }
  if (start_script != null && typeof start_script !== 'string') {
    return res.status(400).json({ error: '自定义启动脚本格式不正确' });
  }
  if (start_script && start_script.length > 8192) {
    return res.status(400).json({ error: '自定义启动脚本不能超过 8192 个字符' });
  }
  if (enable_ssh && !(ssh_public_key || '').trim()) {
    return res.status(400).json({ error: '启用 SSH 需填写 SSH 公钥' });
  }
  // 已有数据集的挂载参数：必须是 JSON 对象（数组/标量会让云端 Options 解析异常）
  if (dataset_options && typeof dataset_options === 'object' && !Array.isArray(dataset_options)) {
    for (const [dsId, raw] of Object.entries(dataset_options)) {
      if (raw == null || String(raw).trim() === '') continue;
      let parsed;
      try { parsed = JSON.parse(raw); }
      catch (e) { return res.status(400).json({ error: `数据集 ${dsId} 的挂载参数不是合法 JSON：${e.message}` }); }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return res.status(400).json({ error: `数据集 ${dsId} 的挂载参数需为 JSON 对象` });
      }
    }
  }
  // OSS 参数支持手动输入，需校验格式（bucket 命名规则由 OSS 规定：小写字母/数字/短横线，3-63 位，不以短横线开头结尾）
  if (oss_dataset_enabled) {
    const bkt = (oss_bucket || '').trim();
    if (bkt && !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bkt)) {
      return res.status(400).json({ error: 'OSS Bucket 名称不合法：只能小写字母、数字、短横线，3-63 位，且不以短横线开头或结尾' });
    }
    const pfx = (oss_prefix || '').trim();
    // 不允许 .. 穿越，也不允许出现空格
    if (pfx && (/\.\./.test(pfx) || /\s/.test(pfx))) {
      return res.status(400).json({ error: 'OSS 路径前缀不合法：不能包含 .. 或空格' });
    }
    const mp = (oss_mount_path || '').trim();
    if (mp && (/\.\./.test(mp) || /\s/.test(mp))) {
      return res.status(400).json({ error: '挂载路径不合法：不能包含 .. 或空格' });
    }
    // 挂载路径必须是绝对路径下的子目录，禁止直接挂到根
    if (mp && (mp === '/' || mp === '/mnt' || mp === '/mnt/')) {
      return res.status(400).json({ error: '挂载路径不能是 / 或 /mnt，请指定子目录' });
    }
    // RAM 角色 ARN 格式：acs:ram::{账号ID}:role/{角色名}
    const ra = (oss_role_arn || '').trim();
    if (ra && !/^acs:ram::\d+:role\/[\w+=,.@-]+$/.test(ra)) {
      return res.status(400).json({ error: 'RAM 角色 ARN 格式不正确，应形如 acs:ram::1234567890:role/your-role' });
    }
    // 高级配置必须是 JSON 对象（数组/标量都会让云端 Options 解析异常）
    if (oss_options_json != null && String(oss_options_json).trim() !== '') {
      let parsed;
      try { parsed = JSON.parse(oss_options_json); }
      catch (e) { return res.status(400).json({ error: '高级配置不是合法 JSON：' + e.message }); }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return res.status(400).json({ error: '高级配置需为 JSON 对象，例如 {"fs.oss.download.thread.concurrency":16}' });
      }
    }
  }
  if (!resource_id) {
    return res.status(400).json({ error: '请选择资源池' });
  }
  if (!image_id) {
    return res.status(400).json({ error: '请选择镜像' });
  }
  // 资源规格：至少填 CPU 和 内存
  if (cpu == null || cpu === '' || memory == null || memory === '') {
    return res.status(400).json({ error: '请填写 CPU 核数和内存(GiB)' });
  }
  if (cpfs_enabled) {
    if (!cpfs_size_gib || !cpfs_file_count) {
      return res.status(400).json({ error: '挂载 CPFS 需填写容量(GiB)和文件数上限' });
    }
    if (Number(cpfs_size_gib) < 10) {
      return res.status(400).json({ error: 'CPFS 容量最小为 10 GiB' });
    }
    if (Number(cpfs_file_count) < 10000 || Number(cpfs_file_count) > 10000000000) {
      return res.status(400).json({ error: 'CPFS 文件数需在 1万 ~ 100亿之间' });
    }
  }

  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const rgn = resolveRegion(cred, region);

  // 若启用 CPFS：先建 fileset+配额，拿到挂载 URI
  let cpfs_mount = null;
  if (cpfs_enabled) {
    try {
      const nas = nasClient(cred, rgn);
      const cpfs = await getCpfsInfo(nas, rgn);
      if (!cpfs) return res.status(400).json({ error: '该地域无可用 CPFS 文件系统' });
      cpfs_mount = await ensureCpfsFileset(nas, rgn, {
        fileSystemId:   cpfs.fileSystemId,
        vpcMountDomain: cpfs.vpcMountDomain,
        name:           instance_name,
        sizeGiB:        cpfs_size_gib,
        fileCount:      cpfs_file_count,
      });
    } catch (err) {
      return res.status(500).json({ error: 'CPFS fileset 创建失败: ' + err.message });
    }
  }

  // 若启用新建 OSS 数据集：先建 OSS 目录+数据集，拿到挂载项
  let oss_dataset = null;
  if (oss_dataset_enabled) {
    try {
      const ws = wsClient(cred, rgn);
      oss_dataset = await ensureOssDataset(cred, ws, rgn, {
        workspaceId: workspace_id,
        name:        instance_name,
        mountAccess: oss_dataset_access,
        ownerUserId: owner_user_id,
        bucket:      oss_bucket,
        prefix:      oss_prefix,
        mountPath:   oss_mount_path,
        roleArn:     oss_role_arn,
        // 上面已校验过是合法 JSON 对象，这里直接解析
        extraOptions: (oss_options_json != null && String(oss_options_json).trim() !== '')
          ? JSON.parse(oss_options_json) : null,
      });
    } catch (err) {
      return res.status(500).json({ error: 'OSS 数据集创建失败: ' + err.message });
    }
  }

  // 解析选中的已有数据集，取各自的 MountPath（存于 Options.mountPath）
  let dataset_mounts = [];
  if (Array.isArray(dataset_ids) && dataset_ids.length) {
    try {
      const ws = wsClient(cred, rgn);
      const dl = await ws.request('GET', '/api/v1/datasets', { WorkspaceId: workspace_id, PageSize: 100, PageNumber: 1 }, '', JSON_HEADER);
      const byId = {};
      (dl.Datasets || []).forEach(d => { byId[d.DatasetId] = d; });
      dataset_mounts = dataset_ids.map(id => {
        const d = byId[id];
        let mountPath = '';
        if (d) { try { mountPath = (JSON.parse(d.Options || '{}').mountPath) || ''; } catch (_) {} }
        // 用户为该数据集单独填的挂载参数（已在上面校验过是合法 JSON 对象）
        const optRaw = dataset_options && dataset_options[id];
        let options = null;
        if (optRaw && String(optRaw).trim()) {
          try { options = JSON.parse(optRaw); } catch (_) { options = null; }
        }
        return { datasetId: id, mountPath, options };
      });
    } catch (err) {
      return res.status(500).json({ error: '解析数据集挂载路径失败: ' + err.message });
    }
  }

  let created;
  try {
    created = await createAliyunDswInstance(cred, { region, workspace_id, instance_name, image_id, dataset_mounts, owner_user_id, resource_id, cpu, memory, gpu, shared_memory, system_disk_size, priority, node_name, cpfs_mount, oss_dataset, enable_ssh, ssh_public_key, start_script });
  } catch (err) {
    return res.status(500).json({ error: 'DSW 创建失败: ' + err.message });
  }

  const localId = uuidv4();
  const specText = `CPU:${cpu} Mem:${memory}${gpu ? ' GPU:'+gpu : ''}`;
  await db.run(`
    INSERT INTO cloud_pai_dsw
      (id, platform, instance_id, instance_name, status, region, workspace_id, ecs_spec, image_id, resource_id, resource_name, datasets, config, user_id)
    VALUES (?, 'aliyun', ?, ?, 'Creating', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    localId, created.instanceId, instance_name, created.region,
    workspace_id, specText, image_id || '', resource_id || '', resource_name || '',
    JSON.stringify(dataset_ids || []), JSON.stringify(created.raw || {}), req.user.id || null,
  ]);

  res.status(201).json({ message: 'DSW 实例创建成功', instance: { id: localId, instanceId: created.instanceId } });
});

// ── 启动 / 停止 / 删除 ────────────────────────────────────

// 通用：按本地 id 找实例并对云端执行动作
// body: 可选的请求体对象（stop 需带 {SaveImage:false}，否则云端报 Bad request）
async function dswAction(req, res, { method, pathFn, okStatus, okMsg, body }) {
  const row = await db.get('SELECT * FROM cloud_pai_dsw WHERE id = ?', [req.params.id]);
  if (!row) return res.status(404).json({ error: 'DSW 实例不存在' });

  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, row.region);

  try {
    const client = dswClient(cred, region);
    const reqBody = body ? JSON.stringify(body) : '';
    await client.request(method, pathFn(row.instance_id), {}, reqBody, JSON_HEADER);
  } catch (err) {
    return res.status(500).json({ error: `${okMsg}失败: ${err.message}` });
  }

  if (okStatus === null) {
    await db.run('DELETE FROM cloud_pai_dsw WHERE id = ?', [req.params.id]);
  } else {
    await db.run('UPDATE cloud_pai_dsw SET status = ? WHERE id = ?', [okStatus, req.params.id]);
  }
  res.json({ message: `${okMsg}成功` });
}

// POST /api/pai/dsw/:id/start
router.post('/dsw/:id/start', authenticate, requireOperate('compute'), (req, res) =>
  dswAction(req, res, {
    method: 'PUT', pathFn: id => `/api/v2/instances/${id}/start`,
    okStatus: 'Starting', okMsg: '启动',
  }));

// POST /api/pai/dsw/:id/stop
router.post('/dsw/:id/stop', authenticate, requireOperate('compute'), (req, res) =>
  dswAction(req, res, {
    method: 'PUT', pathFn: id => `/api/v2/instances/${id}/stop`,
    body: { SaveImage: false },   // stop 必须带 body，否则云端报 Bad request
    okStatus: 'Stopping', okMsg: '停止',
  }));

// DELETE /api/pai/dsw/:id
router.delete('/dsw/:id', authenticate, requireOperate('compute'), (req, res) =>
  dswAction(req, res, {
    method: 'DELETE', pathFn: id => `/api/v2/instances/${id}`,
    okStatus: null, okMsg: '删除',
  }));

// ── 创建弹窗辅助查询：工作区 / 数据集 / 规格 ────────────────

// GET /api/pai/workspaces?region=
router.get('/workspaces', authenticate, async (req, res) => {
  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, req.query.region);
  try {
    const client = wsClient(cred, region);
    const out = await client.request('GET', '/api/v1/workspaces', { PageSize: 100, PageNumber: 1 }, '', JSON_HEADER);
    const items = (out.Workspaces || []).map(w => ({
      workspaceId:   w.WorkspaceId,
      workspaceName: w.WorkspaceName || w.DisplayName || '',
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: '查询工作区失败: ' + err.message });
  }
});

// GET /api/pai/datasets?region=&workspace_id=
router.get('/datasets', authenticate, async (req, res) => {
  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, req.query.region);
  const query = { PageSize: 100, PageNumber: 1 };
  if (req.query.workspace_id) query.WorkspaceId = req.query.workspace_id;
  try {
    const client = wsClient(cred, region);
    const out = await client.request('GET', '/api/v1/datasets', query, '', JSON_HEADER);
    const items = (out.Datasets || []).map(d => ({
      datasetId:   d.DatasetId,
      datasetName: d.Name || d.DatasetName || '',
      sourceType:  d.SourceType || '',   // CPFS / OSS / NAS 等
      uri:         d.Uri || '',
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: '查询数据集失败: ' + err.message });
  }
});

// GET /api/pai/images?region=&custom=1&workspace_id=  镜像列表
// 默认取官方 DSW 镜像（system.supported.dsw=true）；custom=1 时取工作区自定义镜像
router.get('/images', authenticate, async (req, res) => {
  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, req.query.region);
  const useCustom = req.query.custom === '1' && req.query.workspace_id;
  try {
    const client = wsClient(cred, region);
    let images = [];
    if (useCustom) {
      const out = await client.request('GET', '/api/v1/images', { WorkspaceId: req.query.workspace_id, PageSize: 100, PageNumber: 1 }, '', JSON_HEADER);
      images = out.Images || [];
    } else {
      // 官方 DSW 镜像，分页拉全（约 534 个）
      let page = 1;
      while (true) {
        const out = await client.request('GET', '/api/v1/images',
          { Verbose: true, Labels: 'system.supported.dsw=true', PageSize: 100, PageNumber: page }, '', JSON_HEADER);
        const arr = out.Images || [];
        images = images.concat(arr);
        if (arr.length < 100 || page >= 10) break;
        page++;
      }
    }
    const items = images.map(im => ({
      imageId:  im.ImageId,
      name:     im.Name || im.ImageId,
      imageUri: im.ImageUri || '',
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: '查询镜像失败: ' + err.message });
  }
});

// GET /api/pai/quotas?region=&workspace_id=  资源配额（灵骏/通用计算）列表
// 从 pai 服务取真实配额；传 workspace_id 时只返回绑定到该工作区的配额
router.get('/quotas', authenticate, async (req, res) => {
  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, req.query.region);
  const wsId = req.query.workspace_id;
  try {
    const client = paiClient(cred, region);
    const out = await client.request('GET', '/api/v1/quotas', { PageSize: 100, PageNumber: 1 }, '', JSON_HEADER);
    let quotas = out.Quotas || [];
    // 按工作区过滤：配额的 Workspaces 数组含该 wsId 才保留
    if (wsId) {
      quotas = quotas.filter(q => (q.Workspaces || []).some(w => String(w.WorkspaceId) === String(wsId)));
    }
    const items = quotas.map(q => {
      const nodeSpecs = (q.Min && Array.isArray(q.Min.NodeSpecs)) ? q.Min.NodeSpecs : [];
      const specText = nodeSpecs.map(n => `${n.Type}×${n.Count}`).join(', ');
      return {
        resourceId:   q.QuotaId,                       // CreateInstance 用它作 ResourceId
        name:         q.QuotaName || q.QuotaId,
        resourceType: q.ResourceType || '',            // Lingjun / ECS
        typeLabel:    quotaTypeLabel(q.ResourceType),   // 灵骏智算 / 通用计算
        gpuType:      q.GPUType || '',
        nodeSpecs:    specText,                         // 如 ml.gx8ecf.8.46xlarge×128
        workspaces:   (q.Workspaces || []).map(w => ({ id: w.WorkspaceId, name: w.WorkspaceName })),
      };
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: '查询资源配额失败: ' + err.message });
  }
});

// GET /api/pai/cpfs?region=  可用的 CPFS 文件系统（供创建弹窗判断能否挂载）
router.get('/cpfs', authenticate, async (req, res) => {
  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, req.query.region);
  try {
    const nas = nasClient(cred, region);
    const info = await getCpfsInfo(nas, region);
    res.json({ items: info ? [info] : [] });
  } catch (err) {
    res.status(500).json({ error: '查询 CPFS 失败: ' + err.message });
  }
});

// 解析 PAI 资源量：可能是纯数字、"8"、"8Gi"、"32768Mi"、"3200m"(毫核) 等，统一成数值
// GPU/CPU 返回核数，Memory 归一到 GiB
function _paiResNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  const m = /^([\d.]+)\s*([a-zA-Z]*)$/.exec(s);
  if (!m) return null;
  let num = parseFloat(m[1]);
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'm') num = num / 1000;            // 毫核 → 核
  else if (unit === 'mi') num = num / 1024;      // MiB → GiB
  else if (unit === 'ki') num = num / 1024 / 1024;
  else if (unit === 'ti') num = num * 1024;      // TiB → GiB
  // gi / g / 空 / 其它：按原值(GiB 或 核)
  return num;
}

// GET /api/pai/nodes?region=&quota_id=  指定资源配额下的节点列表（供创建 DSW 指定节点调度）
router.get('/nodes', authenticate, async (req, res) => {
  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, req.query.region);
  const quotaId = req.query.quota_id;
  if (!quotaId) return res.status(400).json({ error: '缺少 quota_id' });
  // 禁用协商缓存，避免浏览器 304 返回旧数据（用量是实时变化的）
  res.set('Cache-Control', 'no-store');
  try {
    const client = paiClient(cred, region);
    // 带 QuotaId 查该配额下的节点；ListNodes 返回的「总量」CPU/Memory/GPU 是准确的，
    // 但 RequestCPU/RequestMemory（用量）对公开 OpenAPI 恒为 0（控制台用量来自内部 pai-resource-service）。
    // 故用量改由「已同步的运行中 DSW 实例，按 AssignNodeSpec 归属节点，聚合 RequestedResource」算出，与控制台一致。
    const out = await client.request('GET', '/api/v1/nodes', { QuotaId: quotaId, PageSize: 200, PageNumber: 1 }, '', JSON_HEADER);
    const nodes = out.Nodes || [];

    // 聚合各节点已用资源：遍历运行中 DSW 实例的 config.AssignNodeSpec.NodeNames + RequestedResource
    const usage = {};   // nodeName -> { cpu, mem, gpu }
    try {
      const rows = await db.all(
        "SELECT config FROM cloud_pai_dsw WHERE LOWER(status)='running' AND config IS NOT NULL AND config LIKE '%AssignNodeSpec%'"
      );
      for (const r of rows) {
        let c; try { c = JSON.parse(r.config || '{}'); } catch { continue; }
        const names = ((c.AssignNodeSpec || {}).NodeNames || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!names.length) continue;
        const rr = c.RequestedResource || {};
        const cpu = _paiResNum(rr.CPU) || 0, mem = _paiResNum(rr.Memory) || 0, gpu = _paiResNum(rr.GPU) || 0;
        for (const nn of names) {
          const u = usage[nn] || (usage[nn] = { cpu: 0, mem: 0, gpu: 0 });
          u.cpu += cpu; u.mem += mem; u.gpu += gpu;
        }
      }
    } catch (e) { console.warn('[pai/nodes] 聚合实例用量失败，用量按 0 显示:', e.message); }

    const num = (v) => _paiResNum(v);
    const sub = (t, u) => (t != null ? { total: t, used: u || 0, free: Math.max(0, t - (u || 0)) } : null);
    const items = nodes.map(n => {
      const u = usage[n.NodeName] || { cpu: 0, mem: 0, gpu: 0 };
      const cpuTotal = num(n.CPU);
      const memTotal = num(n.Memory);   // GiB
      const gpuTotal = num(n.GPU) || 0;
      return {
        nodeName:     n.NodeName,
        nodeType:     n.NodeType || '',        // 规格，如 ml.gx8ecf.8.46xlarge / ecs.g6.6xlarge
        gpu:          n.GPU || 0,
        gpuType:      n.GPUType || '',
        zone:         n.AvailabilityZone || '',
        status:       n.NodeStatus || '',
        // 用量由运行中实例聚合得出；GPU 总量为 0 视为无 GPU（CPU 节点）
        cpuRes:       sub(cpuTotal, u.cpu),
        memRes:       sub(memTotal, u.mem),
        gpuRes:       (gpuTotal && gpuTotal > 0) ? sub(gpuTotal, u.gpu) : null,
      };
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: '查询节点失败: ' + err.message });
  }
});

// GET /api/pai/cpfs-filesystems?region=  CPFS 文件系统（实例）列表
router.get('/cpfs-filesystems', authenticate, async (req, res) => {
  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, req.query.region);
  try {
    const nas = nasClient(cred, region);
    const out = await nas.request('DescribeFileSystems', { RegionId: region, PageSize: 50 }, { method: 'POST' });
    const list = (out.FileSystems && out.FileSystems.FileSystem) || [];
    const cpfsList = list.filter(f => f.FileSystemType === 'bmcpfs' || (f.ProtocolType || '').toLowerCase() === 'cpfs');
    const items = [];
    for (const f of cpfsList) {
      // CPFS 文件系统级 MeteredSize 不上报，用量 = 各 fileset SpaceUsage 之和
      let usedBytes = 0;
      try {
        const fl = await nas.request('DescribeFilesets', { RegionId: region, FileSystemId: f.FileSystemId, PageSize: 100 }, { method: 'POST' });
        const entries = (fl.Entries && fl.Entries.Entrie) || fl.Entries || [];
        usedBytes = entries.reduce((sum, e) => sum + (e.SpaceUsage || 0), 0);
      } catch (_) { /* 取不到用量则显示 0 */ }
      const capacityGiB = f.Capacity || 0;
      const usedGiB = +(usedBytes / 1024 / 1024 / 1024).toFixed(2);
      items.push({
        fileSystemId: f.FileSystemId,
        name:         f.Description || f.FileSystemId,
        protocol:     f.ProtocolType || '',
        capacityGiB,                                                   // 总容量(GiB)
        usedGiB,                                                       // 已用(GiB，各 fileset 累加)
        usedPct:      capacityGiB ? Math.min(100, Math.round((usedGiB / capacityGiB) * 100)) : 0,
        storageType:  f.StorageType || '',
        zoneId:       f.ZoneId || '',
        status:       f.Status || '',
        createTime:   f.CreateTime || '',
      });
    }
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: '查询 CPFS 文件系统失败: ' + err.message });
  }
});

// GET /api/pai/filesets?region=&fs=<fileSystemId>  指定 CPFS 文件系统下的 fileset 列表
router.get('/filesets', authenticate, async (req, res) => {
  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, req.query.region);
  try {
    const nas = nasClient(cred, region);
    // 优先用传入的 fs（文件系统 ID）；未传则回退到默认 CPFS
    let fsId = req.query.fs;
    let fsDesc = '';
    if (!fsId) {
      const info = await getCpfsInfo(nas, region);
      if (!info) return res.json({ items: [], fileSystem: null });
      fsId = info.fileSystemId; fsDesc = info.description;
    }
    const out = await nas.request('DescribeFilesets', { RegionId: region, FileSystemId: fsId, PageSize: 100 }, { method: 'POST' });
    const entries = (out.Entries && out.Entries.Entrie) || out.Entries || [];
    const items = entries.map(e => {
      const q = e.Quota || {};
      return {
        fsetId:        e.FsetId,
        name:          e.Description || '',
        path:          e.FileSystemPath || '',
        status:        e.Status || '',
        sizeLimitGiB:  q.SizeLimit ? Math.round(q.SizeLimit / 1024 / 1024 / 1024) : 0,
        usedBytes:     e.SpaceUsage || 0,
        usedGiB:       e.SpaceUsage ? +(e.SpaceUsage / 1024 / 1024 / 1024).toFixed(2) : 0,
        fileCountLimit: q.FileCountLimit || 0,
        fileCountUsage: e.FileCountUsage || 0,
        deletionProtection: !!e.DeletionProtection,
        createTime:    e.CreateTime || '',
      };
    });
    res.json({ items, fileSystem: { id: fsId, description: fsDesc } });
  } catch (err) {
    res.status(500).json({ error: '查询 CPFS fileset 失败: ' + err.message });
  }
});

// GET /api/pai/baidu-cfs  百度云 CFS 文件系统列表（并行文件存储页 - 百度 tab）
router.get('/baidu-cfs', authenticate, async (req, res) => {
  const cred = await db.get("SELECT * FROM platform_credentials WHERE platform = 'baidu' AND enabled = 1");
  if (!cred) return res.status(400).json({ error: '百度云未配置主账号凭据' });
  try {
    const out = await bceRequest(cred, 'GET', '/v1/cfs', {}, null, 'cfs.bj.baidubce.com');
    const items = (out.fileSystemList || []).map(f => {
      const usedBytes = parseInt(f.fsUsage || '0', 10) || 0;
      const mounts = (f.mountTargetList || []).map(m => m.ovip).filter(Boolean);
      return {
        fsId:       f.fsId,
        name:       f.fsName || f.fsId,
        type:       f.type || '',           // ssd / capacity
        protocol:   f.protocol || '',        // nfs
        status:     f.status || '',
        usedBytes,
        usedGiB:    +(usedBytes / 1024 / 1024 / 1024).toFixed(2),
        capacityQuota: f.capacityQuota || 0,
        zone:       f.zone || '',
        mountIps:   mounts,
        createTime: f.createTime || '',
      };
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: '查询百度云 CFS 失败: ' + err.message });
  }
});

// GET /api/pai/ecs-specs?region=&type=CPU|GPU
router.get('/ecs-specs', authenticate, async (req, res) => {
  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, req.query.region);
  const acceleratorType = (req.query.type || 'CPU').toUpperCase();
  try {
    const client = dswClient(cred, region);
    const out = await client.request('GET', '/api/v2/ecsspecs', { AcceleratorType: acceleratorType, PageSize: 100 }, '', JSON_HEADER);
    const items = (out.EcsSpecs || []).map(s => ({
      instanceType:    s.InstanceType,
      cpu:             s.CPU,
      memory:          s.Memory,
      acceleratorType: s.AcceleratorType || acceleratorType,
      gpu:             s.GPU || 0,
      gpuType:         s.GPUType || '',
    }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: '查询规格失败: ' + err.message });
  }
});

// ── workspace 成员管理 ────────────────────────────────────

// 拉取某 workspace 的自定义角色（RoleId -> RoleName）
async function fetchWorkspaceCustomRoles(client, wsId) {
  const out = await client.request('GET', `/api/v1/workspaces/${wsId}/roles`, { PageSize: 100, PageNumber: 1 }, '', JSON_HEADER);
  return (out.Roles || []).map(r => ({ value: r.RoleId, label: r.RoleName || r.RoleId, custom: true }));
}

// GET /api/pai/workspaces/:wsId/roles?region=  可分配角色清单（内置 + 自定义）
router.get('/workspaces/:wsId/roles', authenticate, requireGroup('compute'), async (req, res) => {
  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, req.query.region);
  try {
    const client = wsClient(cred, region);
    const custom = await fetchWorkspaceCustomRoles(client, req.params.wsId);
    const builtin = PAI_BUILTIN_ROLES.map(r => ({ ...r, custom: false }));
    res.json({ builtin, custom });
  } catch (err) {
    res.status(500).json({ error: '查询角色失败: ' + err.message });
  }
});

// 组合角色标识 -> 显示名的映射（内置中文名 + 自定义 RoleName）
function buildRoleLabelMap(customRoles) {
  const map = {};
  PAI_BUILTIN_ROLES.forEach(r => { map[r.value] = r.label; });
  (customRoles || []).forEach(r => { map[r.value] = r.label; });
  return map;
}

// GET /api/pai/workspaces/:wsId/members?region=  当前成员
router.get('/workspaces/:wsId/members', authenticate, requireGroup('compute'), async (req, res) => {
  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, req.query.region);
  try {
    const client = wsClient(cred, region);
    // 同时拉成员和自定义角色，用于把 role-xxx 映射成可读名称
    const [out, customRoles, ramNames] = await Promise.all([
      client.request('GET', `/api/v1/workspaces/${req.params.wsId}/members`, { PageSize: 100, PageNumber: 1 }, '', JSON_HEADER),
      fetchWorkspaceCustomRoles(client, req.params.wsId).catch(() => []),
      fetchRamDisplayNames(cred).catch(() => ({})),
    ]);
    const labelMap = buildRoleLabelMap(customRoles);
    const items = (out.Members || []).map(m => {
      const roles = m.Roles || [];
      return {
        userId:      m.UserId,
        memberId:    m.MemberId,
        displayName: liveRamName(ramNames, m.UserId, m.MemberName, m.DisplayName || m.MemberName),
        roles,                                              // 原始标识
        roleLabels:  roles.map(r => labelMap[r] || r),      // 可读名称
      };
    });
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: '查询成员失败: ' + err.message });
  }
});

// GET /api/pai/workspaces/:wsId/candidate-users?region=  可加入的 RAM 用户（排除服务角色）
router.get('/workspaces/:wsId/candidate-users', authenticate, requireGroup('compute'), async (req, res) => {
  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, req.query.region);
  try {
    const client = wsClient(cred, region);
    const [out, ramNames] = await Promise.all([
      client.request('GET', `/api/v1/workspaces/${req.params.wsId}/users`, { PageSize: 100, PageNumber: 1 }, '', JSON_HEADER),
      fetchRamDisplayNames(cred).catch(() => ({})),
    ]);
    // AccountType=6 是服务角色（如 AliyunServiceRoleFor...），排除
    const items = (out.Users || [])
      .filter(u => u.AccountType !== '6' && !String(u.UserId).startsWith('ROLE_'))
      .map(u => ({
        userId:      u.UserId,
        userName:    liveRamName(ramNames, u.UserId, u.UserName, u.DisplayName || u.UserName),
        accountType: u.AccountType || '',
      }));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: '查询候选用户失败: ' + err.message });
  }
});

// POST /api/pai/workspaces/:wsId/members  加成员，支持多角色
// body: { region, user_id, roles: [] }  roles 元素可为内置(PAI.*)或自定义(role-xxx)
router.post('/workspaces/:wsId/members', authenticate, requireOperate('compute'), async (req, res) => {
  const { region, user_id, roles } = req.body || {};
  if (!user_id || !Array.isArray(roles) || !roles.length) {
    return res.status(400).json({ error: '请提供 user_id 和至少一个角色' });
  }

  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const rgn = resolveRegion(cred, region);

  try {
    const client = wsClient(cred, rgn);
    // 校验角色：内置值 或 该 workspace 存在的自定义 RoleId
    const customRoles = await fetchWorkspaceCustomRoles(client, req.params.wsId).catch(() => []);
    const validSet = new Set([...PAI_BUILTIN_ROLE_VALUES, ...customRoles.map(r => r.value)]);
    const bad = roles.filter(r => !validSet.has(r));
    if (bad.length) return res.status(400).json({ error: `非法角色: ${bad.join(', ')}` });

    const body = JSON.stringify({ Members: [{ UserId: user_id, Roles: roles }] });
    await client.request('POST', `/api/v1/workspaces/${req.params.wsId}/members`, {}, body, JSON_HEADER);
  } catch (err) {
    return res.status(500).json({ error: '添加成员失败: ' + err.message });
  }
  res.status(201).json({ message: '成员添加成功' });
});

// DELETE /api/pai/workspaces/:wsId/members/:memberId?region=  删成员
router.delete('/workspaces/:wsId/members/:memberId', authenticate, requireOperate('compute'), async (req, res) => {
  const cred = await getAliyunCred();
  if (!cred) return res.status(400).json({ error: '阿里云未配置主账号凭据' });
  const region = resolveRegion(cred, req.query.region);

  try {
    const client = wsClient(cred, region);
    await client.request('DELETE', `/api/v1/workspaces/${req.params.wsId}/members`, { MemberIds: req.params.memberId }, '', JSON_HEADER);
  } catch (err) {
    return res.status(500).json({ error: '移除成员失败: ' + err.message });
  }
  res.json({ message: '成员移除成功' });
});

module.exports = router;
module.exports.createAliyunDswInstance = createAliyunDswInstance;
