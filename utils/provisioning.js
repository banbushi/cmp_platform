const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db = require('./database');
const feishu = require('./feishu');
const { provisionCloudUser, getConsoleLoginUrl } = require('../routes/accounts');
const { createVpnClient } = require('../routes/vpn');
const { grantBucketAccess, createBucket, friendlyBucketError } = require('../routes/storage');
const { createRdsAccount } = require('../routes/rds');
const { buildFeishuDirectMessage, buildApprovalComment } = require('./notification-builder');
const { PLATFORM_NAMES } = require('./constants');

function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#-_';
  const all = upper + lower + digits + special;
  let pw = upper[crypto.randomInt(upper.length)] + upper[crypto.randomInt(upper.length)]
         + lower[crypto.randomInt(lower.length)] + lower[crypto.randomInt(lower.length)]
         + digits[crypto.randomInt(digits.length)] + digits[crypto.randomInt(digits.length)]
         + special[crypto.randomInt(special.length)] + special[crypto.randomInt(special.length)];
  for (let i = 8; i < 16; i++) pw += all[crypto.randomInt(all.length)];
  const arr = pw.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

async function resetCloudUserPassword(platform, cred, account, newPassword) {
  try {
    if (platform === 'aws') {
      const AWS = require('aws-sdk');
      const iam = new AWS.IAM({
        accessKeyId: cred.access_key, secretAccessKey: cred.secret_key, region: cred.region || 'us-east-1',
      });
      await iam.updateLoginProfile({ UserName: account, Password: newPassword, PasswordResetRequired: false }).promise();
      return { success: true, message: 'AWS IAM 控制台密码已重置' };
    } else if (platform === 'aliyun') {
      const Core = require('@alicloud/pop-core');
      const client = new Core({ accessKeyId: cred.access_key, accessKeySecret: cred.secret_key, endpoint: 'https://ram.aliyuncs.com', apiVersion: '2015-05-01' });
      await client.request('UpdateLoginProfile', { UserName: account, Password: newPassword }, { method: 'POST' });
      return { success: true, message: '阿里云 RAM 控制台密码已重置' };
    } else if (platform === 'baidu') {
      const bceCore = require('@baiducloud/sdk');
      const client = new bceCore.BceBaseClient({
        credentials: { ak: cred.access_key, sk: cred.secret_key },
        endpoint: 'https://iam.bj.baidubce.com'
      });
      await client.sendRequest('PUT', `/v1/user/${account}/loginProfile`, {
        body: JSON.stringify({ password: newPassword, enableMfa: false }),
        headers: { 'Content-Type': 'application/json' }
      });
      return { success: true, message: '百度云 IAM 控制台密码已重置' };
    }
    return { success: false, message: `不支持的云平台：${platform}` };
  } catch (e) {
    console.error(`[resetCloudUserPassword] ${platform} 重置失败:`, e.message);
    return { success: false, message: e.message };
  }
}

async function resetVpnPassword(platform, cred, clientId, newPassword) {
  try {
    const { updateVpnClientPassword } = require('../routes/vpn');
    if (typeof updateVpnClientPassword === 'function') {
      return await updateVpnClientPassword(platform, cred, clientId, newPassword);
    }
    return { success: false, message: `${PLATFORM_NAMES[platform] || platform} VPN 密码重置需管理员手动操作` };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

async function resetSystemToolPassword(tool, username, newPassword) {
  try {
    const cred = await db.get("SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1", [tool]);
    if (!cred) return { success: false, message: `${PLATFORM_NAMES[tool] || tool} 未配置主账号凭据` };
    if (tool === 'jumpserver') {
      const { resetJumpServerPassword } = require('./jumpserver');
      return await resetJumpServerPassword(cred, username, newPassword);
    }
    return { success: false, message: `${PLATFORM_NAMES[tool] || tool} 暂不支持 API 重置密码，请在控制台手动操作` };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

module.exports = { generatePassword, resetCloudUserPassword, resetVpnPassword, resetSystemToolPassword, PLATFORM_NAMES };
