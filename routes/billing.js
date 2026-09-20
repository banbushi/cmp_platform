const express = require('express');
const db = require('../utils/database');
const { authenticate, requireGroup } = require('../middleware/auth');
const bceRequest = require('../utils/bce');

const router = express.Router();

// GET /api/billing/:platform?year=2024&month=03&refresh=1
router.get('/:platform', authenticate, requireGroup('billing'), async (req, res) => {
  const { platform } = req.params;
  const now = new Date();
  const year  = req.query.year  || now.getFullYear().toString();
  const month = req.query.month || String(now.getMonth() + 1).padStart(2, '0');

  const cred = await db.get('SELECT * FROM platform_credentials WHERE platform = ? AND enabled = 1', [platform]);
  if (!cred) return res.status(400).json({ error: `${platform} 未配置主账号凭据` });

  // ── 缓存检查 ──
  // 历史月份数据永不变化，直接复用；当月缓存 2 小时
  const curYear  = now.getFullYear().toString();
  const curMonth = String(now.getMonth() + 1).padStart(2, '0');
  const isPast   = year < curYear || (year === curYear && month < curMonth);
  const CACHE_TTL = 2 * 3600 * 1000;

  if (!req.query.refresh) {
    const cached = await db.get(
      'SELECT data, cached_at FROM billing_cache WHERE platform=? AND year=? AND month=?',
      [platform, year, month]
    );
    if (cached) {
      const age = Date.now() - Number(cached.cached_at);
      if (isPast || age < CACHE_TTL) {
        const parsed = JSON.parse(cached.data);
        return res.json({ ...parsed, year, month, fromCache: true, cachedAt: Number(cached.cached_at) });
      }
    }
  }

  try {
    let data;
    if (platform === 'aws')         data = await fetchAwsBilling(cred, year, month);
    else if (platform === 'aliyun') data = await fetchAliyunBilling(cred, year, month);
    else if (platform === 'baidu')  data = await fetchBaiduBilling(cred, year, month);
    else return res.status(400).json({ error: '不支持的云平台' });

    // 写入缓存
    await db.run(
      'INSERT INTO billing_cache (platform, year, month, data, cached_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE data=VALUES(data), cached_at=VALUES(cached_at)',
      [platform, year, month, JSON.stringify({ billing: data }), Date.now()]
    );

    res.json({ billing: data, year, month, fromCache: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── AWS Cost Explorer ──
async function fetchAwsBilling(cred, year, month) {
  const { CostExplorerClient, GetCostAndUsageCommand } = require('@aws-sdk/client-cost-explorer');
  const client = new CostExplorerClient({
    region: 'us-east-1',  // Cost Explorer 只在 us-east-1
    credentials: { accessKeyId: cred.access_key, secretAccessKey: cred.secret_key }
  });

  const startDate = `${year}-${month}-01`;
  // Cost Explorer 的 End 是 exclusive，必须用下月 1 日才能含当月最后一天
  const nextMonth = new Date(parseInt(year), parseInt(month), 1);
  const endDate = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01`;

  console.log(`[billing/aws] TimePeriod: ${startDate} ~ ${endDate} (end exclusive)`);

  const res = await client.send(new GetCostAndUsageCommand({
    TimePeriod: { Start: startDate, End: endDate },
    Granularity: 'MONTHLY',
    Metrics: ['UnblendedCost'],
    GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }]
  }));

  const items = [];
  for (const result of res.ResultsByTime || []) {
    for (const group of result.Groups || []) {
      const cost = group.Metrics?.UnblendedCost?.Amount || '0';
      const unit = group.Metrics?.UnblendedCost?.Unit || 'USD';
      const amount = parseFloat(cost);
      if (amount > 0) items.push({ service: group.Keys[0], amount: amount.toFixed(4), unit });
    }
  }
  items.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
  const total = items.reduce((s, i) => s + parseFloat(i.amount), 0).toFixed(4);
  return { total, unit: 'USD', items };
}

// ── 阿里云 BSS 账单 ──
async function fetchAliyunBilling(cred, year, month) {
  const Core = require('@alicloud/pop-core');
  const client = new Core({
    accessKeyId: cred.access_key,
    accessKeySecret: cred.secret_key,
    endpoint: 'https://business.aliyuncs.com',
    apiVersion: '2017-12-14'
  });

  const res = await client.request('QueryAccountBill', {
    BillingCycle: `${year}-${month}`,
    Granularity: 'MONTHLY',
    IsGroupByProduct: true
  }, { method: 'POST' });

  const items = [];
  const pushItems = (data) => {
    for (const item of data?.Items?.Item || []) {
      const amount = parseFloat(item.PretaxAmount || 0);
      if (amount > 0) items.push({
        service: item.ProductName || item.ProductCode || '未分类',
        amount: amount.toFixed(2),
        unit: 'CNY'
      });
    }
  };
  pushItems(res.Data);

  // 分组结果可能分页，用 NextToken 翻页取全
  let nextToken = res.Data?.NextToken;
  while (nextToken) {
    const page = await client.request('QueryAccountBill', {
      BillingCycle: `${year}-${month}`,
      Granularity: 'MONTHLY',
      IsGroupByProduct: true,
      NextToken: nextToken
    }, { method: 'POST' });
    pushItems(page.Data);
    nextToken = page.Data?.NextToken;
  }

  items.sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));
  const total = items.reduce((s, i) => s + parseFloat(i.amount), 0).toFixed(2);
  return { total, unit: 'CNY', items };
}

// ── 百度云账单 ──
// chargeitem = 后付费明细；order/list = 预付费订单；两者合并才是完整月账单
async function fetchBaiduBilling(cred, year, month) {
  const billingHost = 'billing.baidubce.com';
  const billMonth   = `${year}-${month}`;
  const PAGE_SIZE   = 100;
  const CONCURRENCY = 20;  // 官方限速 20次/秒，每批20个 + 1秒间隔 = 恰好达到上限

  // ① 第一页：获取 totalCount，同时检查 API 是否正确返回 pageNo
  const firstRes = await bceRequest(cred, 'POST', '/v1/bill/resource/chargeitem', {}, {
    billMonth, pageNo: 1, pageSize: PAGE_SIZE
  }, billingHost);

  const totalCount = firstRes.totalCount || 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  console.log(`[billing/baidu] totalCount=${totalCount} totalPages=${totalPages} responsePageNo=${firstRes.pageNo}`);

  // 打印第一条记录的所有价格字段，便于确认使用哪个字段
  const sample = (firstRes.bills || [])[0];
  if (sample) {
    const priceFields = ['originPrice','discountPrice','financePrice','couponPrice',
      'cashEquivalentCouponPrice','discountCouponPrice','promotionPrice',
      'catalogPrice','sysGold','deductPrice','cashPayment','voucherPayment'];
    const vals = Object.fromEntries(priceFields.map(f => [f, sample[f]]));
    console.log('[billing/baidu] sample item price fields:', JSON.stringify(vals));
  }

  // ② billId 去重集合 + 聚合 map
  const seenIds    = new Set();
  const serviceMap = {};

  function processItems(bills) {
    for (const item of bills) {
      if (!item.billId || seenIds.has(item.billId)) continue;  // 去重
      seenIds.add(item.billId);

      const key = item.serviceTypeName || item.serviceType || '其他';
      if (!serviceMap[key]) serviceMap[key] = { amount: 0, usageAmt: 0, usageUnit: item.pricingUnit || '' };
      serviceMap[key].usageAmt += parseFloat(item.amount || 0);
      // financePrice = 结算价（现金 + 代金券），即实际扣费总额
      const price = parseFloat(item.financePrice || item.deductPrice || 0);
      serviceMap[key].amount += price;
    }
  }

  processItems(firstRes.bills || []);

  // ③ 并发拉取剩余页，每批限速（官方 20次/秒，每批10个+1秒间隔 ≈ 10 req/s）
  const remaining = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batchStart = Date.now();
    const batch = remaining.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(pageNo => bceRequest(cred, 'POST', '/v1/bill/resource/chargeitem', {}, {
        billMonth, pageNo, pageSize: PAGE_SIZE
      }, billingHost))
    );
    for (const r of results) {
      if (r.status === 'fulfilled') processItems(r.value.bills || []);
      else console.warn(`[billing/baidu] page failed: ${r.reason?.message}`);
    }
    // 限速：每批至少等满 1 秒，确保不超过 20 req/s
    const elapsed = Date.now() - batchStart;
    if (elapsed < 1000 && i + CONCURRENCY < remaining.length) {
      await new Promise(resolve => setTimeout(resolve, 1000 - elapsed));
    }
  }

  console.log(`[billing/baidu] unique records processed: ${seenIds.size} / ${totalCount}`);

  // ④ 预付费订单（order/list），与后付费合并到 serviceMap
  const prepayMap = await fetchBaiduPrepayBilling(cred, year, month, billingHost);
  let prepayTotal = 0;
  for (const [key, amount] of Object.entries(prepayMap)) {
    if (!serviceMap[key]) serviceMap[key] = { amount: 0, usageAmt: 0, usageUnit: '' };
    serviceMap[key].amount += amount;
    prepayTotal += amount;
  }

  const items = Object.entries(serviceMap)
    .map(([service, d]) => ({
      service,
      amount:    d.amount.toFixed(2),
      usage:     Math.round(d.usageAmt),
      usageUnit: d.usageUnit,
      unit:      'CNY'
    }))
    .sort((a, b) => parseFloat(b.amount) - parseFloat(a.amount));

  const total = items.reduce((s, i) => s + parseFloat(i.amount), 0).toFixed(2);
  return {
    total, unit: 'CNY', items, totalCount,
    uniqueCount: seenIds.size,
    prepayTotal: prepayTotal.toFixed(2),
    allZero: items.length > 0 && items.every(i => parseFloat(i.amount) === 0)
  };
}

// ── 百度云预付费订单账单（order/list）──
// 查询指定月份内所有非纯后付费订单，与 chargeitem（后付费）合并才是完整月账单。
// productType 不传 = 返回全部类型；跳过 'postpay'（已由 chargeitem 覆盖），
// 保留 'prepay' 和 'postpay__prepay' 等混合类型。
async function fetchBaiduPrepayBilling(cred, year, month, billingHost) {
  // 用 UTC 月份边界，与百度 API 保持一致
  const startTime = `${year}-${month}-01T00:00:00Z`;
  const nextMonth = new Date(Date.UTC(parseInt(year), parseInt(month), 1));
  const endTime   = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00Z`;

  const serviceMap = {};
  let pageNo = 1;
  let totalCount = null;

  while (true) {
    // 不传 productType，拉全部订单类型
    const res = await bceRequest(cred, 'POST', '/v1/order/list', {}, {
      startTime,
      endTime,
      pageNo,
      pageSize: 100
    }, billingHost);

    const orders = res.orders || [];
    if (totalCount === null) {
      totalCount = res.totalCount || 0;
      console.log(`[billing/baidu-prepay] totalCount=${totalCount}`);
    }
    console.log(`[billing/baidu-prepay] page ${pageNo}, got ${orders.length} orders`);

    // 打印第一条订单的完整 orderFee 和 productType，方便核对字段
    if (pageNo === 1 && orders[0]) {
      console.log('[billing/baidu-prepay] sample productType:', orders[0].productType,
        '\n  price:', orders[0].price,
        '\n  orderFee:', JSON.stringify(orders[0].orderFee));
    }

    for (const order of orders) {
      // 纯后付费订单跳过（已由 chargeitem 覆盖，加进来会重复计算）
      if (order.productType === 'postpay') continue;

      const key = order.serviceTypeName || order.serviceType || '其他';
      if (!serviceMap[key]) serviceMap[key] = 0;

      const fee = order.orderFee || {};
      // 优先用 totalAmount（应付总额），涵盖所有支付方式
      // 若无则回退到逐项相加，最后回退到 order.price
      const totalAmt = parseFloat(fee.totalAmount || 0);
      const sumFields = parseFloat(fee.cashPayment        || 0)
                      + parseFloat(fee.voucherPayment      || 0)
                      + parseFloat(fee.giftCardPayment     || 0)
                      + parseFloat(fee.deductCouponPayment || 0);
      const amount = totalAmt || sumFields || parseFloat(order.price || 0);
      serviceMap[key] += amount;
    }

    if (orders.length < 100) break;
    pageNo++;
  }

  console.log(`[billing/baidu-prepay] prepay total by service:`, serviceMap);
  return serviceMap;
}

module.exports = router;
