// 导航菜单目录：父子两级权限的唯一数据源。
// 前端按它渲染角色弹窗的勾选项，后端按它把 section 解析到所属菜单组。
// 新增菜单项时，这里、index.html 的导航、state.js 的 SECTION_GROUP 要一起改。

const MENU_CATALOG = [
  { group: 'tickets',  label: '工单申请', children: [
    { section: 'apply-account', label: '账号申请' },
    { section: 'apply-resource', label: '资源申请' },
    { section: 'approval-tickets', label: '申请记录' }
  ]},
  { group: 'accounts', label: '账号资源', children: [
    { section: 'cloud-accounts', label: '云账号' },
    { section: 'create', label: '创建账号' },
    { section: 'groups', label: '组同步' },
    { section: 'policies', label: '策略管理' }
  ]},
  { group: 'compute',  label: '计算资源', children: [
    { section: 'instances', label: '云主机' },
    { section: 'clusters', label: '容器集群' },
    { section: 'pai-dsw', label: 'PAI DSW' }
  ]},
  { group: 'database', label: '数据库资源', children: [
    { section: 'rds-mysql', label: 'MySQL 实例' },
    { section: 'rds-postgres', label: 'PostgreSQL 实例' },
    { section: 'rds-redis', label: 'Redis 实例' }
  ]},
  { group: 'network',  label: '网络资源', children: [
    { section: 'security-groups', label: '安全组' },
    { section: 'vpcs', label: 'VPC' },
    { section: 'subnets', label: '子网' },
    { section: 'ssl-certs', label: 'SSL 证书' },
    { section: 'dns-records', label: 'DNS 解析' },
    { section: 'vpn-clients', label: 'VPN 客户端' }
  ]},
  { group: 'storage',  label: '存储资源', children: [
    { section: 'disks', label: '磁盘' },
    { section: 'buckets', label: '对象存储' },
    { section: 'cpfs', label: 'CPFS 存储' }
  ]},
  { group: 'billing',  label: '费用账单', children: [
    { section: 'billing-aws', label: 'AWS 账单' },
    { section: 'billing-aliyun', label: '阿里云账单' },
    { section: 'billing-baidu', label: '百度云账单' }
  ]},
  { group: 'system',   label: '系统设置', children: [
    { section: 'roles', label: '系统角色' },
    { section: 'admin-accounts', label: '系统账号' },
    { section: 'settings', label: '接入集成' },
    { section: 'audit', label: '操作审计' }
  ]}
];

// section → 所属菜单组
const SECTION_GROUP = {};
MENU_CATALOG.forEach(g => g.children.forEach(c => { SECTION_GROUP[c.section] = g.group; }));

// 合法的子菜单 section 集合，用于校验角色提交的 accessible_sections
const VALID_SECTIONS = new Set(Object.keys(SECTION_GROUP));

module.exports = { MENU_CATALOG, SECTION_GROUP, VALID_SECTIONS };
