// ─────────────────────────────────────────
// 定时同步服务：每 30 分钟自动同步全部云资源
// ─────────────────────────────────────────

const SYNC_INTERVAL = 30 * 60 * 1000; // 30 分钟

// 内部调用同步接口（模拟 admin 身份）
async function _syncCall(path, method = 'POST') {
  const jwt = require('jsonwebtoken');
  const { JWT_SECRET } = require('../middleware/auth');
  const token = jwt.sign({ id: 'system', name: 'AutoSync', role: 'admin' }, JWT_SECRET, { expiresIn: '10m' });
  const port = process.env.PORT || 9001;
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/api${path}`, {
      method,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: method === 'POST' ? '{}' : undefined,
      signal: AbortSignal.timeout(120000), // 单个同步最多 2 分钟
    });
    const data = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, path, data };
  } catch (e) {
    return { ok: false, path, error: e.message };
  }
}

// 同步任务列表（按顺序执行，避免并发压力）
const SYNC_TASKS = [
  { name: '云账号用户', path: '/sync/all' },
  { name: '集群', path: '/clusters/sync/all' },
  { name: '安全组 (AWS)', path: '/sync/security-groups/aws' },
  { name: '安全组 (阿里云)', path: '/sync/security-groups/aliyun' },
  { name: '安全组 (百度云)', path: '/sync/security-groups/baidu' },
  { name: 'VPC (AWS)', path: '/sync/vpcs/aws' },
  { name: 'VPC (阿里云)', path: '/sync/vpcs/aliyun' },
  { name: 'VPC (百度云)', path: '/sync/vpcs/baidu' },
  { name: '存储桶', path: '/storage/sync-buckets/all' },
  { name: 'DNS 记录 (AWS)', path: '/sync/dns-records/aws' },
  { name: 'DNS 记录 (阿里云)', path: '/sync/dns-records/aliyun' },
  { name: 'DNS 记录 (百度云)', path: '/sync/dns-records/baidu' },
  { name: 'SSL 证书', path: '/sync/certs/all' },
];

async function runAutoSync() {
  const start = Date.now();
  console.log(`\n[auto-sync] ▶ 开始定时全量同步 (${new Date().toLocaleString()})`);
  const results = [];
  for (const task of SYNC_TASKS) {
    const r = await _syncCall(task.path);
    const flag = r.ok ? '✓' : '✗';
    console.log(`[auto-sync]   ${flag} ${task.name}`);
    results.push({ ...task, ok: r.ok });
  }
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const failed = results.filter(r => !r.ok).length;
  console.log(`[auto-sync] ◀ 完成 (${elapsed}s, ${failed ? failed + ' 项失败' : '全部成功'})\n`);
}

// ─────────────────────────────────────────
// SSL 证书到期检查：每日一次，向飞书审批人（管理员）推送 30 天内到期/已过期的证书
// ─────────────────────────────────────────
const CERT_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 小时
const CERT_EXPIRE_DAYS = 30;

async function runCertExpiryCheck() {
  const db = require('./database');
  const feishu = require('./feishu');
  try {
    // 推送窗口：即将到期（未来 30 天内）+ 最近过期（过去 30 天内）；
    // 过期超过 30 天的陈年证书不推送，避免刷屏（页面上仍全部展示）
    const rows = await db.all(
      `SELECT platform, region, domain, cert_name, expires_at
       FROM cloud_certs
       WHERE expires_at IS NOT NULL
         AND expires_at <= DATE_ADD(NOW(), INTERVAL ? DAY)
         AND expires_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
       ORDER BY expires_at ASC`,
      [CERT_EXPIRE_DAYS, CERT_EXPIRE_DAYS]
    );
    if (!rows.length) {
      console.log('[cert-check] 无即将过期证书');
      return;
    }

    const cfg = await db.get('SELECT * FROM feishu_config WHERE id = 1');
    if (!cfg?.enabled || !cfg.approver_open_id) {
      console.log(`[cert-check] ${rows.length} 个证书即将过期，但飞书未配置/未启用，跳过推送`);
      return;
    }

    const now = Date.now();
    const PNAME = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
    const lines = rows.map(r => {
      const days = Math.ceil((new Date(r.expires_at).getTime() - now) / 86400000);
      const when = days < 0 ? `已过期 ${-days} 天` : `${days} 天后到期`;
      const date = new Date(r.expires_at).toLocaleDateString('zh-CN');
      return `• [${PNAME[r.platform] || r.platform}] ${r.domain || r.cert_name || '(未命名)'} — ${date}（${when}）`;
    });
    const expired = rows.filter(r => new Date(r.expires_at).getTime() < now).length;
    const text = `【SSL 证书到期提醒】\n\n共 ${rows.length} 个证书将在 ${CERT_EXPIRE_DAYS} 天内到期`
      + (expired ? `（其中 ${expired} 个已过期）` : '') + '：\n\n'
      + lines.join('\n')
      + '\n\n请及时续期，避免服务中断。';

    await feishu.sendMessage(cfg, cfg.approver_open_id, text);
    console.log(`[cert-check] 已推送 ${rows.length} 个即将过期证书给管理员`);
  } catch (e) {
    console.warn('[cert-check] 检查/推送失败:', e.message);
  }
}

// 启动定时器（延迟 60s 后首次执行，之后每 30 分钟一次）
function startAutoSync() {
  console.log(`  ✓ 定时同步已启用（每 ${SYNC_INTERVAL / 60000} 分钟）`);
  setTimeout(() => {
    runAutoSync();
    setInterval(runAutoSync, SYNC_INTERVAL);
  }, 60000);
  // 证书到期检查：延迟 3 分钟首次执行（等首轮证书同步完成），之后每日一次
  console.log(`  ✓ SSL 证书到期检查已启用（每日，提前 ${CERT_EXPIRE_DAYS} 天提醒）`);
  setTimeout(() => {
    runCertExpiryCheck();
    setInterval(runCertExpiryCheck, CERT_CHECK_INTERVAL);
  }, 3 * 60 * 1000);
}

module.exports = { startAutoSync, runAutoSync, runCertExpiryCheck };
