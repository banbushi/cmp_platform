// ═══════════════════════════════════════════════════════════════
// 全局状态与常量
// ═══════════════════════════════════════════════════════════════

const API = '/api';
let token = localStorage.getItem('token');
let me = null;
let allUsers = [];
let credStatus = {};

// 申请项可见性配置缺失的 key 默认视为可见(true)
let _applyVis = { account: {}, resource: {}, vpn: {}, feature: {} };

async function refreshApplyVisibility() {
  _applyVis = { account: {}, resource: {}, vpn: {}, feature: {} };
  return _applyVis;
}

function isAccountPlatformVisible(platform) {
  return _applyVis.account?.[platform] !== false;
}

function isResourceTypeVisible(platform, type) {
  return _applyVis.resource?.[platform]?.[type] !== false;
}

function isVpnPlatformVisible(platform) {
  return _applyVis.vpn?.[platform] !== false;
}

// 可由管理员关闭的功能入口（section → 显示名），关闭后菜单项隐藏且不可直达
const FEATURE_SECTIONS = {
  'pai-dsw': 'PAI DSW'
};

function isFeatureVisible(section) {
  return _applyVis.feature?.[section] !== false;
}

// 创建账号流程状态
let POLICIES = {};
let currentStep = 1;
let selectedPlatforms = new Set();
let syncedGroupsData = {};
const policyState = {};
const checkedPolicies = {};

// 分页状态
let groupFilter = 'all';
let _grpPage = 1, _grpPageSize = 20, _grpFiltered = [];
let instPlatformFilter = 'all';
let instStatusFilter = 'all';
let _instCurrentPage = 1;
let _instPageSize = 20;
let _instFilteredData = [];

// 平台和角色常量
const PNAMES = {
  aws: 'Amazon Web Services',
  aliyun: '阿里云',
  baidu: '百度智能云',
  bytebase: 'Bytebase',
  jumpserver: 'JumpServer',
  kuboard: 'Kuboard',
  'grafana-aws': 'Grafana (AWS)',
  'grafana-wuwen': 'Grafana (无问)',
  'grafana-baidu': 'Grafana (百度)'
};

const PROLES = {
  user: '普通用户',
  developer: '开发者',
  ops: '运维人员',
  admin: '管理员',
  viewer: '只读权限',
  operator: '操作权限',
  billing: '账单查看',
  applicant: '申请人'
};

const ROLE_TAG = {
  user: 'tag-user',
  developer: 'tag-dev',
  ops: 'tag-ops',
  admin: 'tag-admin',
  viewer: 'tag-user',
  operator: 'tag-ops',
  billing: 'tag-user',
  applicant: 'tag-user'
};

// 权限相关
let _myRoleData = null;
let _allRoles = [];

const GROUP_LABELS = {
  accounts: '账号资源',
  compute: '计算资源',
  database: '数据库资源',
  network: '网络资源',
  storage: '存储资源',
  billing: '费用账单',
  system: '系统设置',
  tickets: '工单申请'
};

// 子菜单显示名，用于角色列表里展示已勾选的子菜单
const SECTION_LABELS = {
  'apply-account': '账号申请', 'apply-resource': '资源申请', 'approval-tickets': '申请记录',
  'cloud-accounts': '云账号', create: '创建账号', groups: '组同步', policies: '策略管理',
  instances: '云主机', clusters: '容器集群', 'pai-dsw': 'PAI DSW',
  'rds-mysql': 'MySQL 实例', 'rds-postgres': 'PostgreSQL 实例', 'rds-redis': 'Redis 实例',
  'security-groups': '安全组', vpcs: 'VPC', subnets: '子网', 'ssl-certs': 'SSL 证书', 'dns-records': 'DNS 解析', 'vpn-clients': 'VPN 客户端',
  disks: '磁盘', buckets: '对象存储', cpfs: 'CPFS 存储',
  'billing-aws': 'AWS 账单', 'billing-aliyun': '阿里云账单', 'billing-baidu': '百度云账单',
  roles: '系统角色', 'admin-accounts': '系统账号', settings: '接入集成', audit: '操作审计'
};

// 角色对某个子菜单是否可见。
// accessible_sections 为 null/缺省时不限制（组内全部可见），兼容只存菜单组的旧角色。
function roleHasSection(roleData, section) {
  if (!roleData) return false;
  const group = SECTION_GROUP[section];
  if (group && !(roleData.accessible_groups || []).includes(group)) return false;
  const sections = roleData.accessible_sections;
  if (!Array.isArray(sections)) return true;
  return sections.includes(section);
}

const BUILTIN_ROLE_DEFAULTS = {
  admin: {
    accessible_groups: ['accounts', 'compute', 'database', 'network', 'storage', 'billing', 'system', 'tickets'],
    can_operate: true
  },
  operator: {
    accessible_groups: ['compute', 'database', 'network', 'storage', 'tickets'],
    can_operate: true
  },
  viewer: {
    accessible_groups: ['compute', 'database', 'network', 'storage', 'tickets'],
    can_operate: false
  },
  billing: {
    accessible_groups: ['billing'],
    can_operate: false
  },
  applicant: {
    accessible_groups: ['tickets'],
    can_operate: false
  }
};

// 导航相关
const SECTION_GROUP = {
  'cloud-accounts': 'accounts',
  create: 'accounts',
  sync: 'accounts',
  groups: 'accounts',
  policies: 'accounts',
  'approval-tickets': 'tickets',
  'my-tickets': 'tickets',
  'apply-account': 'tickets',
  'apply-resource': 'tickets',
  'my-profile': 'profile',
  'perm-query': 'profile',
  instances: 'compute',
  clusters: 'compute',
  'pai-dsw': 'compute',
  'rds-mysql': 'database',
  'rds-postgres': 'database',
  'rds-redis': 'database',
  'security-groups': 'network',
  vpcs: 'network',
  subnets: 'network',
  'ssl-certs': 'network',
  'dns-records': 'network',
  'vpn-clients': 'network',
  disks: 'storage',
  buckets: 'storage',
  cpfs: 'storage',
  'billing-aws': 'billing',
  'billing-aliyun': 'billing',
  'billing-baidu': 'billing',
  settings: 'system',
  'admin-accounts': 'system',
  roles: 'system',
  audit: 'system',
  'feishu-config': 'system'
};

const SEC_ID_MAP = {
  'billing-aws': 'billing',
  'billing-aliyun': 'billing',
  'billing-baidu': 'billing',
  'feishu-config': 'settings'
};

let _billingPlatform = 'aws';
