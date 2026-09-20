'use strict';

const { PLATFORM_NAMES, PLATFORM_TYPES, PLATFORM_CATEGORY } = require('./constants');

/**
 * 平台注册表
 *
 * 平台名称（display_name）和分类（category）以数据库 platform_credentials 表为准；
 * 代码层仅保留无法配置化的逻辑——登录地址的获取方式（工具平台从凭据读取，云平台需调用 SDK）。
 *
 * 凭据字段约定（platform_credentials 表）:
 *   - AWS / 阿里云 / 百度云 : access_key=AK, secret_key=SK, region=区域
 *   - JumpServer           : access_key=API Key ID, secret_key=API Key Secret, region=baseUrl
 *   - Bytebase             : access_key=baseUrl, secret_key=API Token
 *   - Kuboard              : region=URL
 *   - Grafana-*            : access_key=URL, secret_key=API Token
 */

// 各平台登录地址的获取逻辑（纯函数，不涉及配置数据）
const CONSOLE_URL_RESOLVERS = {
  aws: async (cred) => {
    try {
      const { IAMClient, GetUserCommand } = require('@aws-sdk/client-iam');
      const client = new IAMClient({
        region: cred.region || 'us-east-1',
        credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key },
      });
      const res = await client.send(new GetUserCommand({}));
      const match = (res.User?.Arn || '').match(/arn:aws:iam::(\d+):/);
      if (match) return `https://${match[1]}.signin.aws.amazon.com/console`;
    } catch (e) {
      console.warn(`[platform-registry] AWS 获取控制台 URL 失败: ${e.message}`);
    }
    return '';
  },

  aliyun: async (cred) => {
    try {
      const Core = require('@alicloud/pop-core');
      const client = new Core({
        accessKeyId: cred.access_key, accessKeySecret: cred.secret_key,
        endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01',
      });
      try {
        const res = await client.request('GetAccountAlias', {}, { method: 'GET' });
        if (res.AccountAlias) return `https://signin.aliyun.com/${res.AccountAlias}/login.htm`;
      } catch { /* ignore */ }
      return 'https://ram.console.aliyun.com/';
    } catch (e) {
      console.warn(`[platform-registry] 阿里云获取控制台 URL 失败: ${e.message}`);
    }
    return 'https://ram.console.aliyun.com/';
  },

  baidu: async (cred) => {
    try {
      const bceRequest = require('./bce');
      const bosRegion = cred.region || 'bj';
      const bosRes = await bceRequest(cred, 'GET', '/', {}, null, `${bosRegion}.bcebos.com`);
      const accountId = bosRes.owner?.id;
      if (accountId && /^[0-9a-f]{32}$/.test(accountId)) {
        return `http://${accountId}.login.bce.baidu.com/`;
      }
    } catch (e) {
      console.warn(`[platform-registry] 百度云获取控制台 URL 失败: ${e.message}`);
    }
    return 'https://login.bce.baidu.com/';
  },
};

// 工具平台的 URL 字段映射：platform → 从 cred 的哪个字段读取登录地址
const TOOL_URL_FIELD = {
  jumpserver:      'region',
  bytebase:        'access_key',
  kuboard:         'access_key',
  'grafana-aws':   'access_key',
  'grafana-wuwen': 'access_key',
  'grafana-baidu': 'access_key',
};

function stripTrailingSlash(s) { return s ? s.replace(/\/+$/, '') : ''; }

/* ── 公共工具函数 ────────────────────────────────── */

/**
 * 获取平台控制台 / 登录地址
 * 云平台调用 SDK 动态获取，工具平台从凭据字段直接读取。
 */
async function getConsoleLoginUrl(platform, cred) {
  try {
    // 云平台：使用专属 resolver
    const resolver = CONSOLE_URL_RESOLVERS[platform];
    if (resolver) return await resolver(cred);

    // 工具平台：从凭据字段读取 URL
    const field = TOOL_URL_FIELD[platform];
    if (field && cred[field]) return stripTrailingSlash(cred[field]);
  } catch (e) {
    console.warn(`[platform-registry] 获取 ${platform} 登录地址失败: ${e.message}`);
  }
  return '';
}

/**
 * 获取平台显示名称
 * 优先从数据库凭据行的 display_name 字段读取，否则回退到 constants.js 硬编码值。
 * @param {string} platform - 平台标识
 * @param {object} [cred]   - 可选，数据库 platform_credentials 行（含 display_name 字段）
 */
function getPlatformName(platform, cred) {
  if (cred?.display_name) return cred.display_name;
  return PLATFORM_NAMES[platform] || platform;
}

/**
 * 判断是否为工具平台
 * 优先从数据库凭据行的 category 字段读取，否则回退到 constants.js 硬编码值。
 * @param {string} platform - 平台标识
 * @param {object} [cred]   - 可选，数据库 platform_credentials 行（含 category 字段）
 */
function isToolPlatform(platform, cred) {
  const cat = cred?.category || PLATFORM_CATEGORY[platform];
  return cat === PLATFORM_TYPES.TOOL;
}

/**
 * 判断是否为云平台
 */
function isCloudPlatform(platform, cred) {
  const cat = cred?.category || PLATFORM_CATEGORY[platform];
  return cat === PLATFORM_TYPES.CLOUD;
}

module.exports = {
  getConsoleLoginUrl,
  getPlatformName,
  isToolPlatform,
  isCloudPlatform,
  TOOL_URL_FIELD,
};
