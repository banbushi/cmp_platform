'use strict';

const PLATFORM_NAMES = {
  aws:        'Amazon Web Services',
  aliyun:     '阿里云',
  baidu:      '百度智能云',
  bytebase:   'Bytebase',
  jumpserver: 'JumpServer',
  kuboard:    'Kuboard',
  'grafana-aws':   'Grafana (AWS)',
  'grafana-wuwen': 'Grafana (无问)',
  'grafana-baidu': 'Grafana (百度)',
};

// 平台类型分类
const PLATFORM_TYPES = {
  CLOUD: 'cloud',  // 云平台（AWS、阿里云、百度云）
  TOOL: 'tool',    // 工具平台（JumpServer、Bytebase、Kuboard、Grafana）
};

// 平台分类映射
const PLATFORM_CATEGORY = {
  aws: PLATFORM_TYPES.CLOUD,
  aliyun: PLATFORM_TYPES.CLOUD,
  baidu: PLATFORM_TYPES.CLOUD,
  bytebase: PLATFORM_TYPES.TOOL,
  jumpserver: PLATFORM_TYPES.TOOL,
  kuboard: PLATFORM_TYPES.TOOL,
  'grafana-aws': PLATFORM_TYPES.TOOL,
  'grafana-wuwen': PLATFORM_TYPES.TOOL,
  'grafana-baidu': PLATFORM_TYPES.TOOL,
};

module.exports = {
  PLATFORM_NAMES,
  PLATFORM_TYPES,
  PLATFORM_CATEGORY,
};
