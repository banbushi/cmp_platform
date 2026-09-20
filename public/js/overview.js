// ─────────────────────────────────────────
// 概览仪表盘
// ─────────────────────────────────────────

function set(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function fmtMoney(val, currency) {
  if (val == null || isNaN(val)) return '-';
  const n = Number(val);
  if (currency === 'USD') return '$' + n.toFixed(2);
  return '¥' + n.toFixed(2);
}

async function loadOverview() {
  // 并行拉取所有数据
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  document.getElementById('billing-month-label').textContent =
    `（${year} 年 ${month} 月）`;

  // 无账单权限的角色不请求账单接口（会 403），账单卡片也已隐藏
  const wantBilling = hasGroup('billing');
  const skipped = { ok: false, data: {} };

  const [ticketTotalR, ticketPendingR, ticketApprovedR, ticketRejectedR, usersR, instancesR, billAwsR, billAliR, billBaiR, syncStatusR, clustersR, rdsR] = await Promise.all([
    get('/feishu/tickets?pageSize=1'),
    get('/feishu/tickets?status=pending,approved&pageSize=1'),
    get('/feishu/tickets?status=completed&pageSize=1'),
    get('/feishu/tickets?status=rejected&pageSize=1'),
    get('/accounts/list'),
    get('/instances'),
    wantBilling ? get(`/billing/aws?year=${year}&month=${month}`)    : skipped,
    wantBilling ? get(`/billing/aliyun?year=${year}&month=${month}`) : skipped,
    wantBilling ? get(`/billing/baidu?year=${year}&month=${month}`)  : skipped,
    get('/sync/status'),
    get('/clusters'),
    get('/rds/instances'),
  ]);

  // ── 工单统计 ──────────────────────────────
  if (ticketTotalR.ok) {
    set('st-ticket-total',    ticketTotalR.data.total ?? '-');
    set('st-ticket-pending',  ticketPendingR.data?.total ?? '-');
    set('st-ticket-approved', ticketApprovedR.data?.total ?? '-');
    set('st-ticket-rejected', ticketRejectedR.data?.total ?? '-');
  } else {
    ['st-ticket-total','st-ticket-pending','st-ticket-approved','st-ticket-rejected']
      .forEach(id => set(id, '-'));
  }

  // ── 云账号统计 ────────────────────────────
  if (usersR.ok) {
    const users = usersR.data.users || [];
    allUsers = users;
    set('st-user-total', users.length);
  } else {
    set('st-user-total', '-');
  }

  if (syncStatusR.ok) {
    const s = syncStatusR.data.status || {};
    set('st-aws',    s.aws?.total    ?? '-');
    set('st-aliyun', s.aliyun?.total ?? '-');
    set('st-baidu',  s.baidu?.total  ?? '-');
  } else {
    ['st-aws','st-aliyun','st-baidu'].forEach(id => set(id, '-'));
  }

  // ── 云主机统计 ────────────────────────────
  if (instancesR.ok) {
    const instances = instancesR.data.instances || [];
    const awsI    = instances.filter(i => i.platform === 'aws').length;
    const aliyunI = instances.filter(i => i.platform === 'aliyun').length;
    const baiduI  = instances.filter(i => i.platform === 'baidu').length;
    set('st-instance-total',  instances.length);
    set('st-instance-aws',    awsI);
    set('st-instance-aliyun', aliyunI);
    set('st-instance-baidu',  baiduI);
  } else {
    ['st-instance-total','st-instance-aws','st-instance-aliyun','st-instance-baidu']
      .forEach(id => set(id, '-'));
  }

  // ── 容器集群统计 ──────────────────────────
  if (clustersR.ok) {
    const clusters = clustersR.data.clusters || [];
    const totalNodes = clusters.reduce((s, c) => s + (c.node_count || 0), 0);
    set('st-cluster-total', clusters.length);
    set('st-cluster-nodes', totalNodes);

    const listEl = document.getElementById('st-cluster-list');
    if (listEl) {
      if (!clusters.length) {
        listEl.innerHTML = '<div style="color:var(--g400);font-size:13px">暂无集群数据，请先同步</div>';
      } else {
        const PLATFORM_COLOR = { aws: '#FF9900', aliyun: '#FF6A00', baidu: '#2932E1' };
        const PLATFORM_LABEL = { aws: 'EKS', aliyun: 'ACK', baidu: 'CCE' };
        listEl.innerHTML = `
          <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px">
            ${clusters.map(c => {
              const color = PLATFORM_COLOR[c.platform] || 'var(--g500)';
              const tag   = PLATFORM_LABEL[c.platform] || c.platform;
              return `
                <div style="display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--g50)">
                  <div style="width:32px;height:32px;border-radius:6px;background:${color}20;color:${color};font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0">${tag}</div>
                  <div style="min-width:0;flex:1">
                    <div style="font-size:13px;font-weight:600;color:var(--g900);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.cluster_name || c.cluster_id)}</div>
                    <div style="font-size:11px;color:var(--g500);margin-top:2px">${esc(c.region || '')} · <strong style="color:var(--g700)">${c.node_count || 0}</strong> 个节点</div>
                  </div>
                </div>`;
            }).join('')}
          </div>`;
      }
    }
  } else {
    set('st-cluster-total', '-');
    set('st-cluster-nodes', '-');
    const listEl = document.getElementById('st-cluster-list');
    if (listEl) listEl.innerHTML = '<div style="color:var(--g400);font-size:13px">加载失败</div>';
  }

  // ── 数据库资源统计 ──────────────────────────
  if (rdsR.ok) {
    const instances = rdsR.data.instances || [];
    set('st-rds-total', instances.length);
    set('st-rds-aws', instances.filter(i => i.platform === 'aws').length);
    set('st-rds-aliyun', instances.filter(i => i.platform === 'aliyun').length);
    set('st-rds-baidu', instances.filter(i => i.platform === 'baidu').length);
    set('st-rds-running', instances.filter(i => i.status && (i.status.toLowerCase().includes('running') || i.status.toLowerCase().includes('available'))).length);
  } else {
    ['st-rds-total','st-rds-aws','st-rds-aliyun','st-rds-baidu','st-rds-running']
      .forEach(id => set(id, '-'));
  }

  // ── 账单统计 ──────────────────────────────
  let totalCNY = 0;
  let hasBilling = false;

  if (billAwsR.ok && billAwsR.data.billing?.total != null) {
    const amt = Number(billAwsR.data.billing.total);
    set('st-billing-aws', fmtMoney(amt, 'USD'));
    hasBilling = true;
  } else {
    set('st-billing-aws', '-');
  }

  if (billAliR.ok && billAliR.data.billing?.total != null) {
    const amt = Number(billAliR.data.billing.total);
    set('st-billing-aliyun', fmtMoney(amt, 'CNY'));
    totalCNY += amt;
    hasBilling = true;
  } else {
    set('st-billing-aliyun', '-');
  }

  if (billBaiR.ok && billBaiR.data.billing?.total != null) {
    const amt = Number(billBaiR.data.billing.total);
    set('st-billing-baidu', fmtMoney(amt, 'CNY'));
    totalCNY += amt;
    hasBilling = true;
  } else {
    set('st-billing-baidu', '-');
  }

  // 总费用：仅汇总 CNY 部分（AWS 单独展示 USD）
  set('st-billing-total', hasBilling ? '¥' + totalCNY.toFixed(2) : '-');

  // ── SSL 证书到期告警 ──────────────────────
  renderCertAlert();

  // ── 最近工单列表 ──────────────────────────
  const ticketEl = document.getElementById('overview-tickets');
  if (!ticketEl) return;

  // 待处理工单单独抓取（保证即使提交得早也能置顶，不受"最近 N 条"窗口限制），
  // 其余按时间倒序填充，列表覆盖所有状态的工单
  const [pendingR, recentR] = await Promise.all([
    get('/feishu/tickets?status=pending&pageSize=8'),
    get('/feishu/tickets?pageSize=20'),
  ]);
  if (!recentR.ok || !(recentR.data.tickets || []).length) {
    ticketEl.innerHTML = '<div class="empty-tip">暂无工单记录</div>';
    return;
  }

  const STATUS_LABEL = { pending: '待处理', approved: '已通过', rejected: '已拒绝', completed: '已完成', failed: '创建失败', processing: '创建中', cancelled: '已撤销' };
  const STATUS_COLOR = { pending: '#f59e0b', approved: '#10b981', rejected: '#ef4444', completed: '#10b981', failed: '#ef4444', processing: '#3b82f6', cancelled: '#9ca3af' };

  // 待处理置顶 + 其余按时间倒序，去重后取前 8
  const pending = (pendingR.ok ? pendingR.data.tickets || [] : []);
  const seen = new Set(pending.map(t => t.id));
  const rest = (recentR.data.tickets || []).filter(t => !seen.has(t.id));
  const recent = [...pending, ...rest].slice(0, 8);
  ticketEl.innerHTML = recent.map(t => {
    const draft = (() => { try { return JSON.parse(t.account_draft || '{}'); } catch { return {}; } })();
    const statusColor = STATUS_COLOR[t.status] || 'var(--g400)';
    const statusLabel = STATUS_LABEL[t.status] || t.status;
    const platforms = (draft.cloud_platforms || []).join('、') || '-';
    return `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border)">
        <div style="width:8px;height:8px;border-radius:50%;background:${statusColor};flex-shrink:0"></div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:var(--g900);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
            ${esc(t.submitter_name || '-')}
            <span style="font-size:12px;color:var(--g500);font-weight:400;margin-left:6px">${esc(draft.notes || '')}</span>
          </div>
          <div style="font-size:12px;color:var(--g500);margin-top:2px">${t.created_at?.slice(0,16) || ''}</div>
        </div>
        <div style="font-size:12px;font-weight:600;color:${statusColor};flex-shrink:0">${statusLabel}</div>
      </div>`;
  }).join('');
}

// ── SSL 证书到期告警：首页卡片 + 侧边栏红点 ──────────────
const PNAME_CERT = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };

async function renderCertAlert() {
  const box = document.getElementById('overview-cert-alert');
  const r = await get('/sync/certs/expiring?days=30');
  const data = r.ok ? r.data : null;
  // 首页只提醒「即将过期」（未来 30 天内），已过期的不显示
  const certs = (data?.certs || []).filter(c => c.days_left >= 0);
  const total = certs.length;

  updateCertNavBadge(total);

  if (!box) return;
  if (!total) { box.classList.add('hidden'); box.innerHTML = ''; return; }

  const rows = certs.slice(0, 6).map(c => {
    const days = c.days_left;
    const when = days === 0 ? '今天到期' : `${days} 天后`;
    const color = days < 7 ? 'var(--danger)' : '#F59E0B';
    const date = c.expires_at ? new Date(c.expires_at).toLocaleDateString('zh-CN') : '-';
    return `<div style="display:flex;align-items:center;gap:12px;padding:9px 0;border-bottom:1px solid var(--border)">
      <div style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0"></div>
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--g900);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
          ${esc(c.domain || c.cert_name || '(未命名)')}
          <span style="font-size:11px;color:var(--g500);font-weight:400;margin-left:6px">${PNAME_CERT[c.platform] || c.platform}${c.region ? ' · ' + esc(c.region) : ''}</span>
        </div>
        <div style="font-size:12px;color:var(--g500);margin-top:2px">到期 ${date}</div>
      </div>
      <div style="font-size:12px;font-weight:600;color:${color};flex-shrink:0">${when}</div>
    </div>`;
  }).join('');

  box.classList.remove('hidden');
  box.className = 'card';
  box.innerHTML = `
    <div class="card-title" style="display:flex;align-items:center;gap:8px">
      <span style="color:#F59E0B">⚠</span> SSL 证书即将过期
      <span style="font-size:12px;font-weight:400;color:var(--g500)">${total} 个证书将在 30 天内到期</span>
      <a onclick="navTo('ssl-certs')" style="margin-left:auto;font-size:12px;font-weight:400;color:var(--primary);cursor:pointer">查看全部 →</a>
    </div>
    ${rows}
    ${total > 6 ? `<div style="text-align:center;padding-top:10px;font-size:12px;color:var(--g500)">还有 ${total - 6} 个，<a onclick="navTo('ssl-certs')" style="color:var(--primary);cursor:pointer">查看全部</a></div>` : ''}`;
}

// 侧边栏「SSL 证书」菜单红点角标
function updateCertNavBadge(count) {
  const link = document.querySelector('.nav-sub-link[data-section="ssl-certs"]');
  if (!link) return;
  let badge = link.querySelector('.nav-badge');
  if (!count) { if (badge) badge.remove(); return; }
  if (!badge) {
    badge = document.createElement('span');
    badge.className = 'nav-badge';
    link.appendChild(badge);
  }
  badge.textContent = count > 99 ? '99+' : count;
}
