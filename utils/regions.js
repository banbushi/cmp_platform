// AWS 区域列表
const AWS_REGIONS = [
  'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
  'ap-south-1', 'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4',
  'ca-central-1',
  'eu-central-1', 'eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-central-2',
  'me-south-1', 'me-central-1',
  'af-south-1',
  'sa-east-1'
];

// 阿里云区域列表
const ALIYUN_REGIONS = [
  'cn-hangzhou', 'cn-shanghai', 'cn-beijing', 'cn-shenzhen', 'cn-chengdu',
  'cn-hongkong', 'cn-zhangjiakou', 'cn-huhehaote', 'cn-wulanchabu', 'cn-qingdao',
  'cn-nanjing', 'cn-fuzhou', 'cn-heyuan', 'cn-guangzhou',
  'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-5', 'ap-southeast-6', 'ap-southeast-7',
  'ap-northeast-1', 'ap-northeast-2',
  'ap-south-1',
  'eu-central-1', 'eu-west-1',
  'us-east-1', 'us-west-1',
  'me-east-1'
];

// 百度云区域列表
const BAIDU_REGIONS = [
  'bj',   // 北京
  'gz',   // 广州
  'su',   // 苏州
  'bd',   // 保定
  'hkg',  // 香港
  'fwh',  // 武汉
  'fsh',  // 上海
  'cd',   // 成都
  'sin'   // 新加坡
];

// 百度云 RDS/Redis 可用区域（fsh/sin 域名证书不匹配，排除）
const BAIDU_DB_REGIONS = [
  'bj',   // 北京
  'gz',   // 广州
  'su',   // 苏州
  'bd',   // 保定
  'hkg',  // 香港
  'fwh',  // 武汉
  'cd',   // 成都
];

module.exports = {
  AWS_REGIONS,
  ALIYUN_REGIONS,
  BAIDU_REGIONS,
  BAIDU_DB_REGIONS
};
