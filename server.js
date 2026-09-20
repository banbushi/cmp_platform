require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const bodyParser = require('body-parser');

const accountsRouter = require('./routes/accounts');
const cloudRouter = require('./routes/cloud');
const syncRouter = require('./routes/sync');
const instancesRouter = require('./routes/instances');
const rolesRouter = require('./routes/roles');
const storageRouter = require('./routes/storage');
const billingRouter = require('./routes/billing');
const vpnRouter    = require('./routes/vpn');
const rdsRouter    = require('./routes/rds');
const feishuRouter = require('./routes/feishu');
const clustersRouter = require('./routes/clusters');
const oauthRouter = require('./routes/oauth');
const ssoRouter = require('./routes/sso');
const jumpserverRouter = require('./routes/jumpserver');
const feedbackRouter = require('./routes/feedback');
const paiRouter = require('./routes/pai');
const applyConfigRouter = require('./routes/apply-config');
const bytebaseRouter = require('./routes/bytebase');
const auditRouter = require('./routes/audit');
const { auditMiddleware } = require('./middleware/audit');

const app = express();
const PORT = parseInt(process.env.PORT || '9001', 10);

// ── 请求日志 ──
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const status = res.statusCode;
    const flag = status >= 500 ? '✗' : status >= 400 ? '!' : '→';
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
    console.log(`[${ts}] ${flag} ${req.method} ${req.originalUrl} ${status} (${ms}ms)`);
  });
  next();
});

app.use(cors());
app.use(bodyParser.json());
app.use(require('express-fileupload')({ limits: { fileSize: 10 * 1024 * 1024 }, abortOnLimit: true }));
app.use(express.static(path.join(__dirname, 'public'), { etag: false, maxAge: 0 }));

// ── 操作审计 ──
// 位置有讲究：必须在 bodyParser 之后（要读已解析的 req.body），
// 且在所有路由之前（要先挂上 res.on('finish') 钩子）。
// 钩子在 handler 跑完才触发，那时各路由的 authenticate 已把 req.user 挂好，
// 所以无需改动 88 个 handler。static 只响应 GET/HEAD，不受影响。
app.use(auditMiddleware);

app.use('/api/accounts', accountsRouter);
app.use('/api/cloud', cloudRouter);
app.use('/api/sync', syncRouter);
app.use('/api/instances', instancesRouter);
app.use('/api/roles', rolesRouter);
app.use('/api/storage', storageRouter);
app.use('/api/billing', billingRouter);
app.use('/api/vpn',     vpnRouter);
app.use('/api/rds',     rdsRouter);
app.use('/api/feishu',  feishuRouter);
app.use('/api/clusters', clustersRouter);
app.use('/oauth',       oauthRouter);
app.use('/api/sso',     ssoRouter);
app.use('/api/jumpserver', jumpserverRouter);
app.use('/api/feedback', feedbackRouter);
app.use('/api/pai',      paiRouter);
app.use('/api/apply-config', applyConfigRouter);
app.use('/api/bytebase', bytebaseRouter);
app.use('/api/audit',    auditRouter);

app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── 全局错误处理 ──
app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.originalUrl}`);
  console.error(err);
  res.status(500).json({ error: err.message || '服务器内部错误' });
});

app.listen(PORT, () => {
  console.log(`\n✓ 云管平台已启动`);
  console.log(`  访问地址: http://localhost:${PORT}\n`);
  // 启动定时同步服务
  const { startAutoSync } = require('./utils/auto-sync');
  startAutoSync();
});
