// ─────────────────────────────────────────
// 费用账单
// ─────────────────────────────────────────

const BILLING_PLATFORM_NAMES = { aws: 'Amazon Web Services', aliyun: '阿里云', baidu: '百度智能云' };
const BILLING_UNIT_SYMBOL = { USD: '$', CNY: '¥' };

// 账单列表状态
let _billingAllItems = [];   // 全量数据
let _billingFiltered = [];   // 搜索后的数据
let _billingMeta     = {};   // billing 元信息（total/unit/allZero 等）
let _billingPage     = 1;
let _billingPageSize = 20;
let _billingKeyword  = '';

function _initBillingSelectors() {
  const yearSel  = document.getElementById('billing-year');
  const monthSel = document.getElementById('billing-month');
  if (!yearSel || yearSel.options.length > 0) return;

  const now = new Date();
  const thisYear = now.getFullYear();
  for (let y = thisYear; y >= thisYear - 2; y--) {
    yearSel.insertAdjacentHTML('beforeend', `<option value="${y}" ${y === thisYear ? 'selected' : ''}>${y} 年</option>`);
  }
  for (let m = 1; m <= 12; m++) {
    const mv = String(m).padStart(2, '0');
    const sel = m === (now.getMonth() + 1) ? 'selected' : '';
    monthSel.insertAdjacentHTML('beforeend', `<option value="${mv}" ${sel}>${m} 月</option>`);
  }
}

async function loadBilling(forceRefresh = false) {
  _initBillingSelectors();
  const platform = _billingPlatform || 'aws';
  const isBaidu  = (platform === 'baidu');

  // 百度不支持查当月账单，自动切换到上月
  if (isBaidu) {
    const now = new Date();
    const curYear  = now.getFullYear().toString();
    const curMonth = String(now.getMonth() + 1).padStart(2, '0');
    const selYear  = document.getElementById('billing-year')?.value;
    const selMonth = document.getElementById('billing-month')?.value;
    if (selYear === curYear && selMonth === curMonth) {
      // 切换到上月
      const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const prevYear  = prev.getFullYear().toString();
      const prevMonth = String(prev.getMonth() + 1).padStart(2, '0');
      document.getElementById('billing-year').value  = prevYear;
      document.getElementById('billing-month').value = prevMonth;
      toast('百度云不支持查询当月账单，已自动切换到上月', 'info');
    }
  }

  const year  = document.getElementById('billing-year')?.value  || new Date().getFullYear().toString();
  const month = document.getElementById('billing-month')?.value || String(new Date().getMonth() + 1).padStart(2, '0');

  const pName = BILLING_PLATFORM_NAMES[platform] || platform;
  document.getElementById('billing-title').textContent = pName + ' 费用账单';
  document.getElementById('billing-sub').textContent   = `${year} 年 ${parseInt(month)} 月账单明细`;

  const content = document.getElementById('billing-content');
  const loadingMsg = isBaidu
    ? '<div class="sync-loading"><div class="spin"></div> 正在查询百度云账单（首次拉取明细较多需数分钟，已缓存则秒返回）...</div>'
    : '<div class="sync-loading"><div class="spin"></div> 正在查询账单...</div>';
  content.innerHTML = loadingMsg;

  const qs = `/billing/${platform}?year=${year}&month=${month}${forceRefresh ? '&refresh=1' : ''}`;
  const r = await get(qs);
  if (!r.ok) {
    content.innerHTML = `<div class="card"><div class="empty-tip" style="color:var(--danger)">查询失败: ${esc(r.data.error || '')}</div></div>`;
    return;
  }

  const billing    = r.data.billing || {};
  const fromCache  = !!r.data.fromCache;
  const cachedAt   = r.data.cachedAt || null;

  if (!billing.items?.length) {
    content.innerHTML = '<div class="card"><div class="empty-tip">本月暂无账单数据（账单可能有延迟，请稍后重试）</div></div>';
    return;
  }

  // 存入全局，准备搜索+分页
  _billingAllItems = billing.items;
  _billingMeta     = { ...billing, isBaidu };
  _billingKeyword  = '';
  _billingPage     = 1;

  // 渲染搜索栏（只渲染一次）
  const unit = billing.unit || 'USD';
  const sym  = BILLING_UNIT_SYMBOL[unit] || '';

  const deductNote = (isBaidu && billing.allZero)
    ? `<div style="margin-bottom:14px;padding:10px 14px;background:#FFF3CD;border:1px solid #FFEAA0;border-radius:8px;font-size:13px;color:#856404">
        ⚠ 本月各服务费用均为 ¥0.00，可能由<strong>预留实例券</strong>完全抵扣，非实际现金消费。
      </div>` : '';

  const cacheLabel = fromCache && cachedAt
    ? `<span style="font-size:12px;color:var(--g400)">缓存于 ${_fmtCacheAge(cachedAt)} &nbsp;·&nbsp; <a href="javascript:void(0)" onclick="loadBilling(true)" style="color:var(--primary)">↻ 刷新</a></span>`
    : '';

  const totalNote = isBaidu
    ? `<div style="margin-bottom:14px;padding:8px 14px;background:var(--g50);border:1px solid var(--g200);border-radius:8px;font-size:12px;color:var(--g500)">
        ℹ 后付费：${(billing.totalCount || 0).toLocaleString()} 条明细，去重 ${(billing.uniqueCount || 0).toLocaleString()} 条；预付费订单已合并（预付 ¥${billing.prepayTotal || '0.00'}）
      </div>` : '';

  content.innerHTML = `
    ${deductNote}${totalNote}
    <div style="display:flex;gap:14px;margin-bottom:20px;flex-wrap:wrap">
      <div class="stat-card" style="flex:0 0 auto;min-width:220px">
        <div class="stat-icon" style="background:#4F46E5">💰</div>
        <div>
          <div class="stat-num" style="color:var(--primary)">${sym}${billing.total || '0.00'}</div>
          <div class="stat-label">本月总费用 (${unit})</div>
        </div>
      </div>
    </div>
    <div class="sync-toolbar">
      <div class="sync-search">
        <input type="text" id="billing-search" placeholder="搜索服务/产品名称..." oninput="_onBillingSearch(this.value)" style="width:260px">
      </div>
      ${cacheLabel}
    </div>
    <div class="card" style="padding:0;overflow:hidden">
      <div id="billing-table-wrap"></div>
    </div>`;

  _filterBilling();
}

function _onBillingSearch(val) {
  _billingKeyword = val.trim().toLowerCase();
  _billingPage = 1;
  _filterBilling();
}

function _fmtCacheAge(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1)  return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs} 小时前`;
  return `${Math.floor(hrs / 24)} 天前`;
}

function _filterBilling() {
  _billingFiltered = _billingKeyword
    ? _billingAllItems.filter(i => i.service.toLowerCase().includes(_billingKeyword))
    : _billingAllItems.slice();
  _renderBillingPage();
}

function _renderBillingPage() {
  const wrap    = document.getElementById('billing-table-wrap');
  if (!wrap) return;
  const total   = _billingFiltered.length;
  const start   = (_billingPage - 1) * _billingPageSize;
  const pageItems = _billingFiltered.slice(start, start + _billingPageSize);

  const { unit = 'USD', isBaidu, total: grandTotal = '0' } = _billingMeta;
  const sym      = BILLING_UNIT_SYMBOL[unit] || '';
  const showUsage = isBaidu;
  const usageTh   = showUsage ? '<th>用量</th>' : '';

  if (!pageItems.length) {
    wrap.innerHTML = `<div class="empty-tip">没有匹配的服务</div>`;
    return;
  }

  const rows = pageItems.map(item => {
    const amt = parseFloat(item.amount);
    const pct = parseFloat(grandTotal) > 0 ? (amt / parseFloat(grandTotal) * 100).toFixed(1) : '0.0';
    const usageTd = showUsage
      ? `<td style="color:var(--g500);font-size:12px">${item.usage != null ? item.usage.toLocaleString() + ' ' + esc(item.usageUnit || '') : '-'}</td>`
      : '';
    return `<tr>
      <td>${esc(item.service || '-')}</td>
      <td style="text-align:right;font-weight:600">${sym}${item.amount}</td>
      ${usageTd}
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;height:6px;background:var(--g100);border-radius:3px;overflow:hidden">
            <div style="width:${pct}%;height:100%;background:var(--primary);border-radius:3px"></div>
          </div>
          <span style="font-size:12px;color:var(--g500);width:36px;text-align:right">${pct}%</span>
        </div>
      </td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="sync-table-container"><table class="sync-table" style="min-width:600px">
      <thead><tr><th>服务/产品</th><th style="text-align:right">费用 (${unit})</th>${usageTh}<th style="width:180px">占比</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${_buildPagination(total, _billingPage, _billingPageSize, '_goBillingPage', '_setBillingPageSize')}`;
}

function _goBillingPage(n) {
  const maxPage = Math.ceil(_billingFiltered.length / _billingPageSize) || 1;
  _billingPage = Math.max(1, Math.min(n, maxPage));
  _renderBillingPage();
}

function _setBillingPageSize(size) {
  _billingPageSize = parseInt(size);
  _billingPage = 1;
  _renderBillingPage();
}

// ─────────────────────────────────────────
