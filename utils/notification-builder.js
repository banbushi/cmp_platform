'use strict';

const { PLATFORM_NAMES } = require('./constants');
const { isToolPlatform } = require('./platform-registry');

/**
 * 通知消息构建器
 *
 * 统一生成飞书私信通知和审批评论文本，
 * 所有消费方（飞书机器人私信、审批评论、前端工单详情）共用同一数据源。
 */

/* ── 飞书私信通知 ──────────────────────────────────── */

/**
 * 构建账号开通飞书私信通知内容
 * @param {string} realName        - 申请人姓名
 * @param {Array}  cloudResults    - 云账号 / 工具账号开通结果
 * @param {Array}  vpnResults      - VPN 账号开通结果
 * @param {string} initialPassword - 统一初始密码
 * @returns {string} 飞书消息纯文本
 */
function buildFeishuDirectMessage(realName, cloudResults, vpnResults, initialPassword) {
  const successCloud = cloudResults.filter(r => r.status === 'active');
  const successVpn = vpnResults.filter(v => v.success);
  const hasSuccess = successCloud.length > 0 || successVpn.length > 0;
  const allFailed = cloudResults.length > 0 && successCloud.length === 0 && successVpn.length === 0;

  const lines = [];
  if (allFailed) {
    lines.push('【账号申请失败】\n');
    lines.push(`你好 ${realName || ''}，你申请的账号创建失败：\n`);
  } else if (hasSuccess) {
    lines.push('【账号开通通知】\n');
    lines.push(`你好 ${realName || ''}，你申请的账号已开通，请妥善保管以下凭据：\n`);
  }

  // 云账号 / 系统账号
  if (successCloud.length > 0) {
    lines.push('▌云账号 / 系统账号');
    for (const r of successCloud) {
      // 优先使用数据库中的 display_name，否则回退到 constants
      const pname = r.display_name || PLATFORM_NAMES[r.platform] || r.platform;
      // 优先使用数据库中的 category，否则回退到 isToolPlatform 判断
      const isTool = r.category === 'tool' || isToolPlatform(r.platform);

      lines.push(`  平台：${pname}`);
      lines.push(`  用户名：${r.login_username || r.cloud_username}`);
      lines.push(`  初始密码：${initialPassword}`);
      if (r.accessKey) lines.push(`  Access Key：${r.accessKey}`);
      if (r.secretKey) lines.push(`  Secret Key：${r.secretKey}`);
      if (r.consoleUrl) lines.push(`  ${isTool ? '登录地址' : '控制台登录'}：${r.consoleUrl}`);
      lines.push('');
    }
  }

  // 显示失败的账号
  const failedCloud = cloudResults.filter(r => r.status !== 'active');
  if (failedCloud.length > 0) {
    lines.push('▌创建失败');
    for (const r of failedCloud) {
      const pname = r.display_name || PLATFORM_NAMES[r.platform] || r.platform;
      lines.push(`  ✗ ${pname}：${r.message}`);
    }
    lines.push('');
  }

  // VPN 账号
  if (successVpn.length > 0) {
    lines.push('▌VPN 账号');
    for (const v of successVpn) {
      const pname = PLATFORM_NAMES[v.platform] || v.platform;
      lines.push(`  平台：${pname}  客户端：${v.clientName}`);
      if (initialPassword) lines.push(`  密码：${initialPassword}`);
    }
    lines.push('');
  }

  if (hasSuccess) {
    lines.push('请登录后及时修改密码。');
  }
  return lines.join('\n');
}

/* ── 飞书审批评论 ──────────────────────────────────── */

/**
 * 构建开通结果备注文本（写入飞书审批实例评论）
 * @param {Array} cloudResults   - 云账号开通结果
 * @param {Array} vpnResults     - VPN 账号开通结果
 * @param {Array} storageResults - 存储桶授权结果
 * @param {Array} bucketResults  - 存储桶创建结果
 * @param {Array} rdsResults     - RDS 数据库账号结果
 * @returns {string} 审批评论纯文本
 */
function buildApprovalComment(cloudResults, vpnResults, storageResults = [], bucketResults = [], rdsResults = []) {
  const lines = ['【开通结果】资源已自动开通\n'];

  if (cloudResults.length > 0) {
    lines.push('▌云账号（IAM）');
    for (const r of cloudResults) {
      const pname = r.display_name || PLATFORM_NAMES[r.platform] || r.platform;
      if (r.status === 'active') {
        const akHint = r.accessKey ? `  AK：${r.accessKey.slice(0, 8)}***` : '';
        lines.push(`  ✓ ${pname}  用户名：${r.login_username || r.cloud_username}${akHint}`);
      } else {
        lines.push(`  ✗ ${pname}  失败：${r.message}`);
      }
    }
  }

  if (vpnResults.length > 0) {
    if (cloudResults.length > 0) lines.push('');
    lines.push('▌VPN 账号');
    for (const v of vpnResults) {
      const pname = PLATFORM_NAMES[v.platform] || v.platform;
      if (v.success) {
        lines.push(`  ✓ ${pname}  客户端：${v.clientName}  ID：${v.clientId}`);
      } else {
        lines.push(`  ✗ ${pname}  失败：${v.message}`);
      }
    }
  }

  if (bucketResults.length > 0) {
    if (cloudResults.length > 0 || vpnResults.length > 0) lines.push('');
    lines.push('▌存储桶创建');
    for (const b of bucketResults) {
      const pname = PLATFORM_NAMES[b.platform] || b.platform;
      if (b.success) {
        lines.push(`  ✓ ${pname}  Bucket：${b.bucket}  地域：${b.region || '-'}`);
      } else {
        lines.push(`  ✗ ${pname}  Bucket：${b.bucket}  失败：${b.message}`);
      }
    }
  }

  if (storageResults.length > 0) {
    if (cloudResults.length > 0 || vpnResults.length > 0 || bucketResults.length > 0) lines.push('');
    lines.push('▌存储桶授权');
    for (const s of storageResults) {
      const pname = PLATFORM_NAMES[s.platform] || s.platform;
      if (s.success) {
        const attachHint = s.attached ? `  已附加到用户：${s.attachUsername}` : '  策略已创建（未附加用户）';
        lines.push(`  ✓ ${pname}  Bucket：${s.bucket}  策略：${s.policyName}${attachHint}`);
      } else {
        lines.push(`  ✗ ${pname}  Bucket：${s.bucket}  失败：${s.message}`);
      }
    }
  }

  if (rdsResults.length > 0) {
    lines.push('');
    lines.push('▌RDS 数据库账号');
    for (const r of rdsResults) {
      const pname = PLATFORM_NAMES[r.platform] || r.platform;
      const dbsHint = (r.databases || []).join(', ') || '-';
      if (r.success) {
        const manual = r.needsManual ? '（需手动执行）' : '';
        lines.push(`  ✓ ${pname}  实例：${r.instanceName || r.instanceId}  账号：${r.accountName}  数据库：${dbsHint}${manual}`);
      } else {
        lines.push(`  ✗ ${pname}  实例：${r.instanceName || r.instanceId}  失败：${r.message}`);
      }
    }
  }

  lines.push('\n完整凭据（AK/SK）已通过安全渠道发送给申请人。');
  return lines.join('\n');
}

module.exports = {
  buildFeishuDirectMessage,
  buildApprovalComment,
};
