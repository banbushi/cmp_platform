/**
 * K8s Kubeconfig 生成服务
 * 审批通过后：连接目标集群 → 创建 SA + RoleBinding → 取 token → 组装限定 namespace 的 kubeconfig
 */
const k8s = require('@kubernetes/client-node');
const { ROAClient } = require('@alicloud/pop-core');
const yaml = require('@kubernetes/client-node/dist/config_types');
const bceRequest = require('./bce');

// @kubernetes/client-node 1.x 的 ApiException 用 e.code 存 HTTP 状态码；旧版是 e.statusCode。兼容两者。
function httpStatus(e) {
  return e?.code ?? e?.statusCode ?? e?.response?.statusCode;
}

// ── 获取集群 admin kubeconfig ────────────────────────────

/**
 * 阿里云 ACK：调 /k8s/{clusterId}/user_config 获取 admin kubeconfig YAML
 */
async function _getAckAdminConfig(cred, clusterId, region) {
  const client = new ROAClient({
    accessKeyId: cred.access_key,
    accessKeySecret: cred.secret_key,
    endpoint: `https://cs.${region}.aliyuncs.com`,
    apiVersion: '2015-12-15',
    opts: { timeout: 30000 },
  });
  const r = await client.request('GET', `/k8s/${clusterId}/user_config`, {}, '', { 'content-type': 'application/json' });
  if (!r.config) throw new Error('ACK 返回的 kubeconfig 为空');
  return r.config; // YAML string
}

/**
 * 百度云 CCE：调 GET /v2/kubeconfig/{clusterID}/{type} 获取 admin kubeconfig YAML
 * type 仅支持 vpc / public；平台在内网访问集群，优先 vpc，失败回退 public
 */
async function _getBaiduCceAdminConfig(cred, clusterId, region) {
  const host = `cce.${region || cred.region || 'bj'}.baidubce.com`;
  const fetchByType = async (type) => {
    const r = await bceRequest(cred, 'GET', `/v2/kubeconfig/${clusterId}/${type}`, {}, null, host);
    return r?.kubeConfig || r?.kubeconfig || '';
  };
  let yamlStr = '';
  try {
    yamlStr = await fetchByType('vpc');
  } catch (e) {
    // vpc 拿不到（如集群未开 vpc 访问）时回退 public
    yamlStr = await fetchByType('public');
  }
  if (!yamlStr) throw new Error('百度云 CCE 返回的 kubeconfig 为空');
  return yamlStr;
}

/**
 * 确保指定 IAM principal 在 EKS 集群有访问条目（Access Entry）并关联 ClusterAdmin 策略。
 * EKS 认证要求 IAM 身份先登记进集群准入，否则用主账号连集群会 401/403。幂等：已存在则跳过。
 */
async function _ensureEksAccessEntry(eks, clusterName, principalArn) {
  const {
    CreateAccessEntryCommand, AssociateAccessPolicyCommand,
    DescribeAccessEntryCommand, ResourceInUseException,
  } = require('@aws-sdk/client-eks');
  if (!principalArn) throw new Error('无法获取主账号 IAM 身份 ARN');

  // access entry（已存在则忽略冲突）
  let entryExists = false;
  try {
    await eks.send(new DescribeAccessEntryCommand({ clusterName, principalArn }));
    entryExists = true;
  } catch (e) {
    if (e.name !== 'ResourceNotFoundException') throw e;
  }
  if (!entryExists) {
    try {
      await eks.send(new CreateAccessEntryCommand({ clusterName, principalArn }));
    } catch (e) {
      // 并发或已存在
      if (!(e instanceof ResourceInUseException) && e.name !== 'ResourceInUseException') throw e;
    }
  }

  // 关联 ClusterAdmin 访问策略（cluster 作用域）。重复关联是幂等的。
  await eks.send(new AssociateAccessPolicyCommand({
    clusterName,
    principalArn,
    policyArn: 'arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy',
    accessScope: { type: 'cluster' },
  }));
}

/**
 * AWS EKS：describe-cluster 拿 endpoint+CA，用 STS presigned URL 生成 bearer token
 */
async function _getEksAdminConfig(cred, clusterName, region) {
  const { EKSClient, DescribeClusterCommand } = require('@aws-sdk/client-eks');
  const { STSClient, GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
  const credentials = { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key };

  const eks = new EKSClient({ region, credentials });

  // 确保主账号 IAM 身份在该集群有访问权限（EKS Access Entry），否则连集群会 401/403
  const sts = new STSClient({ region, credentials });
  const identity = await sts.send(new GetCallerIdentityCommand({}));
  await _ensureEksAccessEntry(eks, clusterName, identity.Arn);

  const resp = await eks.send(new DescribeClusterCommand({ name: clusterName }));
  const endpoint = resp.cluster?.endpoint;
  const ca = resp.cluster?.certificateAuthority?.data;
  if (!endpoint || !ca) throw new Error('EKS 集群信息不完整');

  // 生成 STS presigned token (aws-iam-authenticator 兼容方式)
  const { HttpRequest } = require('@smithy/protocol-http');
  const { SignatureV4 } = require('@smithy/signature-v4');
  const { Sha256 } = require('@aws-crypto/sha256-js');
  const signer = new SignatureV4({ credentials, region, service: 'sts', sha256: Sha256 });
  const request = new HttpRequest({
    method: 'GET',
    protocol: 'https:',
    hostname: `sts.${region}.amazonaws.com`,
    path: '/',
    query: { Action: 'GetCallerIdentity', Version: '2011-06-15' },
    headers: { host: `sts.${region}.amazonaws.com`, 'x-k8s-aws-id': clusterName },
  });
  const signed = await signer.presign(request, { expiresIn: 60 });
  const signedUrl = `https://${signed.hostname}${signed.path}?${new URLSearchParams(signed.query).toString()}`;
  const token = 'k8s-aws-v1.' + Buffer.from(signedUrl).toString('base64url');

  // 组装 admin kubeconfig YAML
  return `apiVersion: v1
clusters:
- cluster:
    server: ${endpoint}
    certificate-authority-data: ${ca}
  name: eks-cluster
contexts:
- context:
    cluster: eks-cluster
    user: eks-admin
  name: eks-context
current-context: eks-context
kind: Config
users:
- name: eks-admin
  user:
    token: ${token}
`;
}

// ── 核心：生成限定 namespace 的 kubeconfig ────────────────

/**
 * @param {string} platform - aws/aliyun/baidu
 * @param {object} cred - platform_credentials 行
 * @param {string} clusterId - cloud_clusters.cluster_id
 * @param {string} clusterRegion - 集群所在 region
 * @param {string} username - 申请人用户名（用于 SA 命名）
 * @param {string} namespace - 目标 namespace
 * @param {string} permission - view/edit/admin
 * @returns {{ kubeconfig: string, saName: string }} 限定权限的 kubeconfig YAML
 */
async function generateNamespacedKubeconfig(platform, cred, clusterId, clusterRegion, username, namespace, permission) {
  // 1. 获取 admin kubeconfig
  let adminConfigYaml;
  if (platform === 'aliyun') {
    adminConfigYaml = await _getAckAdminConfig(cred, clusterId, clusterRegion);
  } else if (platform === 'aws') {
    adminConfigYaml = await _getEksAdminConfig(cred, clusterId, clusterRegion);
  } else if (platform === 'baidu') {
    adminConfigYaml = await _getBaiduCceAdminConfig(cred, clusterId, clusterRegion);
  } else {
    throw new Error(`暂不支持 ${platform} 集群的 kubeconfig 生成`);
  }

  // 2. 用 admin config 连集群
  const kc = new k8s.KubeConfig();
  kc.loadFromString(adminConfigYaml);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  const rbacApi = kc.makeApiClient(k8s.RbacAuthorizationV1Api);

  // SA 命名：cmp-{username}（同 namespace 内唯一）
  const saName = `cmp-${username.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;

  // 3. 创建 namespace（如果不存在）
  try {
    await coreApi.readNamespace({ name: namespace });
  } catch (e) {
    if (httpStatus(e) === 404) {
      await coreApi.createNamespace({ body: { metadata: { name: namespace } } });
    } else throw e;
  }

  // 4. 创建 ServiceAccount（已存在则复用）
  try {
    await coreApi.readNamespacedServiceAccount({ name: saName, namespace });
  } catch (e) {
    if (httpStatus(e) === 404) {
      await coreApi.createNamespacedServiceAccount({
        namespace,
        body: { metadata: { name: saName, namespace } }
      });
    } else throw e;
  }

  // 5. 创建 RoleBinding（绑定内置 ClusterRole view/edit/admin 到该 SA，限定 namespace）
  const rbName = `${saName}-${permission}`;
  const clusterRole = permission === 'admin' ? 'admin' : (permission === 'edit' ? 'edit' : 'view');
  const rbBody = {
    metadata: { name: rbName, namespace },
    roleRef: { apiGroup: 'rbac.authorization.k8s.io', kind: 'ClusterRole', name: clusterRole },
    subjects: [{ kind: 'ServiceAccount', name: saName, namespace }],
  };
  try {
    await rbacApi.readNamespacedRoleBinding({ name: rbName, namespace });
    // 已存在则更新
    await rbacApi.replaceNamespacedRoleBinding({ name: rbName, namespace, body: rbBody });
  } catch (e) {
    if (httpStatus(e) === 404) {
      await rbacApi.createNamespacedRoleBinding({ namespace, body: rbBody });
    } else throw e;
  }

  // 6. 获取 SA token（K8s 1.24+ 用 TokenRequest API）
  let token;
  try {
    const tokenResp = await coreApi.createNamespacedServiceAccountToken({
      name: saName,
      namespace,
      body: { spec: { expirationSeconds: 86400 * 365 } } // 1 年有效
    });
    token = tokenResp.status?.token;
  } catch (e) {
    // 回退：查 SA 关联的 Secret
    const sa = await coreApi.readNamespacedServiceAccount({ name: saName, namespace });
    const secretName = (sa.secrets || [])[0]?.name;
    if (!secretName) throw new Error('无法获取 SA token（集群可能不支持 TokenRequest 且无自动 Secret）');
    const secret = await coreApi.readNamespacedSecret({ name: secretName, namespace });
    token = Buffer.from(secret.data?.token || '', 'base64').toString();
  }
  if (!token) throw new Error('生成 SA token 失败');

  // 7. 从 admin config 提取 cluster 信息，组装限定权限 kubeconfig
  const cluster = kc.clusters[0];
  const kubeconfig = `apiVersion: v1
kind: Config
clusters:
- cluster:
    server: ${cluster.server}
    certificate-authority-data: ${cluster.caData || ''}
  name: ${clusterId}
contexts:
- context:
    cluster: ${clusterId}
    namespace: ${namespace}
    user: ${saName}
  name: ${clusterId}-${namespace}
current-context: ${clusterId}-${namespace}
users:
- name: ${saName}
  user:
    token: ${token}
`;

  return { kubeconfig, saName, namespace, permission, clusterRole };
}

module.exports = { generateNamespacedKubeconfig };
