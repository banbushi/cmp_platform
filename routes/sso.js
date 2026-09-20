'use strict';

const express = require('express');
const db = require('../utils/database');
const { authenticate } = require('../middleware/auth');
const { getConsoleLoginUrl } = require('../utils/platform-registry');

const router = express.Router();

/**
 * GET /api/sso/:platform/login-url
 * 获取平台登录入口 URL
 * - 工具平台（JumpServer/Grafana）：返回 SSO 登录触发地址
 * - 云平台（AWS/阿里云）：生成临时控制台 URL（联合登录）
 * - 不支持 SSO 的平台：返回普通登录页地址
 */
router.get('/:platform/login-url', authenticate, async (req, res) => {
  const { platform } = req.params;

  // 检查用户是否已开通该平台（托管账号 或 同步账号）
  const user = await db.get('SELECT cloud_username FROM users WHERE id = ?', [req.user.id]);
  const cloudUser = await db.get(
    "SELECT * FROM cloud_users WHERE user_id = ? AND platform = ? AND status = 'active'",
    [req.user.id, platform]
  );
  const syncedUser = !cloudUser && user?.cloud_username
    ? await db.get(
        "SELECT * FROM cloud_synced_users WHERE platform = ? AND (local_user_id = ? OR cloud_username = ?)",
        [platform, req.user.id, user.cloud_username]
      )
    : null;

  if (!cloudUser && !syncedUser) {
    return res.status(403).json({ error: '你尚未开通该平台账号' });
  }

  const cred = await db.get(
    'SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1',
    [platform]
  );

  // 使用托管账号或同步账号（优先托管）
  const accountInfo = cloudUser || syncedUser;

  // 检查是否有 OAuth Client 配置（SSO 方式）
  const oauthClient = await db.get(
    'SELECT * FROM oauth_clients WHERE platform = ?',
    [platform]
  );

  if (platform === 'aws') {
    // AWS 联合登录：通过 GetFederationToken + signin.aws.amazon.com/federation
    try {
      const url = await getAwsFederatedUrl(cred, accountInfo);
      return res.json({ url, method: 'federation' });
    } catch (e) {
      // 回退到普通控制台链接
      const fallbackUrl = cred ? await getConsoleLoginUrl('aws', cred) : '';
      return res.json({ url: fallbackUrl || 'https://console.aws.amazon.com/', method: 'redirect' });
    }
  }

  if (platform === 'aliyun') {
    // 阿里云联合登录：通过 AssumeRole + GetSigninToken
    try {
      const url = await getAliyunFederatedUrl(cred, accountInfo);
      return res.json({ url, method: 'federation' });
    } catch (e) {
      const fallbackUrl = cred ? await getConsoleLoginUrl('aliyun', cred) : '';
      return res.json({ url: fallbackUrl || 'https://ram.console.aliyun.com/', method: 'redirect' });
    }
  }

  // 工具平台：如果有 OAuth Client，返回 SSO 触发地址
  if (oauthClient && cred) {
    const baseUrl = await getConsoleLoginUrl(platform, cred);
    if (baseUrl) {
      // JumpServer OAuth2 登录入口
      if (platform === 'jumpserver') {
        return res.json({ url: `${baseUrl}/core/auth/oauth2/login/`, method: 'sso' });
      }
      // Grafana OAuth 登录入口
      if (platform.startsWith('grafana')) {
        return res.json({ url: `${baseUrl}/login/generic_oauth`, method: 'sso' });
      }
    }
  }

  // 回退：返回普通登录页地址
  const loginUrl = cred ? await getConsoleLoginUrl(platform, cred) : '';
  if (loginUrl) {
    return res.json({ url: loginUrl, method: 'redirect' });
  }

  res.status(404).json({ error: '未配置该平台登录地址' });
});

// ── AWS 联合登录 ─────────────────────────────────────────

async function getAwsFederatedUrl(cred, cloudUser) {
  if (!cred || !cloudUser.cloud_access_key || !cloudUser.cloud_secret_key) {
    throw new Error('缺少 AWS 凭证');
  }

  const { STSClient, GetFederationTokenCommand } = require('@aws-sdk/client-sts');
  const stsClient = new STSClient({
    region: cred.region || 'us-east-1',
    credentials: {
      accessKeyId: cloudUser.cloud_access_key,
      secretAccessKey: cloudUser.cloud_secret_key,
    },
  });

  const stsRes = await stsClient.send(new GetFederationTokenCommand({
    Name: cloudUser.cloud_username.slice(0, 32),
    DurationSeconds: 3600,
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: '*', Resource: '*' }],
    }),
  }));

  const { AccessKeyId, SecretAccessKey, SessionToken } = stsRes.Credentials;

  // 通过 AWS signin federation 端点生成控制台 URL
  const sessionJson = JSON.stringify({
    sessionId: AccessKeyId,
    sessionKey: SecretAccessKey,
    sessionToken: SessionToken,
  });

  const signinUrl = 'https://signin.aws.amazon.com/federation';

  // Step 1: 获取 SigninToken
  const tokenRes = await fetch(
    `${signinUrl}?Action=getSigninToken&SessionDuration=3600&Session=${encodeURIComponent(sessionJson)}`
  );
  const tokenData = await tokenRes.json();

  if (!tokenData.SigninToken) throw new Error('获取 AWS SigninToken 失败');

  // Step 2: 构造控制台 URL
  const destination = 'https://console.aws.amazon.com/';
  const loginUrl = `${signinUrl}?Action=login&Issuer=CloudCMP&Destination=${encodeURIComponent(destination)}&SigninToken=${tokenData.SigninToken}`;

  return loginUrl;
}

// ── 阿里云联合登录 ───────────────────────────────────────

async function getAliyunFederatedUrl(cred, cloudUser) {
  if (!cred || !cloudUser.cloud_access_key || !cloudUser.cloud_secret_key) {
    throw new Error('缺少阿里云凭证');
  }

  const Core = require('@alicloud/pop-core');

  // 使用子账号的 AK/SK 调用 GetSigninToken
  const stsClient = new Core({
    accessKeyId: cloudUser.cloud_access_key,
    accessKeySecret: cloudUser.cloud_secret_key,
    endpoint: 'https://signin.aliyuncs.com',
    apiVersion: '2015-01-01',
  });

  const signinRes = await stsClient.request('GetSigninToken', {
    AccessKeyId: cloudUser.cloud_access_key,
    AccessKeySecret: cloudUser.cloud_secret_key,
  }, { method: 'GET' });

  if (!signinRes.SigninToken) throw new Error('获取阿里云 SigninToken 失败');

  const destination = 'https://home.console.aliyun.com/';
  const loginUrl = `https://signin.aliyun.com/federation?Action=Login&LoginUrl=${encodeURIComponent('https://signin.aliyun.com/')}&Destination=${encodeURIComponent(destination)}&SigninToken=${signinRes.SigninToken}`;

  return loginUrl;
}

module.exports = router;
