// ─────────────────────────────────────────
// 飞书集成 & 审批工单
// ─────────────────────────────────────────

// ── 飞书配置页 ──
async function loadFeishuConfig() {
  const r = await get('/feishu/config');
  if (!r.ok) return;
  const { data, webhook_url } = r.data;
  if (!data) return;
  document.getElementById('fs-app-id').value       = data.app_id       || '';
  document.getElementById('fs-app-secret').value   = data.app_secret   || '';
  document.getElementById('fs-approver').value      = data.approver_open_id || '';
  document.getElementById('fs-vtoken').value        = data.verification_token || '';
  document.getElementById('fs-ekey').value          = data.encrypt_key  || '';
  document.getElementById('fs-approval-code').value = data.approval_code || '';
  document.getElementById('fs-platform-url').value  = data.platform_url  || '';
  document.getElementById('fs-webhook-url').value   = webhook_url || '';
  document.getElementById('fs-oauth-callback').value = window.location.origin + '/api/feishu/oauth/callback';
}

async function saveFeishuConfig() {
  const body = {
    app_id:             document.getElementById('fs-app-id').value.trim(),
    app_secret:         document.getElementById('fs-app-secret').value.trim() || '****',
    approver_open_id:   document.getElementById('fs-approver').value.trim(),
    verification_token: document.getElementById('fs-vtoken').value.trim() || '****',
    encrypt_key:        document.getElementById('fs-ekey').value.trim() || '****',
    approval_code:      document.getElementById('fs-approval-code').value.trim(),
    platform_url:       document.getElementById('fs-platform-url').value.trim(),
    enabled: true,
  };
  const msgEl = document.getElementById('fs-msg');
  msgEl.textContent = '';
  const r = await put('/feishu/config', body);
  if (r.ok) { toast('飞书配置已保存', 'ok'); msgEl.style.color = 'var(--success)'; msgEl.textContent = '保存成功'; }
  else { msgEl.style.color = ''; msgEl.textContent = r.data?.error || '保存失败'; }
}

async function testFeishuConn() {
  await saveFeishuConfig();
  const msgEl = document.getElementById('fs-msg');
  const r = await post('/feishu/config/test', {});
  if (r.ok) { msgEl.style.color = 'var(--success)'; msgEl.textContent = '✓ 飞书连接正常'; toast('连接测试成功', 'ok'); }
  else { msgEl.style.color = ''; msgEl.textContent = r.data?.error || '连接失败'; }
}

async function initFeishuApproval() {
  await saveFeishuConfig();
  const msgEl = document.getElementById('fs-msg');
  msgEl.textContent = '正在创建审批定义...';
  const r = await post('/feishu/config/init-approval', {});
  if (r.ok) {
    document.getElementById('fs-approval-code').value = r.data.approval_code;
    msgEl.style.color = 'var(--success)';
    msgEl.textContent = `✓ 审批定义创建成功：${r.data.approval_code}`;
    toast('审批定义已创建', 'ok');
  } else {
    msgEl.style.color = '';
    msgEl.textContent = r.data?.error || '创建失败';
  }
}

function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => toast('已复制', 'ok'));
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    toast('已复制', 'ok');
  }
}

function copyWebhookUrl() {
  const url = document.getElementById('fs-webhook-url').value;
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => toast('已复制到剪贴板', 'ok'));
}

function copyOauthCallback() {
  const url = document.getElementById('fs-oauth-callback').value;
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => toast('已复制到剪贴板', 'ok'));
}

// ── 审批工单页（管理员） ──
let _ticketFilter = 'all';
let _ticketUserFilter = '';
let _ticketPage = 1;
const _ticketPageSize = 20;
let _ticketReqId = 0;          // 防止过期响应覆盖
let _ticketFilterTimer = null; // 防抖计时器

function setTicketFilter(status, el) {
  _ticketFilter = status;
  _ticketPage = 1;
  document.querySelectorAll('#sec-approval-tickets .filter-tab').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  loadTickets();
}

// 从首页统计卡片跳转到工单页并按指定状态筛选（同步高亮对应 tab）
function goTicketsWithFilter(status) {
  navTo('approval-tickets');
  const tabs = document.querySelectorAll('#sec-approval-tickets .filter-tab');
  let matched = null;
  tabs.forEach(b => {
    b.classList.remove('active');
    if (b.getAttribute('onclick') === `setTicketFilter('${status}',this)`) matched = b;
  });
  setTicketFilter(status, matched);
}

function setTicketUserFilter(value) {
  _ticketUserFilter = value;
  _ticketPage = 1;
  loadTickets();
}

function setTicketPage(page) {
  _ticketPage = page;
  loadTickets();
}

// ── 我的申请记录 ──
let _myTicketFilter = 'all';

function setMyTicketFilter(status, el) {
  _myTicketFilter = status;
  document.querySelectorAll('#sec-my-tickets .filter-tab').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  loadMyTickets();
}

async function loadMyTickets() {
  const wrap = document.getElementById('my-tickets-wrap');
  const loading = document.getElementById('my-tickets-loading');
  if (!wrap) return;
  loading?.classList.remove('hidden');
  wrap.innerHTML = '';

  await syncFeishuStatus();

  const params = _myTicketFilter !== 'all' ? `?status=${_myTicketFilter}` : '';
  const r = await get(`/feishu/my-tickets${params}`);
  loading?.classList.add('hidden');
  if (!r.ok) { wrap.innerHTML = '<div class="empty-tip">加载失败</div>'; return; }

  const { tickets, total } = r.data;
  if (!tickets?.length) { wrap.innerHTML = '<div class="empty-tip">暂无申请记录</div>'; return; }

  tickets.forEach(t => { _ticketsCache[t.id] = t; });

  const STATUS_LABEL = { pending: '待审批', approved: '待授权', rejected: '已拒绝', cancelled: '已撤销', processing: '创建中', completed: '已完成', failed: '创建失败' };
  const STATUS_CLASS = { pending: 'badge-warn', approved: 'badge-info', rejected: 'badge-err', cancelled: 'badge-gray', processing: 'badge-info', completed: 'badge-ok', failed: 'badge-err' };

  wrap.innerHTML = `<table class="acc-table">
    <thead><tr>
      <th>工单 ID</th><th>申请资源</th><th>状态</th><th>申请时间</th><th>操作</th>
    </tr></thead>
    <tbody>
      ${tickets.map(t => {
        const draft = (() => { try { return JSON.parse(t.account_draft); } catch { return {}; } })();
        const PLABEL = { aws:'AWS', aliyun:'阿里云', baidu:'百度云', jumpserver:'JumpServer', bytebase:'Bytebase', kuboard:'Kuboard' };

        // 密码重置工单
        if (draft.ticket_type === 'password_reset') {
          const target = draft.reset_target || {};
          let resourceCell = '';
          if (target.type === 'cloud') {
            resourceCell = `${PLABEL[target.platform] || target.platform} <span class="badge badge-warn" style="font-size:10px;margin-left:3px;padding:1px 4px">密码重置</span><br><span style="font-size:11px;color:var(--g500)">账号：${esc(target.account || '-')}</span>`;
          } else if (target.type === 'vpn') {
            resourceCell = `${PLABEL[target.platform] || target.platform} <span class="badge badge-warn" style="font-size:10px;margin-left:3px;padding:1px 4px">VPN密码重置</span><br><span style="font-size:11px;color:var(--g500)">客户端：${esc(target.client || '-')}</span>`;
          } else if (target.type === 'system') {
            resourceCell = `${PLABEL[target.tool] || target.tool} <span class="badge badge-warn" style="font-size:10px;margin-left:3px;padding:1px 4px">密码重置</span>`;
          }
          const label = STATUS_LABEL[t.status] || t.status;
          const cls   = STATUS_CLASS[t.status]  || 'badge-gray';
          let actions = '-';
          if (t.status === 'pending') {
            actions = `<button class="btn-ghost" style="padding:4px 10px;font-size:12px" onclick="cancelTicket('${t.id}','my')">撤销</button>`;
          } else if (t.status === 'completed') {
            actions = `<button class="btn-ghost" style="padding:4px 10px;font-size:12px" onclick="showTicketResult('${t.id}')">查看结果</button>`;
          } else if (t.status === 'rejected') {
            actions = `<span style="font-size:12px;color:var(--danger,#dc2626);font-weight:600">已拒绝</span>${t.reject_reason ? `<br><span style="font-size:11.5px;color:var(--g500)">${esc(t.reject_reason)}</span>` : ''}`;
          } else if (t.status === 'failed') {
            const failResult = (() => { try { return JSON.parse(t.cloud_result); } catch { return null; } })();
            const msg = failResult?.message || '';
            actions = `<span style="font-size:12px;color:var(--danger,#dc2626);font-weight:600">重置失败</span>${msg ? `<br><span style="font-size:11.5px;color:var(--g500)">${esc(msg)}</span>` : ''}`;
          }
          return `<tr>
            <td style="font-size:11px;color:var(--g400);font-family:monospace" title="${t.id}"><span>${t.id.slice(0,8)}…</span> <button class="btn-ghost" style="padding:2px 5px;font-size:10px;vertical-align:middle" onclick="event.stopPropagation();copyText('${t.id}')">复制</button></td>
            <td style="line-height:1.8">${resourceCell}</td>
            <td><span class="badge ${cls}">${label}</span></td>
            <td style="font-size:12px;color:var(--g400)">${t.created_at?.slice(0,16) || '-'}</td>
            <td>${actions}</td>
          </tr>`;
        }

        // 账号申请工单
        const iamPlatforms = (draft.cloud_platforms || (draft.cloud_accounts || []).map(ca => ca.platform)).map(p => PLABEL[p] || p);
        const vpnPlatforms = [...new Set((draft.vpn_requests || []).map(v => PLABEL[v.platform] || v.platform))];
        const otherReqs = draft.other_requests || [];
        const ACTION_LABEL_S = { create:'创建', authorize:'授权访问' };
        const otherSummary = otherReqs.map(r => {
          const pname  = PLABEL[r.platform] || r.platform || '';
          const rname  = r.name || r.type || '';
          const action = r.action ? `<span class="badge badge-gray" style="font-size:10px;padding:1px 4px;margin-left:3px">${ACTION_LABEL_S[r.action]||r.action}</span>` : '';
          let detail = '';
          if (r.bucket) detail += `<code style="background:var(--g100);padding:1px 5px;border-radius:3px;font-size:11px;margin-left:4px">${esc(r.bucket)}</code>`;
          if (r.region) detail += `<span style="font-size:10px;color:var(--g500);margin-left:4px">${esc(r.region)}</span>`;
          if (r.permission) detail += `<span class="badge badge-${r.permission === 'readwrite' ? 'warn' : 'ok'}" style="font-size:10px;padding:1px 5px;margin-left:4px">${r.permission === 'readwrite' ? '读写' : '只读'}</span>`;
          if (r.path)   detail += `<span style="font-size:11px;color:var(--g400);margin-left:4px">路径：${esc(r.path)}</span>`;
          if (r.description) detail += `<span style="font-size:11px;color:var(--g400);margin-left:4px">${esc(r.description)}</span>`;
          return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px;line-height:1.8">
            <span class="badge badge-info" style="font-size:10px;padding:1px 5px">${esc(pname)}</span>
            <span style="font-size:12px;color:var(--g700)">${esc(rname)}</span>${action}${detail}
          </div>`;
        });
        const resourceParts = [];
        if (iamPlatforms.length)  resourceParts.push(iamPlatforms.map(p => `${p}<span class="badge badge-gray" style="font-size:10px;margin-left:3px;padding:1px 4px">IAM</span>`).join(' '));
        if (vpnPlatforms.length)  resourceParts.push(vpnPlatforms.map(p => `${p}<span class="badge badge-info" style="font-size:10px;margin-left:3px;padding:1px 4px">VPN</span>`).join(' '));
        if (otherSummary.length)  resourceParts.push(otherSummary.join(''));
        const resourceCell = resourceParts.length ? resourceParts.join('<br>') : '-';

        const label = STATUS_LABEL[t.status] || t.status;
        const cls   = STATUS_CLASS[t.status]  || 'badge-gray';
        let actions = '-';
        if (t.status === 'pending') {
          actions = `<button class="btn-ghost" style="padding:4px 10px;font-size:12px" onclick="cancelTicket('${t.id}','my')">撤销</button>`;
        } else if (t.status === 'completed') {
          actions = `<button class="btn-ghost" style="padding:4px 10px;font-size:12px" onclick="showTicketResult('${t.id}')">查看结果</button>`;
        } else if (t.status === 'rejected') {
          actions = `<span style="font-size:12px;color:var(--danger,#dc2626);font-weight:600">已拒绝</span>${t.reject_reason ? `<br><span style="font-size:11.5px;color:var(--g500)">${esc(t.reject_reason)}</span>` : ''}`;
        } else if (t.status === 'failed') {
          const failResult = (() => { try { return JSON.parse(t.cloud_result); } catch { return null; } })();
          const failMsgs = [];

          // 账号申请工单：从 cloud_results 数组提取失败信息
          if (failResult?.cloud_results) {
            failResult.cloud_results.filter(r => r.status === 'failed').forEach(r => {
              if (r.message) failMsgs.push(r.message);
            });
          }
          // 密码重置工单：从单个对象提取失败信息
          else if (failResult && !failResult.success && failResult.message) {
            failMsgs.push(failResult.message);
          }

          const vpnFail = (() => { try { return JSON.parse(t.vpn_result); } catch { return null; } })();
          if (Array.isArray(vpnFail)) vpnFail.filter(r => !r.success && r.message).forEach(r => failMsgs.push(r.message));
          actions = `<span style="font-size:12px;color:var(--danger,#dc2626);font-weight:600">创建失败</span>${failMsgs.length ? `<br><span style="font-size:11.5px;color:var(--g500)">${esc(failMsgs[0])}</span>` : ''}`;
        }
        return `<tr>
          <td style="font-size:11px;color:var(--g400);font-family:monospace" title="${t.id}"><span>${t.id.slice(0,8)}…</span> <button class="btn-ghost" style="padding:2px 5px;font-size:10px;vertical-align:middle" onclick="event.stopPropagation();copyText('${t.id}')">复制</button></td>
          <td style="line-height:1.8">${resourceCell}</td>
          <td><span class="badge ${cls}">${label}</span></td>
          <td style="font-size:12px;color:var(--g400)">${t.created_at?.slice(0,16) || '-'}</td>
          <td>${actions}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  <div style="font-size:12px;color:var(--g400);margin-top:12px">共 ${total} 条</div>`;
}

async function loadTickets() {
  const wrap = document.getElementById('tickets-wrap');
  const loading = document.getElementById('tickets-loading');
  if (!wrap) return;
  const reqId = ++_ticketReqId;
  loading?.classList.remove('hidden');
  wrap.innerHTML = '';
  _ticketsCache = {};

  // 先同步飞书审批状态，再加载工单列表
  await syncFeishuStatus();

  const qs = new URLSearchParams();
  if (_ticketFilter !== 'all') qs.set('status', _ticketFilter);
  if (_ticketUserFilter.trim()) qs.set('username', _ticketUserFilter.trim());
  qs.set('page', _ticketPage);
  qs.set('pageSize', _ticketPageSize);
  const r = await get(`/feishu/tickets?${qs}`);
  if (reqId !== _ticketReqId) return;
  loading?.classList.add('hidden');
  if (!r.ok) { wrap.innerHTML = '<div class="empty-tip">加载失败</div>'; return; }

  const { tickets, total } = r.data;
  if (!tickets?.length) { wrap.innerHTML = '<div class="empty-tip">暂无工单</div>'; return; }

  tickets.forEach(t => { _ticketsCache[t.id] = t; });

  const STATUS_LABEL = { pending: '待审批', approved: '待授权', rejected: '已拒绝', cancelled: '已撤销', processing: '创建中', completed: '已完成', failed: '创建失败' };
  const STATUS_CLASS = { pending: 'badge-warn', approved: 'badge-info', rejected: 'badge-err', cancelled: 'badge-gray', processing: 'badge-info', completed: 'badge-ok', failed: 'badge-err' };
  const isAdmin = document.body.classList.contains('role-admin');

  wrap.innerHTML = `<table class="acc-table">
    <thead><tr>
      <th>工单 ID</th><th>姓名</th><th>账号名称</th><th>申请资源</th><th>状态</th><th>申请时间</th><th>操作</th>
    </tr></thead>
    <tbody>
      ${tickets.map(t => {
        const draft = (() => { try { return JSON.parse(t.account_draft); } catch { return {}; } })();
        const PLABEL = { aws:'AWS', aliyun:'阿里云', baidu:'百度云', jumpserver:'JumpServer', bytebase:'Bytebase', kuboard:'Kuboard' };

        // 密码重置工单
        if (draft.ticket_type === 'password_reset') {
          const target = draft.reset_target || {};
          let resourceCell = '';
          if (target.type === 'cloud') {
            resourceCell = `${PLABEL[target.platform] || target.platform} <span class="badge badge-warn" style="font-size:10px;margin-left:3px;padding:1px 4px">密码重置</span><br><span style="font-size:11px;color:var(--g500)">账号：${esc(target.account || '-')}</span>`;
          } else if (target.type === 'vpn') {
            resourceCell = `${PLABEL[target.platform] || target.platform} <span class="badge badge-warn" style="font-size:10px;margin-left:3px;padding:1px 4px">VPN密码重置</span><br><span style="font-size:11px;color:var(--g500)">客户端：${esc(target.client || '-')}</span>`;
          } else if (target.type === 'system') {
            resourceCell = `${PLABEL[target.tool] || target.tool} <span class="badge badge-warn" style="font-size:10px;margin-left:3px;padding:1px 4px">密码重置</span>`;
          }
          const label = STATUS_LABEL[t.status] || t.status;
          const cls   = STATUS_CLASS[t.status]  || 'badge-gray';
          const isOwner = me && t.submitter_id === me.id;
          const actions = t.status === 'pending'
            ? [
                isAdmin ? `<button class="btn-sm btn-primary" style="padding:4px 10px;font-size:12px" onclick="openApproveModal('${t.id}')">批准</button>` : '',
                (isAdmin || isOwner) ? `<button class="btn-ghost" style="padding:4px 10px;font-size:12px" onclick="cancelTicket('${t.id}')">撤销</button>` : '',
              ].filter(Boolean).join(' ')
            : t.status === 'approved'
              ? (isAdmin ? `<button class="btn-sm btn-primary" style="padding:4px 10px;font-size:12px" onclick="openApproveModal('${t.id}')">授权</button>` : '-')
            : t.status === 'completed'
              ? `<button class="btn-ghost" style="padding:4px 10px;font-size:12px" onclick="showTicketResult('${t.id}')">查看结果</button>`
            : (t.status === 'rejected'
                ? `<span style="font-size:12px;color:var(--danger,#dc2626);font-weight:600">已拒绝</span>${t.reject_reason ? `<br><span style="font-size:11.5px;color:var(--g500)">${esc(t.reject_reason)}</span>` : ''}`
                : '-');
          return `<tr>
            <td style="font-size:11px;color:var(--g400);font-family:monospace" title="${t.id}"><span>${t.id.slice(0,8)}…</span> <button class="btn-ghost" style="padding:2px 5px;font-size:10px;vertical-align:middle" onclick="event.stopPropagation();copyText('${t.id}')">复制</button></td>
            <td>${esc(draft.real_name || t.submitter_name)}</td>
            <td><code style="background:var(--g100);padding:1px 5px;border-radius:4px;font-size:12px">${esc(draft.cloud_username || '-')}</code></td>
            <td style="line-height:1.8">${resourceCell}</td>
            <td><span class="badge ${cls}">${label}</span></td>
            <td style="font-size:12px;color:var(--g400)">${t.created_at?.slice(0,16) || '-'}</td>
            <td>${actions}</td>
          </tr>`;
        }

        // 账号申请工单
        // IAM 云平台
        const iamPlatforms = (draft.cloud_platforms || (draft.cloud_accounts || []).map(ca => ca.platform))
          .map(p => PLABEL[p] || p);

        // VPN 涉及的平台
        const vpnPlatforms = [...new Set((draft.vpn_requests || []).map(v => PLABEL[v.platform] || v.platform))];

        // 其他资源（存储/计算等）汇总，含完整细节
        const otherReqs = draft.other_requests || [];
        const ACTION_LABEL_S = { create:'创建', authorize:'授权访问' };
        const otherSummary = otherReqs.map(r => {
          const pname  = PLABEL[r.platform] || r.platform || '';
          const rname  = r.name || r.type || '';
          const action = r.action ? `<span class="badge badge-gray" style="font-size:10px;padding:1px 4px;margin-left:3px">${ACTION_LABEL_S[r.action]||r.action}</span>` : '';
          let detail = '';
          if (r.bucket) detail += `<code style="background:var(--g100);padding:1px 5px;border-radius:3px;font-size:11px;margin-left:4px">${esc(r.bucket)}</code>`;
          if (r.region) detail += `<span style="font-size:10px;color:var(--g500);margin-left:4px">${esc(r.region)}</span>`;
          if (r.permission) detail += `<span class="badge badge-${r.permission === 'readwrite' ? 'warn' : 'ok'}" style="font-size:10px;padding:1px 5px;margin-left:4px">${r.permission === 'readwrite' ? '读写' : '只读'}</span>`;
          if (r.path)   detail += `<span style="font-size:11px;color:var(--g400);margin-left:4px">路径：${esc(r.path)}</span>`;
          if (r.description) detail += `<span style="font-size:11px;color:var(--g400);margin-left:4px">${esc(r.description)}</span>`;
          return `<div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px;line-height:1.8">
            <span class="badge badge-info" style="font-size:10px;padding:1px 5px">${esc(pname)}</span>
            <span style="font-size:12px;color:var(--g700)">${esc(rname)}</span>${action}${detail}
          </div>`;
        });

        // 拼接资源单元格
        const resourceParts = [];
        if (iamPlatforms.length)  resourceParts.push(iamPlatforms.map(p => `${p}<span class="badge badge-gray" style="font-size:10px;margin-left:3px;padding:1px 4px">IAM</span>`).join(' '));
        if (vpnPlatforms.length)  resourceParts.push(vpnPlatforms.map(p => `${p}<span class="badge badge-info" style="font-size:10px;margin-left:3px;padding:1px 4px">VPN</span>`).join(' '));
        if (otherSummary.length)  resourceParts.push(otherSummary.join(''));
        const resourceCell = resourceParts.length ? resourceParts.join('<br>') : '-';

        const label = STATUS_LABEL[t.status] || t.status;
        const cls   = STATUS_CLASS[t.status]  || 'badge-gray';
        const isOwner = me && t.submitter_id === me.id;
        let actions = '-';
        if (t.status === 'pending') {
          actions = [
            isAdmin ? `<button class="btn-sm btn-primary" style="padding:4px 10px;font-size:12px" onclick="openApproveModal('${t.id}')">分配权限并批准</button>` : '',
            (isAdmin || isOwner) ? `<button class="btn-ghost" style="padding:4px 10px;font-size:12px" onclick="cancelTicket('${t.id}')">撤销</button>` : '',
          ].filter(Boolean).join(' ');
        } else if (t.status === 'approved') {
          actions = isAdmin ? `<button class="btn-sm btn-primary" style="padding:4px 10px;font-size:12px" onclick="openApproveModal('${t.id}')">授权</button>` : '-';
        } else if (t.status === 'completed') {
          actions = `<button class="btn-ghost" style="padding:4px 10px;font-size:12px" onclick="showTicketResult('${t.id}')">查看结果</button>`;
        } else if (t.status === 'rejected') {
          actions = `<span style="font-size:12px;color:var(--danger,#dc2626);font-weight:600">已拒绝</span>${t.reject_reason ? `<br><span style="font-size:11.5px;color:var(--g500)">${esc(t.reject_reason)}</span>` : ''}`;
        } else if (t.status === 'failed') {
          const failResult = (() => { try { return JSON.parse(t.cloud_result); } catch { return null; } })();
          const failMsgs = [];

          // 账号申请工单：从 cloud_results 数组提取失败信息
          if (failResult?.cloud_results) {
            failResult.cloud_results.filter(r => r.status === 'failed').forEach(r => {
              if (r.message) failMsgs.push(r.message);
            });
          }
          // 密码重置工单：从单个对象提取失败信息
          else if (failResult && !failResult.success && failResult.message) {
            failMsgs.push(failResult.message);
          }

          const vpnFail = (() => { try { return JSON.parse(t.vpn_result); } catch { return null; } })();
          if (Array.isArray(vpnFail)) vpnFail.filter(r => !r.success && r.message).forEach(r => failMsgs.push(r.message));
          actions = [
            isAdmin ? `<button class="btn-sm btn-primary" style="padding:4px 10px;font-size:12px" onclick="openApproveModal('${t.id}')">重试</button>` : '',
            `<span style="font-size:12px;color:var(--danger,#dc2626);font-weight:600">创建失败</span>${failMsgs.length ? `<br><span style="font-size:11.5px;color:var(--g500)">${esc(failMsgs[0])}</span>` : ''}`,
          ].filter(Boolean).join(' ');
        }
        return `<tr>
          <td style="font-size:11px;color:var(--g400);font-family:monospace" title="${t.id}"><span>${t.id.slice(0,8)}…</span> <button class="btn-ghost" style="padding:2px 5px;font-size:10px;vertical-align:middle" onclick="event.stopPropagation();copyText('${t.id}')">复制</button></td>
          <td>${esc(draft.real_name || t.submitter_name)}</td>
          <td><code style="background:var(--g100);padding:1px 5px;border-radius:4px;font-size:12px">${esc(draft.cloud_username || '-')}</code></td>
          <td style="line-height:1.8">${resourceCell}</td>
          <td><span class="badge ${cls}">${label}</span></td>
          <td style="font-size:12px;color:var(--g400)">${t.created_at?.slice(0,16) || '-'}</td>
          <td>${actions}</td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>
  ${renderTicketPagination(total)}`;
}

function renderTicketPagination(total) {
  const totalPages = Math.ceil(total / _ticketPageSize);
  if (totalPages <= 1) return `<div style="font-size:12px;color:var(--g400);margin-top:12px">共 ${total} 条</div>`;
  const p = _ticketPage;
  let pages = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= p - 2 && i <= p + 2)) {
      pages.push(i);
    } else if (pages[pages.length - 1] !== '…') {
      pages.push('…');
    }
  }
  const btn = (label, page, disabled) =>
    `<button onclick="${disabled ? '' : `setTicketPage(${page})`}" style="min-width:30px;height:28px;padding:0 8px;border:1px solid var(--border);border-radius:5px;background:${disabled ? 'var(--g100)' : 'var(--card)'};color:${disabled ? 'var(--g400)' : 'var(--g800)'};cursor:${disabled ? 'default' : 'pointer'};font-size:13px">${label}</button>`;
  const pageButtons = pages.map(i =>
    i === '…'
      ? `<span style="padding:0 4px;color:var(--g400)">…</span>`
      : btn(i, i, i === p)
  ).join('');
  return `<div style="display:flex;align-items:center;gap:6px;margin-top:14px;flex-wrap:wrap">
    ${btn('‹', p - 1, p <= 1)}
    ${pageButtons}
    ${btn('›', p + 1, p >= totalPages)}
    <span style="font-size:12px;color:var(--g400);margin-left:6px">共 ${total} 条，第 ${p} / ${totalPages} 页</span>
  </div>`;
}

async function syncFeishuStatus() {
  try {
    await post('/feishu/tickets/sync-pending', {});
  } catch (e) {
    // 静默失败，不阻塞页面加载
  }
}

async function cancelTicket(id, from) {
  const ticket = _ticketsCache[id];
  if (!confirm('确认撤销该工单？')) return;
  const r = await del(`/feishu/tickets/${id}`);
  if (r.ok) {
    toast('工单已撤销', 'ok');
    from === 'my' ? loadMyTickets() : loadTickets();
  } else {
    toast(r.data?.error || '撤销失败', 'err');
  }
}

function closeTicketResultModal() {
  document.getElementById('modal-ticket-result').classList.add('hidden');
}

function showTicketResult(id) {
  const ticket = _ticketsCache[id];
  if (!ticket) { toast('工单数据未加载，请刷新后重试', 'err'); return; }

  const draft       = (() => { try { return JSON.parse(ticket.account_draft); } catch { return {}; } })();
  const cloudResult = (() => { try { return JSON.parse(ticket.cloud_result);  } catch { return null; } })();
  const vpnResult   = (() => { try { return JSON.parse(ticket.vpn_result);    } catch { return null; } })();
  const storageResult = (() => { try { return JSON.parse(ticket.storage_result); } catch { return null; } })();
  const bucketResult  = (() => { try { return JSON.parse(ticket.bucket_result);  } catch { return null; } })();
  const rdsResult     = (() => { try { return JSON.parse(ticket.rds_result);     } catch { return null; } })();
  const vmResult      = (() => { try { return JSON.parse(ticket.vm_result);      } catch { return null; } })();
  const k8sResult     = (() => { try { return JSON.parse(ticket.k8s_result);     } catch { return null; } })();
  const dbInstResult  = (() => { try { return JSON.parse(ticket.db_instance_result); } catch { return null; } })();

  const PSHORT = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云', jumpserver: 'JumpServer', bytebase: 'Bytebase', kuboard: 'Kuboard', 'grafana-aws': 'Grafana(AWS)', 'grafana-wuwen': 'Grafana(无问)', 'grafana-baidu': 'Grafana(百度)' };
  const STATUS_ICON = { active: '✅', failed: '❌', no_credential: '⚠️', pending: '⏳' };

  // 密码重置工单结果
  if (draft.ticket_type === 'password_reset') {
    const target = draft.reset_target || {};
    let targetDesc = '';
    if (target.type === 'cloud') targetDesc = `${PSHORT[target.platform] || target.platform} 云账号：${target.account || '-'}`;
    else if (target.type === 'vpn') targetDesc = `${PSHORT[target.platform] || target.platform} VPN 客户端：${target.client || '-'}`;
    else if (target.type === 'system') targetDesc = `${PSHORT[target.tool] || target.tool} 平台工具账号`;

    const resetResult = cloudResult || {};
    const icon = resetResult.success ? '✅' : '❌';
    const statusText = resetResult.success ? '重置成功' : '重置失败';

    let html = `<div style="background:var(--g50);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;display:flex;flex-wrap:wrap;gap:8px 20px">
      <span><strong>申请人：</strong>${esc(draft.real_name || ticket.submitter_name)}</span>
      <span><strong>工单类型：</strong>密码重置</span>
      <span><strong>完成时间：</strong>${ticket.resolved_at?.slice(0,16) || '-'}</span>
    </div>`;

    html += `<div style="font-weight:600;font-size:13px;color:var(--g600);margin-bottom:8px">密码重置结果</div>`;
    html += `<div class="card" style="padding:14px 16px;margin-bottom:10px">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
        <span style="font-size:13px">${icon} ${statusText}</span>
      </div>
      <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px;color:var(--g600)">
        <span style="color:var(--g400)">重置目标</span><span>${esc(targetDesc)}</span>
        ${draft.reason ? `<span style="color:var(--g400)">申请原因</span><span>${esc(draft.reason)}</span>` : ''}
        ${resetResult.message ? `<span style="color:var(--g400)">结果说明</span><span>${esc(resetResult.message)}</span>` : ''}
      </div>
    </div>`;

    document.getElementById('modal-title').textContent = '密码重置结果';
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-overlay').classList.remove('hidden');
    return;
  }

  let html = `<div style="background:var(--g50);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;display:flex;flex-wrap:wrap;gap:8px 20px">
    <span><strong>申请人：</strong>${esc(draft.real_name || ticket.submitter_name)}</span>
    ${draft.cloud_username ? `<span><strong>账号名：</strong><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(draft.cloud_username)}</code></span>` : ''}
    <span><strong>完成时间：</strong>${ticket.resolved_at?.slice(0,16) || '-'}</span>
  </div>`;

  // 云账号创建结果
  const cloudResults = cloudResult?.cloud_results || [];
  if (cloudResults.length > 0) {
    html += `<div style="font-weight:600;font-size:13px;color:var(--g600);margin-bottom:8px">云账号创建结果</div>`;
    for (const cr of cloudResults) {
      const icon = STATUS_ICON[cr.status] || '❓';
      const pname = PSHORT[cr.platform] || cr.platform;
      html += `<div class="card" style="padding:14px 16px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span class="badge badge-info">${esc(pname)}</span>
          <span style="font-size:13px">${icon} ${cr.status === 'active' ? '创建成功' : cr.status === 'failed' ? '创建失败' : cr.status === 'no_credential' ? '未配置凭据' : cr.status}</span>
        </div>
        ${cr.status === 'active' ? `
          <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px;color:var(--g600)">
            <span style="color:var(--g400)">账号名称</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(cr.cloud_username || draft.cloud_username || '-')}</code></span>
            ${cr.accessKey ? `<span style="color:var(--g400)">Access Key</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px;font-size:11.5px">${esc(cr.accessKey)}</code></span>` : ''}
            ${cr.secretKey ? `<span style="color:var(--g400)">Secret Key</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px;font-size:11.5px">${esc(cr.secretKey)}</code></span>` : ''}
            ${cr.consoleUrl ? `<span style="color:var(--g400)">控制台登录</span><span><a href="${esc(cr.consoleUrl)}" target="_blank" style="font-size:11.5px">${esc(cr.consoleUrl)}</a></span>` : ''}
          </div>` : `<div style="font-size:12.5px;color:var(--danger,#dc2626)">${esc(cr.message || '')}</div>`}
      </div>`;
    }
  }

  // VPN 创建结果
  const vpnResults = Array.isArray(vpnResult) ? vpnResult : [];
  if (vpnResults.length > 0) {
    html += `<div style="font-weight:600;font-size:13px;color:var(--g600);margin-bottom:8px;margin-top:4px">VPN 创建结果</div>`;
    for (const vr of vpnResults) {
      const icon  = vr.success ? '✅' : '❌';
      const pname = PSHORT[vr.platform] || vr.platform;
      html += `<div class="card" style="padding:14px 16px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:${vr.success ? 8 : 0}px">
          <span class="badge badge-info">${esc(pname)}</span>
          <span style="font-size:13px">${icon} ${vr.success ? '创建成功' : '创建失败'}</span>
        </div>
        ${vr.success ? `
          <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px;color:var(--g600)">
            <span style="color:var(--g400)">客户端名称</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(vr.clientName || '-')}</code></span>
            ${vr.clientId ? `<span style="color:var(--g400)">Client ID</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px;font-size:11.5px">${esc(vr.clientId)}</code></span>` : ''}
          </div>` : `<div style="font-size:12.5px;color:var(--danger,#dc2626)">${esc(vr.message || '')}</div>`}
      </div>`;
    }
  }

  // 存储桶创建结果
  const bucketResults = Array.isArray(bucketResult) ? bucketResult : [];
  if (bucketResults.length > 0) {
    html += `<div style="font-weight:600;font-size:13px;color:var(--g600);margin-bottom:8px;margin-top:4px">存储桶创建结果</div>`;
    for (const br of bucketResults) {
      const icon  = br.success ? '✅' : '❌';
      const pname = PSHORT[br.platform] || br.platform;
      html += `<div class="card" style="padding:14px 16px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:${br.success ? 8 : 0}px">
          <span class="badge badge-info">${esc(pname)}</span>
          <span style="font-size:13px">${icon} ${br.success ? '创建成功' : '创建失败'}</span>
        </div>
        ${br.success ? `
          <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px;color:var(--g600)">
            <span style="color:var(--g400)">Bucket</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(br.bucket)}</code></span>
            <span style="color:var(--g400)">地域</span><span>${esc(br.region || '-')}</span>
          </div>` : `<div style="font-size:12.5px;color:var(--danger,#dc2626)">${esc(br.message || '')}</div>`}
      </div>`;
    }
  }

  // 存储桶授权结果
  const storageResults = Array.isArray(storageResult) ? storageResult : [];
  if (storageResults.length > 0) {
    html += `<div style="font-weight:600;font-size:13px;color:var(--g600);margin-bottom:8px;margin-top:4px">存储桶授权结果</div>`;
    for (const sr of storageResults) {
      const icon  = sr.success ? '✅' : '❌';
      const pname = PSHORT[sr.platform] || sr.platform;
      html += `<div class="card" style="padding:14px 16px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:${sr.success ? 8 : 0}px">
          <span class="badge badge-info">${esc(pname)}</span>
          <span style="font-size:13px">${icon} ${sr.success ? '授权成功' : '授权失败'}</span>
        </div>
        ${sr.success ? `
          <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px;color:var(--g600)">
            <span style="color:var(--g400)">Bucket</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(sr.bucket)}</code></span>
            ${sr.region ? `<span style="color:var(--g400)">地域</span><span>${esc(sr.region)}</span>` : ''}
            <span style="color:var(--g400)">权限</span><span>${sr.permission === 'readwrite' ? '读写' : '只读'}</span>
            <span style="color:var(--g400)">策略名称</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(sr.policyName || '-')}</code></span>
            <span style="color:var(--g400)">附加用户</span><span>${sr.attached ? esc(sr.attachUsername) : `<span style="color:var(--warn,#d97706);font-weight:500">未附加（${esc(sr.message || '未找到目标云账号')}）</span>`}</span>
          </div>` : `<div style="font-size:12.5px;color:var(--danger,#dc2626)">${esc(sr.message || '')}</div>`}
      </div>`;
    }
  }

  // RDS 数据库账号结果
  const rdsResults = Array.isArray(rdsResult) ? rdsResult : [];
  if (rdsResults.length > 0) {
    html += `<div style="font-weight:600;font-size:13px;color:var(--g600);margin-bottom:8px;margin-top:4px">RDS 数据库账号授权结果</div>`;
    for (const r of rdsResults) {
      const icon  = r.success ? '✅' : '❌';
      const pname = PSHORT[r.platform] || r.platform;
      html += `<div class="card" style="padding:14px 16px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:${r.success ? 8 : 0}px">
          <span class="badge badge-info">${esc(pname)}</span>
          <span style="font-size:13px">${icon} ${r.success ? '账号开通成功' : '账号开通失败'}</span>
        </div>
        ${r.success ? `
          <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px;color:var(--g600)">
            <span style="color:var(--g400)">实例</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(r.instanceName || r.instanceId)}</code></span>
            <span style="color:var(--g400)">账号名</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(r.accountName)}</code></span>
            <span style="color:var(--g400)">权限</span><span>${r.privilege === 'ReadWrite' ? '读写' : '只读'}</span>
            <span style="color:var(--g400)">数据库</span><span>${esc((r.databases || []).join(', '))}</span>
            ${r.needsManual ? `<span style="color:var(--g400)">补充操作</span><span style="color:var(--warn,#d97706);white-space:pre-wrap;font-family:monospace">${esc(r.message)}</span>` : ''}
          </div>` : `<div style="font-size:12.5px;color:var(--danger,#dc2626)">${esc(r.message || '')}</div>`}
      </div>`;
    }
  }

  // 虚拟机创建结果
  const vmResults = Array.isArray(vmResult) ? vmResult : [];
  if (vmResults.length > 0) {
    html += `<div style="font-weight:600;font-size:13px;color:var(--g600);margin-bottom:8px;margin-top:4px">虚拟机创建结果</div>`;
    for (const vm of vmResults) {
      const icon  = vm.success ? '✅' : '❌';
      const pname = PSHORT[vm.platform] || vm.platform;
      html += `<div class="card" style="padding:14px 16px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:${vm.success ? 8 : 0}px">
          <span class="badge badge-info">${esc(pname)}</span>
          <span style="font-size:13px">${icon} ${vm.success ? '创建成功' : '创建失败'}</span>
        </div>
        ${vm.success ? `
          <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px;color:var(--g600)">
            <span style="color:var(--g400)">主机名</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(vm.hostname || vm.instanceName || vm.instanceId || '-')}</code></span>
            <span style="color:var(--g400)">实例ID</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(vm.instanceId || '-')}</code></span>
            ${(vm.privateIp || vm.ip) ? `<span style="color:var(--g400)">内网IP</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(vm.privateIp || vm.ip)}</code></span>` : ''}
            <span style="color:var(--g400)">公网IP</span><span>${vm.publicIp ? `<code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(vm.publicIp)}</code>` : '<span style="color:var(--g400)">未分配</span>'}</span>
            ${vm.region ? `<span style="color:var(--g400)">地域</span><span>${esc(vm.region)}</span>` : ''}
            ${vm.instanceType ? `<span style="color:var(--g400)">规格</span><span>${esc(vm.instanceType)}</span>` : ''}
          </div>` : `<div style="font-size:12.5px;color:var(--danger,#dc2626)">${esc(vm.message || '')}</div>`}
      </div>`;
    }
  }

  // K8s 集群权限结果（kubeconfig）
  const k8sResults = Array.isArray(k8sResult) ? k8sResult : [];
  if (k8sResults.length > 0) {
    html += `<div style="font-weight:600;font-size:13px;color:var(--g600);margin-bottom:8px;margin-top:4px">K8s 集群访问凭据（kubeconfig）</div>`;
    for (const kr of k8sResults) {
      const icon  = kr.success ? '✅' : '❌';
      const pname = PSHORT[kr.platform] || kr.platform;
      html += `<div class="card" style="padding:14px 16px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:${kr.success ? 8 : 0}px">
          <span class="badge badge-info">${esc(pname)}</span>
          <span style="font-size:13px">${icon} ${kr.success ? 'kubeconfig 已生成' : '生成失败'}</span>
        </div>
        ${kr.success ? `
          <div style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12.5px;color:var(--g600);margin-bottom:10px">
            <span style="color:var(--g400)">集群</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(kr.cluster_name || kr.cluster_id || '-')}</code></span>
            <span style="color:var(--g400)">Namespace</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(kr.namespace || '-')}</code></span>
            <span style="color:var(--g400)">权限</span><span>${esc(kr.clusterRole || kr.permission || '-')}</span>
            <span style="color:var(--g400)">ServiceAccount</span><span><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(kr.saName || '-')}</code></span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="font-size:12px;color:var(--g500)">将以下内容保存为 kubeconfig.yaml 使用</span>
            <button class="btn-ghost btn-xs" onclick='copyText(${JSON.stringify(kr.kubeconfig || "")})'>复制</button>
          </div>
          <pre style="background:#1a1a2e;color:#a0f0a0;padding:12px;border-radius:6px;font-size:11px;overflow:auto;max-height:260px;white-space:pre-wrap;word-break:break-all;margin:0">${esc(kr.kubeconfig || '')}</pre>`
        : `<div style="font-size:12.5px;color:var(--danger,#dc2626)">${esc(kr.message || '')}</div>`}
      </div>`;
    }
  }

  // 数据库实例创建结果
  const dbInstResults = Array.isArray(dbInstResult) ? dbInstResult : [];
  if (dbInstResults.length > 0) {
    const ENGINE_LBL = { mysql: 'MySQL', postgres: 'PostgreSQL', redis: 'Redis' };
    html += `<div style="font-weight:600;font-size:13px;color:var(--g600);margin-bottom:8px;margin-top:4px">数据库实例创建</div>`;
    for (const dr of dbInstResults) {
      const icon  = dr.success ? '✅' : '❌';
      const pname = PSHORT[dr.platform] || dr.platform;
      html += `<div class="card" style="padding:14px 16px;margin-bottom:10px">
        <div style="display:flex;align-items:center;gap:10px">
          <span class="badge badge-info">${esc(pname)}</span>
          <span class="badge badge-gray">${esc(ENGINE_LBL[dr.engineKind] || dr.engineKind || '-')}</span>
          <span style="font-size:13px">${icon} ${dr.success ? '实例创建已提交' : '创建失败'}</span>
        </div>
        ${dr.success
          ? `<div style="font-size:12.5px;color:var(--g600);margin-top:8px">实例 ID：<code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(dr.instanceId || '-')}</code>　<span style="color:var(--g400)">${esc(dr.message || '创建为异步操作，稍后同步实例查看状态')}</span></div>`
          : `<div style="font-size:12.5px;color:var(--danger,#dc2626);margin-top:6px">${esc(dr.message || '')}</div>`}
      </div>`;
    }
  }

  if (!cloudResults.length && !vpnResults.length && !bucketResults.length && !storageResults.length && !rdsResults.length && !vmResults.length && !k8sResults.length && !dbInstResults.length) {
    html += `<div style="text-align:center;padding:24px;color:var(--g400);font-size:13px">暂无详细创建记录</div>`;
  }

  document.getElementById('tr-body').innerHTML = html;
  document.getElementById('modal-ticket-result').classList.remove('hidden');
}

// ── 管理员：分配权限并批准弹窗 ─────────────────────────────

async function openApproveModal(ticketId) {
  let ticket = _ticketsCache[ticketId];
  if (!ticket) { toast('工单数据未加载，请刷新后重试', 'err'); return; }
  // 从后端拉最新工单（拿到最新 approve_config，避免用列表缓存的旧数据导致回填为空）
  try {
    const r = await get(`/feishu/tickets/${ticketId}`);
    if (r.ok && r.data && r.data.ticket) {
      ticket = r.data.ticket;
      _ticketsCache[ticketId] = ticket;
    }
  } catch (e) { /* 拉取失败则退回缓存 */ }
  taCurrentTicket = ticket;

  document.getElementById('modal-ticket-approve').classList.remove('hidden');
  document.getElementById('ta-body').innerHTML = '<div style="text-align:center;padding:30px;color:var(--g400)">加载中...</div>';
  document.getElementById('ta-err').textContent = '';

  Object.keys(taCheckedPolicies).forEach(k => delete taCheckedPolicies[k]);
  Object.keys(taPolicyState).forEach(k => delete taPolicyState[k]);

  const draft = (() => { try { return JSON.parse(ticket.account_draft); } catch { return {}; } })();

  // ── 密码重置工单：显示专属确认界面 ──────────────────────
  if (draft.ticket_type === 'password_reset') {
    const { reset_target, reason, real_name, cloud_username } = draft;
    const targetTypeLabel = { cloud: '云账号', vpn: 'VPN 账号', system: '平台工具' };
    const PNAMES = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云', jumpserver: 'JumpServer', bytebase: 'Bytebase', kuboard: 'Kuboard', 'grafana-aws': 'Grafana (AWS)', 'grafana-wuwen': 'Grafana (无问)', 'grafana-baidu': 'Grafana (百度)' };
    let targetDesc = '';
    if (reset_target.type === 'cloud') {
      targetDesc = `${PNAMES[reset_target.platform] || reset_target.platform} — 账号：${reset_target.account}`;
    } else if (reset_target.type === 'vpn') {
      targetDesc = `${PNAMES[reset_target.platform] || reset_target.platform} — VPN 客户端 ID：${reset_target.client}`;
    } else if (reset_target.type === 'system') {
      targetDesc = PNAMES[reset_target.tool] || reset_target.tool;
    }

    const html = `
      <div style="background:var(--g50);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;display:flex;flex-wrap:wrap;gap:8px 20px">
        <span><strong>申请人：</strong>${esc(real_name || ticket.submitter_name)}</span>
        <span><strong>账号名称：</strong><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(cloud_username || '-')}</code></span>
        <span><strong>申请时间：</strong>${ticket.created_at?.slice(0,16) || '-'}</span>
      </div>
      <div style="background:#fff8e1;border:1px solid #ffd54f;border-radius:8px;padding:16px;margin-bottom:16px">
        <div style="font-size:13px;font-weight:700;color:#e65100;margin-bottom:10px">🔐 密码重置申请</div>
        <div style="display:flex;flex-direction:column;gap:8px;font-size:13px">
          <div><span style="color:var(--g500);width:80px;display:inline-block">账号类型</span><strong>${targetTypeLabel[reset_target.type] || reset_target.type}</strong></div>
          <div><span style="color:var(--g500);width:80px;display:inline-block">重置目标</span><strong>${esc(targetDesc)}</strong></div>
          <div><span style="color:var(--g500);width:80px;display:inline-block">重置原因</span>${esc(reason || '-')}</div>
        </div>
      </div>
      <div style="background:#e8f5e9;border:1px solid #a5d6a7;border-radius:8px;padding:12px 16px;font-size:13px;color:#2e7d32">
        ✓ 审批通过后将自动重置密码，并通过飞书私信将新密码发送给申请人。
      </div>`;
    document.getElementById('ta-body').innerHTML = html;
    // 隐藏审批弹窗中的"启用控制台"等无关选项，直接显示确认按钮
    const approveBtn = document.querySelector('#modal-ticket-approve .btn-primary');
    if (approveBtn) approveBtn.textContent = '确认重置密码';
    return;
  }

  // ── 原有账号申请工单 ─────────────────────────────────────
  // 兼容新格式 (cloud_platforms) 和旧格式 (cloud_accounts)
  const platforms = draft.cloud_platforms || (draft.cloud_accounts || []).map(ca => ca.platform);
  const vpnReqs   = draft.vpn_requests || [];

  const [polR, grpR, credR] = await Promise.all([
    get('/cloud/policies'),
    get('/sync/groups'),
    get('/cloud/credentials'),
  ]);

  taPolicies   = polR.ok  ? (polR.data.policies      || {}) : {};
  taGroupsData = {};
  if (grpR.ok) {
    for (const g of grpR.data.groups || []) {
      if (!taGroupsData[g.platform]) taGroupsData[g.platform] = [];
      taGroupsData[g.platform].push(g);
    }
  }
  const credStatus = {};
  if (credR.ok) credR.data.credentials.forEach(c => { credStatus[c.platform] = true; });

  const PSHORT     = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云', bytebase: 'Bytebase', jumpserver: 'JS', kuboard: 'KB', 'grafana-aws': 'GF', 'grafana-wuwen': 'GF', 'grafana-baidu': 'GF' };
  const PLONG      = { aws: 'Amazon Web Services', aliyun: '阿里云', baidu: '百度智能云', bytebase: 'Bytebase', jumpserver: 'JumpServer', kuboard: 'Kuboard', 'grafana-aws': 'Grafana (AWS)', 'grafana-wuwen': 'Grafana (无问)', 'grafana-baidu': 'Grafana (百度)' };
  const LOGO_CLASS = { aws: 'aws-bg', aliyun: 'ali-bg', baidu: 'bai-bg', bytebase: 'bb-bg' };
  const LOGO_STYLE = { jumpserver: 'background:#e65c00;color:#fff', kuboard: 'background:#0052cc;color:#fff', 'grafana-aws': 'background:#ff6f00;color:#fff', 'grafana-wuwen': 'background:#2e7d32;color:#fff', 'grafana-baidu': 'background:#1565c0;color:#fff' };

  let html = `<div style="background:var(--g50);border-radius:8px;padding:12px 16px;margin-bottom:16px;font-size:13px;display:flex;flex-wrap:wrap;gap:8px 20px">
    <span><strong>申请人：</strong>${esc(draft.real_name || ticket.submitter_name)}</span>
    <span><strong>账号名称：</strong><code style="background:var(--g100);padding:1px 6px;border-radius:4px">${esc(draft.cloud_username || '-')}</code></span>
    <span><strong>申请时间：</strong>${ticket.created_at?.slice(0,16) || '-'}</span>
    ${draft.notes ? `<span><strong>备注：</strong>${esc(draft.notes)}</span>` : ''}
  </div>`;

  if (platforms.length > 0) {
    html += `<div style="font-size:13px;font-weight:600;color:var(--g600);margin-bottom:12px">为以下平台分配权限（不选则创建无权限账号）</div>`;
    for (const p of platforms) {
      // JumpServer / Bytebase / Kuboard / Grafana 无策略，直接显示说明面板
      if (p === 'jumpserver' || p === 'bytebase' || p === 'kuboard' || p.startsWith('grafana-')) {
        const desc = p === 'jumpserver'
          ? '创建后为普通用户，在 JumpServer 控制台分配资产权限'
          : p === 'kuboard'
          ? '创建后为普通用户，在 Kuboard 控制台分配集群权限'
          : p.startsWith('grafana-')
          ? '创建后为 Viewer 角色，在 Grafana 控制台分配仪表盘权限'
          : '创建后分配 workspace.projectDeveloper 角色';
        html += `<div class="policy-panel" data-plat="${p}" style="margin-bottom:16px">
          <div class="policy-panel-header">
            <div class="panel-logo ${LOGO_CLASS[p] || ''}" ${LOGO_STYLE[p] ? `style="${LOGO_STYLE[p]}"` : ''}>${PSHORT[p]}</div>
            <div>
              <div style="font-size:15px;font-weight:700">${PLONG[p]}</div>
              <div style="font-size:12px;color:var(--g400)">${desc}</div>
            </div>
            ${!credStatus[p] && p !== 'kuboard' && !p.startsWith('grafana-') ? `<div style="margin-left:auto;font-size:12px;color:var(--warn);font-weight:600">⚠ 未配置主账号凭据</div>` : ''}
          </div>
        </div>`;
        continue;
      }

      taCheckedPolicies[p] = new Set();
      taPolicyState[p] = { items: (taPolicies[p] || []).map(pol => ({...pol})), page: 1, pageSize: 10, query: '' };
      const groups = taGroupsData[p] || [];
      html += `<div class="policy-panel" data-plat="${p}" style="margin-bottom:16px">
        <div class="policy-panel-header">
          <div class="panel-logo ${LOGO_CLASS[p]}">${PSHORT[p]}</div>
          <div>
            <div style="font-size:15px;font-weight:700">${PLONG[p]}</div>
            <div style="font-size:12px;color:var(--g400)">选择权限策略和用户组</div>
          </div>
          ${!credStatus[p] ? `<div style="margin-left:auto;font-size:12px;color:var(--warn);font-weight:600">⚠ 未配置主账号凭据</div>` : ''}
        </div>
        <div class="policy-body">
          <div class="policy-left">
            <input type="text" class="policy-search" placeholder="搜索策略名称..."
              oninput="_taFilterPolicies('${p}',this.value)">
            <div class="policy-grid" id="ta-pol-grid-${p}"></div>
            <div id="ta-pol-pager-${p}" class="policy-pager"></div>
          </div>
          <div class="policy-right">${_taGroupSection(p, groups)}</div>
        </div>
        <div class="console-toggle-row">
          <label class="console-toggle-label">
            <input type="checkbox" id="ta-console-${p}">
            <div><strong>启用控制台登录</strong><span>允许使用自动生成密码登录 ${PSHORT[p]} 控制台</span></div>
          </label>
        </div>
      </div>`;
    }
  }

  taCurrentVpnReqs = vpnReqs;

  if (vpnReqs.length > 0) {
    const initialPwd = draft.initial_password || '（申请时未填写，系统将自动生成）';
    html += `<div style="font-weight:600;margin-bottom:8px;font-size:13px;color:var(--g600)">VPN 申请（管理员选择服务器后创建）</div>
      <div style="background:#e3f2fd;border:1px solid #90caf9;border-radius:6px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#1565c0">
        <strong>💡 VPN 密码：</strong>将使用申请人填写的初始密码 <code style="background:#fff;padding:1px 6px;border-radius:3px;font-family:monospace;color:#0d47a1">${esc(initialPwd)}</code>
      </div>
      <div class="card" style="padding:16px;margin-bottom:16px;display:flex;flex-direction:column;gap:14px">
        ${vpnReqs.map((vr, i) => `
          <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end">
            <div style="display:flex;align-items:center;min-width:64px">
              <span class="badge badge-info">${PSHORT[vr.platform] || vr.platform}</span>
            </div>
            <div class="field" style="flex:2;min-width:160px;margin:0">
              <label style="font-size:12px;margin-bottom:4px;display:block">VPN 服务器 <span class="req">*</span></label>
              <select id="ta-vpn-server-${i}" data-platform="${vr.platform}" style="width:100%">
                <option value="">加载中...</option>
              </select>
            </div>
            <div class="field" style="flex:2;min-width:140px;margin:0">
              <label style="font-size:12px;margin-bottom:4px;display:block">客户端名称 <span class="req">*</span></label>
              <input type="text" id="ta-vpn-client-${i}" placeholder="如：${esc(draft.cloud_username || 'zhangsan')}-mac" value="${esc(draft.cloud_username || '')}">
            </div>
          </div>`).join('')}
      </div>`;
  }

  const otherReqs = draft.other_requests || [];
  // 分离：存储创建（可操作）、存储授权（可操作）、其他（只读展示）
  // 兼容旧工单：没有 action 字段的存储请求视为授权
  const storageCreateReqs = otherReqs.filter(r => ['s3','oss','bos'].includes(r.type) && r.action === 'create');
  const storageAuthReqs   = otherReqs.filter(r => ['s3','oss','bos'].includes(r.type) && r.action !== 'create');
  const rdsReqs           = otherReqs.filter(r => r.type === 'rds');
  const otherReadonlyReqs = otherReqs.filter(r => !(['s3','oss','bos','rds'].includes(r.type)));

  _taBucketReqs = storageCreateReqs;
  _taStorageAuthReqs = storageAuthReqs;
  _taRdsReqs = rdsReqs;

  if (storageCreateReqs.length > 0) {
    const TYPE_LABEL = { s3:'S3 存储桶', oss:'OSS 存储桶', bos:'BOS 存储桶' };
    html += `<div style="font-weight:600;margin-bottom:10px;font-size:13px;color:var(--g600)">对象存储创建（审批通过后自动创建）</div>`;
    storageCreateReqs.forEach((r, i) => {
      const pname   = PSHORT[r.platform] || r.platform;
      const tname   = TYPE_LABEL[r.type] || r.type;
      html += `<div class="card" style="padding:14px 16px;margin-bottom:10px" id="ta-bk-card-${i}">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <span class="badge badge-info">${esc(pname)}</span>
          <span style="font-size:13px;font-weight:600;color:var(--g700)">${esc(tname)}</span>
          <code style="background:var(--g100);padding:2px 8px;border-radius:4px;font-size:12px">${esc(r.bucket || '-')}</code>
          ${r.region ? `<span style="font-size:11px;color:var(--g500)">地域：${esc(r.region)}</span>` : ''}
          ${r.description ? `<span style="font-size:12px;color:var(--g500)">${esc(r.description)}</span>` : ''}
        </div>
      </div>`;
    });
  }

  if (storageAuthReqs.length > 0) {
    const TYPE_LABEL = { s3:'S3 存储桶', oss:'OSS 存储桶', bos:'BOS 存储桶' };
    html += `<div style="font-weight:600;margin-bottom:10px;font-size:13px;color:var(--g600)${storageCreateReqs.length > 0 ? ';margin-top:4px' : ''}">存储桶授权（审批通过后自动创建策略并附加到云用户）</div>`;
    storageAuthReqs.forEach((r, i) => {
      const pname = PSHORT[r.platform] || r.platform;
      const tname = TYPE_LABEL[r.type] || r.type;
      const permRead = r.permission === 'readwrite' ? '' : 'checked';
      const permRW   = r.permission === 'readwrite' ? 'checked' : '';
      html += `<div class="card" style="padding:14px 16px;margin-bottom:10px" id="ta-sa-card-${i}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <span class="badge badge-info">${esc(pname)}</span>
          <span style="font-size:13px;font-weight:600;color:var(--g700)">${esc(tname)} 授权</span>
          ${r.region ? `<span style="font-size:11px;color:var(--g500)">地域：${esc(r.region)}</span>` : ''}
          ${r.description ? `<span style="font-size:12px;color:var(--g500)">${esc(r.description)}</span>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div>
            <div style="font-size:12px;color:var(--g500);margin-bottom:4px">Bucket 名称 <span style="color:var(--danger)">*</span></div>
            <input type="text" id="ta-sa-bucket-${i}" value="${esc(r.bucket || '')}" placeholder="bucket-name" style="width:100%;box-sizing:border-box">
          </div>
          <div>
            <div style="font-size:12px;color:var(--g500);margin-bottom:4px">策略名称（留空自动生成）</div>
            <input type="text" id="ta-sa-policy-${i}" placeholder="如：policy-bucket-readonly" style="width:100%;box-sizing:border-box">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div>
            <div style="font-size:12px;color:var(--g500);margin-bottom:4px">云账号名</div>
            <div style="font-size:13px;padding:4px 0;color:var(--g700)">${esc(r.cloudUsername || r.userId || '(未指定)')}</div>
          </div>
          <div>
            <div style="font-size:12px;color:var(--g500);margin-bottom:4px">权限</div>
            <label style="font-size:13px;cursor:pointer;margin-right:16px">
              <input type="radio" name="ta-sa-perm-${i}" value="read" ${permRead}> 只读
            </label>
            <label style="font-size:13px;cursor:pointer">
              <input type="radio" name="ta-sa-perm-${i}" value="readwrite" ${permRW}> 读写
            </label>
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
          <div>
            <div style="font-size:12px;color:var(--g500);margin-bottom:4px">路径前缀（默认全部）</div>
            <input type="text" id="ta-sa-path-${i}" value="${esc(r.path || '')}" placeholder="*" style="width:100%;box-sizing:border-box">
          </div>
        </div>
      </div>`;
    });
  }

  // ── RDS 数据库账号请求 ──
  if (rdsReqs.length > 0) {
    const PSHORT = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
    html += `<div style="font-weight:600;margin-bottom:10px;font-size:13px;color:var(--g600)${storageCreateReqs.length > 0 || storageAuthReqs.length > 0 ? ';margin-top:4px' : ''}">RDS 数据库账号（审批通过后自动创建并授权）</div>`;
    rdsReqs.forEach((r, i) => {
      const pname = PSHORT[r.platform] || r.platform;
      const permRead = r.privilege === 'ReadWrite' ? '' : 'checked';
      const permRW   = r.privilege === 'ReadWrite' ? 'checked' : '';
      const dbsStr   = (r.databases || []).join(', ');
      html += `<div class="card" style="padding:14px 16px;margin-bottom:10px" id="ta-rds-card-${i}">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;flex-wrap:wrap">
          <span class="badge badge-info">${esc(pname)}</span>
          <span style="font-size:13px;font-weight:600;color:var(--g700)">RDS 数据库账号</span>
          ${r.description ? `<span style="font-size:12px;color:var(--g500)">${esc(r.description)}</span>` : ''}
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div>
            <div style="font-size:12px;color:var(--g500);margin-bottom:4px">RDS 实例</div>
            <div style="font-size:13px;padding:4px 0;color:var(--g700)">${esc(r.instanceName || r.instanceId)}</div>
            <input type="hidden" id="ta-rds-instid-${i}" value="${esc(r.instanceId || '')}">
            <input type="hidden" id="ta-rds-instname-${i}" value="${esc(r.instanceName || '')}">
          </div>
          <div>
            <div style="font-size:12px;color:var(--g500);margin-bottom:4px">账号名称 <span style="color:var(--danger)">*</span></div>
            <input type="text" id="ta-rds-account-${i}" value="${esc(r.accountName || '')}" style="width:100%;box-sizing:border-box">
          </div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
          <div>
            <div style="font-size:12px;color:var(--g500);margin-bottom:4px">数据库名称 <span style="color:var(--danger)">*</span></div>
            <input type="text" id="ta-rds-dbs-${i}" value="${esc(dbsStr)}" placeholder="逗号分隔多个数据库" style="width:100%;box-sizing:border-box">
          </div>
          <div>
            <div style="font-size:12px;color:var(--g500);margin-bottom:4px">密码 <span style="color:var(--danger)">*</span></div>
            <input type="password" id="ta-rds-pwd-${i}" placeholder="设置数据库账号密码" style="width:100%;box-sizing:border-box">
          </div>
        </div>
        <div>
          <div style="font-size:12px;color:var(--g500);margin-bottom:4px">权限</div>
          <label style="font-size:13px;cursor:pointer;margin-right:16px">
            <input type="radio" name="ta-rds-perm-${i}" value="ReadOnly" ${permRead}> 只读
          </label>
          <label style="font-size:13px;cursor:pointer">
            <input type="radio" name="ta-rds-perm-${i}" value="ReadWrite" ${permRW}> 读写
          </label>
        </div>
      </div>`;
    });
  }

  if (otherReadonlyReqs.length > 0) {
    const vmReqs = otherReadonlyReqs.filter(r => ['ec2','ecs','bcc'].includes(r.type));
    const nonVmReqs = otherReadonlyReqs.filter(r => !['ec2','ecs','bcc'].includes(r.type));

    if (vmReqs.length > 0) {
      const TYPE_LABEL_VM = { ec2:'云主机 (EC2)', ecs:'云主机 (ECS)', bcc:'云主机 (BCC)' };
      html += `<div style="font-weight:600;margin-bottom:8px;font-size:13px;color:var(--g600)">云主机申请（审批后自动创建）</div>`;

      vmReqs.forEach((r, idx) => {
        const pname = PSHORT[r.platform] || r.platform;
        html += `
          <div class="card" style="padding:16px;margin-bottom:12px">
            <div style="margin-bottom:12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
              <span class="badge badge-info">${esc(pname)}</span>
              <span style="font-size:13px;color:var(--g600)"><strong>主机名：</strong>${esc(r.instance_name || '-')}</span>
              <span style="font-size:13px;color:var(--g600)"><strong>地域：</strong>${esc(r.region || '-')}</span>
              <span style="font-size:13px;color:var(--g600)"><strong>规格：</strong><code style="font-size:11.5px;background:var(--g100);padding:1px 6px;border-radius:3px">${esc(r.instance_type || '-')}</code></span>
              <span style="font-size:13px;color:var(--g600)"><strong>数量：</strong>${r.count || 1}</span>
              <span style="font-size:13px;color:var(--g600)"><strong>公网 IP：</strong>${r.public_ip ? '<span style="color:#c2410c">申请人要求分配</span>' : '否'}</span>
              <span style="font-size:13px;color:var(--g600)"><strong>磁盘：</strong>系统盘 ${r.system_disk_size || 40}G${(r.data_disk_size || 0) > 0 ? ` + 数据盘 ${r.data_disk_size}G` : '（无数据盘）'}</span>
            </div>
            ${r.description ? `<div style="margin-bottom:12px;padding:8px 12px;background:var(--g50);border-radius:4px;font-size:12px;color:var(--g600)">
              <strong style="color:var(--g700)">用途说明：</strong>${esc(r.description)}
            </div>` : ''}
            <div class="form-row" style="gap:16px;margin-bottom:10px">
              <div class="field" style="flex:1;margin:0">
                <label style="font-size:12px">VPC <span class="req">*</span></label>
                <select id="ta-vm-vpc-${idx}" data-platform="${r.platform}" data-region="${r.region}" style="width:100%;font-size:12px" onchange="taVpcChanged(${idx})">
                  <option value="">加载中...</option>
                </select>
              </div>
            </div>
            <div class="form-row" style="gap:16px;margin-bottom:10px">
              <div class="field" style="flex:1;margin:0">
                <label style="font-size:12px">子网 <span class="req">*</span></label>
                <select id="ta-vm-subnet-${idx}" style="width:100%;font-size:12px" disabled>
                  <option value="">请先选择 VPC</option>
                </select>
              </div>
              <div class="field" style="flex:1;margin:0">
                <label style="font-size:12px">安全组 <span class="req">*</span></label>
                <input type="text" id="ta-vm-sg-search-${idx}" placeholder="输入关键词搜索..." style="width:100%;font-size:12px;margin-bottom:4px" oninput="taFilterSecurityGroups(${idx})" disabled>
                <select id="ta-vm-sg-${idx}" style="width:100%;font-size:12px" disabled>
                  <option value="">请先选择 VPC</option>
                </select>
              </div>
            </div>
            <div class="form-row" style="gap:16px;margin-top:10px">
              <div class="field" style="flex:1;margin:0">
                <label style="font-size:12px">系统盘 (GB) <span class="req">*</span></label>
                <input type="number" id="ta-vm-sysdisk-${idx}" value="${r.system_disk_size || 40}" min="20" max="500" style="width:100%;font-size:12px">
              </div>
              <div class="field" style="flex:1;margin:0">
                <label style="font-size:12px">数据盘 (GB)</label>
                <input type="number" id="ta-vm-datadisk-${idx}" value="${r.data_disk_size || 0}" min="0" max="2000" style="width:100%;font-size:12px">
              </div>
            </div>
            <div style="margin-top:10px">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
                <input type="checkbox" id="ta-vm-pubip-${idx}" ${r.public_ip ? 'checked' : ''}>
                <span>分配公网 IP${r.public_ip ? '（申请人已勾选）' : '（申请人未勾选，如需可手动开启）'}</span>
              </label>
            </div>
            <div style="margin-top:10px">
              <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px">
                <input type="checkbox" id="ta-vm-jumpserver-${idx}" checked onchange="taJmsToggle(${idx})">
                <span>创建后添加到 JumpServer 并授权给申请人</span>
              </label>
              <div style="margin-top:6px;padding-left:24px">
                <label style="font-size:12px;color:var(--g500)">资产树节点(组)</label>
                <select id="ta-vm-jms-node-${idx}" style="width:100%;font-size:12px;margin-top:2px">
                  <option value="">默认（不指定）</option>
                </select>
              </div>
              <div style="margin-top:8px;padding-left:24px">
                <label style="font-size:12px;color:var(--g500)">系统账号模版（建资产时自动在主机上创建账号）</label>
                <select id="ta-vm-jms-account-${idx}" multiple size="3" style="width:100%;font-size:12px;margin-top:2px">
                  <option value="">加载中...</option>
                </select>
                <div style="font-size:11px;color:var(--g400);margin-top:2px">按住 Ctrl/Cmd 多选。套用模版后 JumpServer 会自动在主机上建对应账号并授权；不选则授权资产下全部账号(@ALL)。</div>
              </div>
              <div style="margin-top:8px;padding-left:24px">
                <label style="font-size:12px;color:var(--g500)">授权给用户（多选，默认申请人）</label>
                <input type="text" id="ta-vm-jms-user-search-${idx}" placeholder="🔍 搜索用户名..." style="width:100%;font-size:12px;margin-top:2px" oninput="_taFilterJmsUsers(${idx})">
                <div id="ta-vm-jms-users-${idx}" style="max-height:120px;overflow:auto;border:1px solid var(--g200);border-radius:6px;padding:6px 8px;margin-top:4px">
                  <div style="color:var(--g400);font-size:12px">加载中...</div>
                </div>
              </div>
            </div>
          </div>`;
      });
    }

    if (nonVmReqs.length > 0) {
    const TYPE_LABEL = { s3:'S3 存储桶', oss:'OSS 存储桶', bos:'BOS 存储桶', ec2:'云主机 (EC2)', ecs:'云主机 (ECS)', bcc:'云主机 (BCC)', registry:'镜像仓库', k8s:'集群权限', dns:'域名解析', 'case':'工单权限', other:'其他资源' };
    const ACTION_LABEL = { create:'创建', authorize:'授权访问' };
    html += `<div style="font-weight:600;margin-bottom:8px;font-size:13px;color:var(--g600)">其他资源申请（仅供参考，管理员手动处理）</div>
      <div class="card" style="padding:0;margin-bottom:16px;overflow:hidden">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:var(--g50)">
            <th style="padding:9px 14px;text-align:left;font-weight:600;color:var(--g500);font-size:11.5px;border-bottom:1px solid var(--border)">平台</th>
            <th style="padding:9px 14px;text-align:left;font-weight:600;color:var(--g500);font-size:11.5px;border-bottom:1px solid var(--border)">类型</th>
            <th style="padding:9px 14px;text-align:left;font-weight:600;color:var(--g500);font-size:11.5px;border-bottom:1px solid var(--border)">操作</th>
            <th style="padding:9px 14px;text-align:left;font-weight:600;color:var(--g500);font-size:11.5px;border-bottom:1px solid var(--border)">详情</th>
          </tr></thead>
          <tbody>${nonVmReqs.map(r => {
            const pname  = PSHORT[r.platform] || r.platform || '-';
            const tname  = TYPE_LABEL[r.type] || r.type || r.name || '-';
            const action = ACTION_LABEL[r.action] || r.action || '-';
            let detail = '';
            if (r.type === 'k8s') {
              detail = `业务组：<strong>${esc(r.group_name || '-')}</strong>　集群：<strong>${esc(r.cluster_name || '-')}</strong>　Namespace：<strong>${esc((r.namespaces || []).join(', '))}</strong>　权限：<strong>${esc(r.permission || '-')}</strong>`;
              if (r.description) detail += `　备注：${esc(r.description)}`;
            } else {
              if (r.bucket) detail += `Bucket：<strong>${esc(r.bucket)}</strong>`;
              if (r.permission) detail += `　权限：<strong>${r.permission === 'readwrite' ? '读写' : '只读'}</strong>`;
              if (r.path)   detail += `　路径：${esc(r.path)}`;
              if (r.description) detail += (detail ? `　备注：` : ``) + esc(r.description);
              if (!detail && r.name) detail = esc(r.name);
            }
            return `<tr style="border-bottom:1px solid var(--border)">
              <td style="padding:10px 14px"><span class="badge badge-info">${esc(pname)}</span></td>
              <td style="padding:10px 14px;color:var(--g700)">${esc(tname)}</td>
              <td style="padding:10px 14px"><span class="badge badge-gray">${esc(action)}</span></td>
              <td style="padding:10px 14px;color:var(--g600)">${detail || '-'}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>`;
    }
  }

  document.getElementById('ta-body').innerHTML = html;
  platforms.forEach(p => _taRenderPolicyGrid(p));
  // 异步加载 VPN 服务器列表
  vpnReqs.forEach((vr, i) => _taLoadVpnServers(vr.platform, `ta-vpn-server-${i}`));
  // 回填上次填写的 VM 配置：优先审批配置草稿 approve_config（填了就存，不依赖开通），
  // 没有再回退到 vm_result（开通后结果）
  const savedVmConfigs = {};
  let _approveCfg = null;
  try { _approveCfg = ticket.approve_config ? JSON.parse(ticket.approve_config) : null; } catch {}
  if (_approveCfg && Array.isArray(_approveCfg.vm_configs)) {
    // approve_config 的 vm_configs 用 index 键
    _approveCfg.vm_configs.forEach(v => {
      if (v && typeof v.index === 'number') savedVmConfigs[v.index] = { ...v, idx: v.index };
    });
  } else {
    try {
      const prevVm = JSON.parse(ticket.vm_result);
      if (Array.isArray(prevVm)) {
        prevVm.forEach(v => { if (v && typeof v.idx === 'number' && v.vpcId) savedVmConfigs[v.idx] = v; });
      }
    } catch {}
  }
  const vmReqsForSg = (draft.other_requests || []).filter(r => ['ec2','ecs','bcc'].includes(r.type));
  vmReqsForSg.forEach((r, idx) => {
    const saved = savedVmConfigs[idx];
    // 恢复 JumpServer 勾选状态
    if (saved && saved.addToJumpserver === false) {
      const jsEl = document.getElementById(`ta-vm-jumpserver-${idx}`);
      if (jsEl) jsEl.checked = false;
    }
    _taLoadVpcs(r.platform, r.region, idx, saved);
    // 加载 JumpServer 资产树节点（回填上次选择）+ 联动禁用
    _taLoadJmsNodes(idx, saved && saved.jumpserverNodeId);
    // 加载授权用户多选（回填上次选择，无则默认申请人）
    _taLoadJmsUsers(idx, saved && saved.jumpserverUserIds, draft.cloud_username || ticket.submitter_name);
    // 加载账号模版多选（回填上次选择的模版 id，无则按平台默认用户名匹配）
    _taLoadJmsAccountTemplates(idx, saved && saved.jumpserverAccountTemplateIds, r.platform === 'aws' ? 'ec2-user' : 'root');
    taJmsToggle(idx);
  });

  const btn = document.getElementById('ta-btn-submit');
  btn.disabled = false; btn.textContent = '确认授权';

  // 挂载配置变更自动保存监听（委托，只挂一次）；延迟置 ready，避开加载阶段的程序化赋值
  const modalEl = document.getElementById('modal-ticket-approve');
  if (modalEl && !modalEl._autoSaveBound) {
    modalEl.addEventListener('change', taAutoSaveConfig);
    modalEl.addEventListener('input', taAutoSaveConfig);
    modalEl._autoSaveBound = true;
  }
  _taAutoSaveReady = false;
  setTimeout(() => { _taAutoSaveReady = true; }, 1500);
}

function closeApproveModal() {
  document.getElementById('modal-ticket-approve').classList.add('hidden');
  document.getElementById('ta-reject-panel')?.classList.add('hidden');
  const row = document.getElementById('ta-action-row');
  if (row) row.style.display = '';
  taCurrentTicket  = null;
  taCurrentVpnReqs = [];
  _taBucketReqs    = [];
  _taStorageAuthReqs = [];
  _taRdsReqs       = [];
  _taAutoSaveReady = false;
}

// ── 审批配置自动保存（填了就存，避免飞书同意/中途关闭丢失） ──
let _taAutoSaveReady = false;   // 弹窗初始化完成后才允许自动保存，避免加载阶段误存
let _taAutoSaveTimer = null;

// 无校验地收集当前审批配置（与提交时结构一致，用于草稿保存）
function _taCollectConfig() {
  if (!taCurrentTicket) return null;
  let draft = {};
  try { draft = JSON.parse(taCurrentTicket.account_draft || '{}'); } catch {}
  const platforms = draft.cloud_platforms || (draft.cloud_accounts || []).map(ca => ca.platform);
  const cloud_accounts = platforms.map(p => ({
    platform: p,
    policies: [...(taCheckedPolicies[p] || new Set())],
    groups:   [...document.querySelectorAll(`input[name="ta-group-${p}"]:checked`)].map(el => el.value),
    enable_console: document.getElementById(`ta-console-${p}`)?.checked || false,
    ...(p === 'bytebase' ? { bytebaseInstanceId: draft.bytebase_instance_id || '' } : {}),
  }));
  const vpn_configs = (taCurrentVpnReqs || []).map((vr, i) => {
    const sel = document.getElementById(`ta-vpn-server-${i}`);
    return {
      platform: vr.platform,
      serverId: sel?.value || '',
      serverName: sel?.options[sel.selectedIndex]?.dataset.name || '',
      clientName: (document.getElementById(`ta-vpn-client-${i}`)?.value || '').trim(),
    };
  });
  const bucket_creates = (_taBucketReqs || []).map(r => ({
    platform: r.platform, type: r.type, bucket: r.bucket, region: r.region || '', description: r.description || '',
  }));
  const storage_grants = (_taStorageAuthReqs || []).map((r, i) => ({
    platform: r.platform, type: r.type,
    bucket: (document.getElementById(`ta-sa-bucket-${i}`)?.value || '').trim(),
    region: r.region || '',
    permission: document.querySelector(`input[name="ta-sa-perm-${i}"]:checked`)?.value || 'read',
    path: (document.getElementById(`ta-sa-path-${i}`)?.value || '').trim() || '*',
    cloudUsername: r.cloudUsername || r.userId,
  }));
  const rds_accounts = (_taRdsReqs || []).map((r, i) => ({
    platform: r.platform,
    instanceId: document.getElementById(`ta-rds-instid-${i}`)?.value || r.instanceId,
    instanceName: document.getElementById(`ta-rds-instname-${i}`)?.value || r.instanceName,
    accountName: (document.getElementById(`ta-rds-account-${i}`)?.value || '').trim(),
    password: (document.getElementById(`ta-rds-pwd-${i}`)?.value || '').trim(),
    privilege: document.querySelector(`input[name="ta-rds-perm-${i}"]:checked`)?.value || 'ReadOnly',
    databases: (document.getElementById(`ta-rds-dbs-${i}`)?.value || '').trim().split(/[,，\s]+/).filter(Boolean),
  }));
  const vmReqs = (draft.other_requests || []).filter(r => ['ec2','ecs','bcc'].includes(r.type));
  const vm_configs = vmReqs.map((r, idx) => ({
    index: idx, platform: r.platform,
    vpcId: document.getElementById(`ta-vm-vpc-${idx}`)?.value || '',
    subnetId: document.getElementById(`ta-vm-subnet-${idx}`)?.value || '',
    securityGroupId: document.getElementById(`ta-vm-sg-${idx}`)?.value || '',
    addToJumpserver: document.getElementById(`ta-vm-jumpserver-${idx}`)?.checked ?? true,
    jumpserverNodeId: document.getElementById(`ta-vm-jms-node-${idx}`)?.value || '',
    jumpserverUserIds: _taGetJmsUserIds(idx),
    jumpserverAccountTemplateIds: _taGetJmsAccountTemplates(idx).templateIds,
    jumpserverAccounts: _taGetJmsAccountTemplates(idx).usernames,
    publicIp: document.getElementById(`ta-vm-pubip-${idx}`)?.checked || false,
    systemDiskSize: parseInt(document.getElementById(`ta-vm-sysdisk-${idx}`)?.value) || 40,
    dataDiskSize: parseInt(document.getElementById(`ta-vm-datadisk-${idx}`)?.value) || 0,
  }));
  return { cloud_accounts, vpn_configs, storage_grants, bucket_creates, rds_accounts, vm_configs };
}

// 防抖自动保存到后端草稿（由弹窗内字段 change/input 触发）
function taAutoSaveConfig() {
  if (!_taAutoSaveReady || !taCurrentTicket) return;
  clearTimeout(_taAutoSaveTimer);
  _taAutoSaveTimer = setTimeout(async () => {
    const cfg = _taCollectConfig();
    if (!cfg) return;
    try { await post(`/feishu/tickets/${taCurrentTicket.id}/save-config`, cfg); } catch (e) { /* 静默 */ }
  }, 800);
}

// ── JumpServer 资产树节点 ────────────────────────────────
let _taJmsNodesCache = null;   // 节点列表缓存（所有 VM 共用）

async function _taLoadJmsNodes(idx, preselectId) {
  const sel = document.getElementById(`ta-vm-jms-node-${idx}`);
  if (!sel) return;
  if (!_taJmsNodesCache) {
    const r = await get('/jumpserver/nodes?pageSize=100');
    _taJmsNodesCache = (r.ok && r.data && r.data.items) ? r.data.items : [];
  }
  sel.innerHTML = '<option value="">默认（不指定）</option>'
    + _taJmsNodesCache.map(n => `<option value="${esc(n.id)}">${esc(n.full_value || n.value || n.id)}</option>`).join('');
  if (preselectId) sel.value = preselectId;
}

// ── JumpServer 账号模版 ────────────────────────────────
let _taJmsAcctTplCache = null;  // 账号模版缓存（所有 VM 共用），元素 {id,name,username}

async function _taLoadJmsAccountTemplates(idx, preselectIds, defaultUsername) {
  const sel = document.getElementById(`ta-vm-jms-account-${idx}`);
  if (!sel) return;
  if (!_taJmsAcctTplCache || !_taJmsAcctTplCache.length) {
    const r = await get('/jumpserver/account-templates');
    _taJmsAcctTplCache = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
  }
  if (!_taJmsAcctTplCache.length) {
    sel.innerHTML = '<option value="">无账号模版（不选则授权全部账号）</option>';
    return;
  }
  sel.innerHTML = _taJmsAcctTplCache.map(t =>
    `<option value="${esc(t.id)}">${esc(t.name)}（${esc(t.username)}）</option>`).join('');
  // 默认选中：回填的 ids 优先；否则按用户名匹配（aws→ec2-user，其他→root/ubuntu）
  let preIds = Array.isArray(preselectIds) && preselectIds.length ? preselectIds.slice() : [];
  if (!preIds.length && defaultUsername) {
    const hit = _taJmsAcctTplCache.find(t => t.username === defaultUsername);
    if (hit) preIds = [hit.id];
  }
  [...sel.options].forEach(o => { o.selected = preIds.includes(o.value); });
}

// 读取某 VM 已选的账号模版 { templateIds, usernames }
function _taGetJmsAccountTemplates(idx) {
  const sel = document.getElementById(`ta-vm-jms-account-${idx}`);
  if (!sel) return { templateIds: [], usernames: [] };
  const templateIds = [...sel.selectedOptions].map(o => o.value).filter(Boolean);
  const usernames = templateIds
    .map(id => (_taJmsAcctTplCache || []).find(t => t.id === id))
    .filter(Boolean).map(t => t.username);
  return { templateIds, usernames };
}

// 勾选联动：取消"添加到 JumpServer"时禁用节点下拉 + 用户多选
function taJmsToggle(idx) {
  const on = document.getElementById(`ta-vm-jumpserver-${idx}`)?.checked;
  const sel = document.getElementById(`ta-vm-jms-node-${idx}`);
  if (sel) sel.disabled = !on;
  const box = document.getElementById(`ta-vm-jms-users-${idx}`);
  const search = document.getElementById(`ta-vm-jms-user-search-${idx}`);
  if (box) box.style.opacity = on ? '1' : '0.5';
  if (box) box.style.pointerEvents = on ? 'auto' : 'none';
  if (search) search.disabled = !on;
}

// JumpServer 用户列表（所有 VM 共用缓存）
let _taJmsUsersCache = null;

// 加载授权用户多选；preselectIds 回填已选，无则默认预选申请人
async function _taLoadJmsUsers(idx, preselectIds, applicantUsername) {
  const box = document.getElementById(`ta-vm-jms-users-${idx}`);
  if (!box) return;
  // 缓存为空(null 或空数组)时重新拉，避免首次加载失败/时序问题把空结果永久缓存
  if (!_taJmsUsersCache || !_taJmsUsersCache.length) {
    box.innerHTML = '<div style="color:var(--g400);font-size:12px">加载用户中...</div>';
    const r = await get('/jumpserver/users?pageSize=200');
    _taJmsUsersCache = (r.ok && r.data && Array.isArray(r.data.items)) ? r.data.items : [];
    if (!_taJmsUsersCache.length) {
      box.innerHTML = `<div style="color:var(--warn);font-size:12px">未获取到 JumpServer 用户${r.data?.error ? '：' + esc(r.data.error) : '（请确认已配置 JumpServer 凭据并同步用户）'}</div>`;
      return;
    }
  }
  // 默认选中：回填的 ids 优先；否则按申请人用户名匹配
  let checkedIds = Array.isArray(preselectIds) && preselectIds.length ? preselectIds.slice() : [];
  if (!checkedIds.length && applicantUsername) {
    const u = _taJmsUsersCache.find(x => x.username === applicantUsername);
    if (u) checkedIds = [u.id];
  }
  box._checked = new Set(checkedIds);
  box._applicant = applicantUsername || '';
  _taRenderJmsUsers(idx, '');
}

function _taRenderJmsUsers(idx, keyword) {
  const box = document.getElementById(`ta-vm-jms-users-${idx}`);
  if (!box) return;
  const checked = box._checked || new Set();
  const kw = (keyword || '').trim().toLowerCase();
  const list = kw
    ? _taJmsUsersCache.filter(u => (u.username || '').toLowerCase().includes(kw) || (u.name || '').toLowerCase().includes(kw))
    : _taJmsUsersCache;
  if (!list.length) { box.innerHTML = '<div style="color:var(--g400);font-size:12px">无匹配用户</div>'; return; }
  box.innerHTML = list.map(u => {
    const tag = u.username === box._applicant ? '<span style="color:var(--primary);font-size:11px">申请人</span>' : '';
    return `<label style="display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer;font-size:12px">
      <input type="checkbox" class="ta-vm-jms-user-cb-${idx}" value="${esc(u.id)}" ${checked.has(u.id) ? 'checked' : ''} onchange="_taJmsUserToggle(${idx},'${esc(u.id)}',this.checked)">
      <span>${esc(u.name || u.username)}</span><span style="color:var(--g400)">@${esc(u.username)}</span> ${tag}
    </label>`;
  }).join('');
}

// 勾选变更时记住选择（跨搜索过滤保留）
function _taJmsUserToggle(idx, id, on) {
  const box = document.getElementById(`ta-vm-jms-users-${idx}`);
  if (!box) return;
  if (!box._checked) box._checked = new Set();
  if (on) box._checked.add(id); else box._checked.delete(id);
}

function _taFilterJmsUsers(idx) {
  _taRenderJmsUsers(idx, document.getElementById(`ta-vm-jms-user-search-${idx}`)?.value);
}

// 读取某 VM 已勾选的授权用户 ID（用 _checked 集合，跨搜索过滤保留）
function _taGetJmsUserIds(idx) {
  const box = document.getElementById(`ta-vm-jms-users-${idx}`);
  return box && box._checked ? [...box._checked] : [];
}

// ── VM 配置：VPC 加载 ────────────────────────────────────
const _taVmCache = {}; // 缓存 { 'aws-us-west-2': { vpcs: [...], subnets: {...}, securityGroups: {...} } }
const _taVmSecurityGroupsCache = {}; // 缓存完整安全组列表 { '0': [...], '1': [...] }

async function _taLoadVpcs(platform, region, idx, preselect) {
  const sel = document.getElementById(`ta-vm-vpc-${idx}`);
  if (!sel) return;

  const cacheKey = `${platform}-${region}`;
  try {
    const resp = await get(`/instances/vpcs?platform=${platform}&region=${region}`);
    console.log('[VPCs API]', { platform, region, resp });
    if (!resp.ok || !resp.data) {
      sel.innerHTML = '<option value="">加载失败</option>';
      return;
    }

    const vpcs = resp.data.vpcs || [];
    if (vpcs.length === 0) {
      sel.innerHTML = '<option value="">该地域无 VPC</option>';
      return;
    }

    if (!_taVmCache[cacheKey]) _taVmCache[cacheKey] = {};
    _taVmCache[cacheKey].vpcs = vpcs;

    sel.innerHTML = '<option value="">请选择 VPC</option>' +
      vpcs.map(v => `<option value="${esc(v.id)}">${esc(v.name || v.id)}</option>`).join('');
    sel.disabled = false;

    // 重试回填：若上次选择的 VPC 仍存在，选中并联动加载子网/安全组
    if (preselect && preselect.vpcId && vpcs.some(v => v.id === preselect.vpcId)) {
      sel.value = preselect.vpcId;
      taVpcChanged(idx, preselect);
    }
  } catch (e) {
    console.error('[VPCs Error]', e);
    sel.innerHTML = '<option value="">加载失败</option>';
  }
}

function taVpcChanged(idx, preselect) {
  const vpcSel = document.getElementById(`ta-vm-vpc-${idx}`);
  const vpcId = vpcSel?.value || '';

  const subnetSel = document.getElementById(`ta-vm-subnet-${idx}`);
  const sgSel = document.getElementById(`ta-vm-sg-${idx}`);
  const sgSearchInput = document.getElementById(`ta-vm-sg-search-${idx}`);

  if (!vpcId) {
    subnetSel.innerHTML = '<option value="">请先选择 VPC</option>';
    subnetSel.disabled = true;
    sgSel.innerHTML = '<option value="">请先选择 VPC</option>';
    sgSel.disabled = true;
    if (sgSearchInput) {
      sgSearchInput.value = '';
      sgSearchInput.disabled = true;
    }
    return;
  }

  // 从 HTML 获取 platform 和 region（需要存储在 select 元素上）
  const platform = vpcSel.dataset.platform;
  const region = vpcSel.dataset.region;

  subnetSel.innerHTML = '<option value="">加载中...</option>';
  subnetSel.disabled = false;
  sgSel.innerHTML = '<option value="">加载中...</option>';
  sgSel.disabled = false;
  if (sgSearchInput) {
    sgSearchInput.value = '';
    sgSearchInput.disabled = false;
  }

  _taLoadSubnetsForVpc(platform, region, vpcId, idx, preselect?.subnetId);
  _taLoadSecurityGroupsForVpc(platform, region, vpcId, idx, preselect?.securityGroupId);
}

async function _taLoadSecurityGroups(platform, region, idx, vpcId, preselectSgId) {
  const sel = document.getElementById(`ta-vm-sg-${idx}`);
  const searchInput = document.getElementById(`ta-vm-sg-search-${idx}`);
  if (!sel) return;

  try {
    const url = vpcId
      ? `/instances/security-groups?platform=${platform}&region=${region}&vpcId=${vpcId}`
      : `/instances/security-groups?platform=${platform}&region=${region}`;
    const resp = await get(url);
    console.log('[Security Groups API]', { platform, region, vpcId, resp });
    if (!resp.ok || !resp.data) {
      sel.innerHTML = '<option value="">加载失败</option>';
      return;
    }

    const groups = resp.data.groups || [];
    if (groups.length === 0) {
      sel.innerHTML = '<option value="">该 VPC 无安全组</option>';
      if (searchInput) searchInput.disabled = true;
      return;
    }

    // 缓存完整列表
    _taVmSecurityGroupsCache[idx] = groups;

    sel.innerHTML = '<option value="">请选择安全组</option>' +
      groups.map(g => `<option value="${esc(g.id)}">${esc(g.name || g.id)}</option>`).join('');
    if (preselectSgId && groups.some(g => g.id === preselectSgId)) sel.value = preselectSgId;

    if (searchInput) searchInput.disabled = false;
  } catch (e) {
    console.error('[Security Groups Error]', e);
    sel.innerHTML = '<option value="">加载失败</option>';
    if (searchInput) searchInput.disabled = true;
  }
}

function taFilterSecurityGroups(idx) {
  const searchInput = document.getElementById(`ta-vm-sg-search-${idx}`);
  const sel = document.getElementById(`ta-vm-sg-${idx}`);
  const searchTerm = (searchInput?.value || '').toLowerCase().trim();

  const allGroups = _taVmSecurityGroupsCache[idx] || [];
  if (allGroups.length === 0) return;

  const filtered = searchTerm
    ? allGroups.filter(g => (g.name || g.id).toLowerCase().includes(searchTerm))
    : allGroups;

  sel.innerHTML = '<option value="">请选择安全组</option>' +
    filtered.map(g => `<option value="${esc(g.id)}">${esc(g.name || g.id)}</option>`).join('');

  if (filtered.length === 0) {
    sel.innerHTML = '<option value="">无匹配结果</option>';
  }
}

async function _taLoadSubnets(platform, region, idx, vpcId, preselectSubnetId) {
  const sel = document.getElementById(`ta-vm-subnet-${idx}`);
  if (!sel) return;

  try {
    const url = vpcId
      ? `/instances/subnets?platform=${platform}&region=${region}&vpcId=${vpcId}`
      : `/instances/subnets?platform=${platform}&region=${region}`;
    const resp = await get(url);
    console.log('[Subnets API]', { platform, region, vpcId, resp });
    if (!resp.ok || !resp.data) {
      sel.innerHTML = '<option value="">加载失败</option>';
      return;
    }

    const subnets = resp.data.subnets || [];
    if (subnets.length === 0) {
      sel.innerHTML = '<option value="">该 VPC 无子网</option>';
      return;
    }

    sel.innerHTML = '<option value="">请选择子网</option>' +
      subnets.map(s => `<option value="${esc(s.id)}" data-zone="${esc(s.zone)}">${esc(s.name)}</option>`).join('');
    if (preselectSubnetId && subnets.some(s => s.id === preselectSubnetId)) sel.value = preselectSubnetId;
  } catch (e) {
    console.error('[Subnets Error]', e);
    sel.innerHTML = '<option value="">加载失败</option>';
  }
}

function _taLoadSubnetsForVpc(platform, region, vpcId, idx, preselectSubnetId) {
  _taLoadSubnets(platform, region, idx, vpcId, preselectSubnetId);
}

function _taLoadSecurityGroupsForVpc(platform, region, vpcId, idx, preselectSgId) {
  _taLoadSecurityGroups(platform, region, idx, vpcId, preselectSgId);
}

async function taCreateBucket(i) {
  const req     = _taBucketReqs[i];
  if (!req) return;
  const region  = document.getElementById(`ta-bk-region-${i}`)?.value;
  const notes   = document.getElementById(`ta-bk-notes-${i}`)?.value.trim() || '';
  const msgEl   = document.getElementById(`ta-bk-msg-${i}`);
  const badgeEl = document.getElementById(`ta-bk-badge-${i}`);
  const btn     = document.getElementById(`ta-bk-btn-${i}`);
  if (!region) { if (msgEl) { msgEl.style.color = 'var(--danger,#dc2626)'; msgEl.textContent = '请先选择地域'; } return; }
  btn.disabled = true; btn.textContent = '创建中...';
  if (msgEl) msgEl.textContent = '';
  const r = await post('/storage/buckets', { platform: req.platform, name: req.bucket, region, notes });
  btn.disabled = false; btn.textContent = '重新创建';
  if (r.ok) {
    if (badgeEl) badgeEl.innerHTML = `<span class="badge badge-ok" style="font-size:11px">✅ 已创建</span>`;
    if (msgEl)   { msgEl.style.color = 'var(--success,#16a34a)'; msgEl.textContent = `地域：${region}`; }
    btn.style.display = 'none';
  } else {
    if (badgeEl) badgeEl.innerHTML = `<span class="badge badge-err" style="font-size:11px">❌ 创建失败</span>`;
    if (msgEl)   { msgEl.style.color = 'var(--danger,#dc2626)'; msgEl.textContent = r.data?.error || '创建失败'; }
  }
}

const _taVpnCache = {};
async function _taLoadVpnServers(platform, selId) {
  const sel = document.getElementById(selId);
  if (!sel) return;
  if (_taVpnCache[platform]) { _taFillVpnSel(sel, _taVpnCache[platform]); return; }
  const r = await get(`/vpn/servers?platform=${platform}`);
  _taVpnCache[platform] = r.ok ? (r.data.servers || []) : [];
  _taFillVpnSel(sel, _taVpnCache[platform]);
}
function _taFillVpnSel(sel, servers) {
  if (!servers.length) { sel.innerHTML = '<option value="">暂无可用服务器</option>'; return; }
  sel.innerHTML = '<option value="">-- 请选择服务器 --</option>'
    + servers.map(s => `<option value="${esc(s.id)}" data-name="${esc(s.name)}">${esc(s.name)}</option>`).join('');
}

function _taGroupSection(p, groups) {
  if (!groups.length) return `<div style="font-size:13px;color:var(--g400);padding:8px 0">暂无已同步用户组</div>`;
  return `<div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--g600)">加入用户组</div>
    ${groups.map(g => `
      <label style="display:flex;align-items:center;gap:8px;padding:5px 4px;cursor:pointer;font-size:13px">
        <input type="checkbox" name="ta-group-${p}" value="${esc(g.group_name)}">
        <span>${esc(g.display_name || g.group_name)}</span>
        <span style="font-size:11px;color:var(--g400)">(${g.member_count || 0}人)</span>
      </label>`).join('')}`;
}

function _taRenderPolicyGrid(p) {
  const grid  = document.getElementById(`ta-pol-grid-${p}`);
  const pager = document.getElementById(`ta-pol-pager-${p}`);
  if (!grid || !taPolicyState[p]) return;

  const state    = taPolicyState[p];
  const selected = taCheckedPolicies[p] || new Set();
  const q        = (state.query || '').toLowerCase();
  const filtered = q ? state.items.filter(pol => pol.name.toLowerCase().includes(q) || (pol.desc||'').toLowerCase().includes(q)) : state.items;
  const total    = filtered.length;
  const pages    = Math.max(1, Math.ceil(total / state.pageSize));
  if (state.page > pages) state.page = pages;
  const slice = filtered.slice((state.page-1)*state.pageSize, state.page*state.pageSize);

  grid.innerHTML = slice.map(pol => `
    <label class="policy-item level-${pol.level||'normal'}">
      <input type="checkbox" name="ta-policy-${p}" value="${esc(pol.id)}"
        ${selected.has(pol.id) ? 'checked' : ''}
        onchange="_taTogglePolicy('${p}','${esc(pol.id)}',this.checked)">
      <div class="policy-item-info">
        <div class="policy-item-name"><span class="level-dot"></span>${esc(pol.name)}</div>
        <div class="policy-item-desc">${esc(pol.desc||'')}</div>
      </div>
    </label>`).join('');

  if (pager) {
    pager.innerHTML = pages <= 1
      ? `<span class="pol-pager-info">${total > 0 ? `共 ${total} 个策略` : '无匹配策略'}</span>`
      : `<button class="pol-page-btn" onclick="_taGoPolPage('${p}',-1)" ${state.page<=1?'disabled':''}>‹ 上一页</button>
         <span class="pol-pager-info">第 ${state.page}/${pages} 页（共 ${total} 个）</span>
         <button class="pol-page-btn" onclick="_taGoPolPage('${p}',1)" ${state.page>=pages?'disabled':''}>下一页 ›</button>`;
  }
}

function _taFilterPolicies(p, q) {
  if (!taPolicyState[p]) return;
  taPolicyState[p].query = q; taPolicyState[p].page = 1;
  _taRenderPolicyGrid(p);
}

function _taGoPolPage(p, delta) {
  if (!taPolicyState[p]) return;
  taPolicyState[p].page = Math.max(1, taPolicyState[p].page + delta);
  _taRenderPolicyGrid(p);
}

function _taTogglePolicy(p, id, checked) {
  if (!taCheckedPolicies[p]) taCheckedPolicies[p] = new Set();
  if (checked) taCheckedPolicies[p].add(id); else taCheckedPolicies[p].delete(id);
}

async function submitTicketApproval() {
  if (!taCurrentTicket) return;
  const btn   = document.getElementById('ta-btn-submit');
  const errEl = document.getElementById('ta-err');

  const draft = (() => { try { return JSON.parse(taCurrentTicket.account_draft); } catch { return {}; } })();

  // ── 密码重置工单：直接提交审批 ──────────────────────────
  if (draft.ticket_type === 'password_reset') {
    btn.disabled = true; btn.textContent = '处理中...';
    const r = await post(`/feishu/tickets/${taCurrentTicket.id}/approve`, {});
    btn.disabled = false; btn.textContent = '确认重置密码';
    if (r.ok) {
      closeApproveModal();
      toast('密码重置已批准，正在执行...', 'ok');
      setTimeout(() => loadTickets(), 1500);
    } else {
      errEl.textContent = r.error || '审批失败';
    }
    return;
  }

  // ── 原有账号申请工单 ─────────────────────────────────────
  const platforms = draft.cloud_platforms || (draft.cloud_accounts || []).map(ca => ca.platform);

  const cloud_accounts = platforms.map(p => ({
    platform: p,
    policies: [...(taCheckedPolicies[p] || new Set())],
    groups:   [...document.querySelectorAll(`input[name="ta-group-${p}"]:checked`)].map(el => el.value),
    enable_console: document.getElementById(`ta-console-${p}`)?.checked || false,
    ...(p === 'bytebase' ? { bytebaseInstanceId: draft.bytebase_instance_id || '' } : {}),
  }));

  const PSHORT_S = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
  const vpn_configs = taCurrentVpnReqs.map((vr, i) => {
    const sel        = document.getElementById(`ta-vpn-server-${i}`);
    const serverId   = sel?.value || '';
    const serverName = sel?.options[sel.selectedIndex]?.dataset.name || '';
    const clientName = (document.getElementById(`ta-vpn-client-${i}`)?.value || '').trim();
    return { platform: vr.platform, serverId, serverName, clientName };
  });
  for (const vc of vpn_configs) {
    if (!vc.serverId)   { errEl.textContent = `${PSHORT_S[vc.platform] || vc.platform} VPN：请选择服务器`; return; }
    if (!vc.clientName) { errEl.textContent = `${PSHORT_S[vc.platform] || vc.platform} VPN：请填写客户端名称`; return; }
  }

  // 收集存储桶创建配置（审批通过后自动创建）
  const bucket_creates = (_taBucketReqs || []).map(r => ({
    platform: r.platform, type: r.type, bucket: r.bucket, region: r.region || '', description: r.description || '',
  }));

  // 收集存储桶授权配置
  const storage_grants = _taStorageAuthReqs.map((r, i) => {
    const bucket     = (document.getElementById(`ta-sa-bucket-${i}`)?.value || '').trim();
    const policyName = (document.getElementById(`ta-sa-policy-${i}`)?.value || '').trim();
    const permission = document.querySelector(`input[name="ta-sa-perm-${i}"]:checked`)?.value || 'read';
    const path       = (document.getElementById(`ta-sa-path-${i}`)?.value || '').trim() || '*';
    return { platform: r.platform, type: r.type, bucket, region: r.region || '', permission, path, policyName, cloudUsername: r.cloudUsername || r.userId };
  });
  for (const sg of storage_grants) {
    if (!sg.bucket) {
      errEl.textContent = `${PSHORT_S[sg.platform] || sg.platform} 存储授权：请填写 Bucket 名称`;
      return;
    }
  }

  // 收集 RDS 数据库账号配置
  const rds_accounts = _taRdsReqs.map((r, i) => {
    const accountName = (document.getElementById(`ta-rds-account-${i}`)?.value || '').trim();
    const password    = (document.getElementById(`ta-rds-pwd-${i}`)?.value || '').trim();
    const dbsStr      = (document.getElementById(`ta-rds-dbs-${i}`)?.value || '').trim();
    const privilege   = document.querySelector(`input[name="ta-rds-perm-${i}"]:checked`)?.value || 'ReadOnly';
    const instanceId  = document.getElementById(`ta-rds-instid-${i}`)?.value || r.instanceId;
    const instanceName = document.getElementById(`ta-rds-instname-${i}`)?.value || r.instanceName;
    const databases   = dbsStr.split(/[,，\s]+/).filter(Boolean);
    return { platform: r.platform, instanceId, instanceName, accountName, password, privilege, databases };
  });
  for (const ra of rds_accounts) {
    if (!ra.accountName) { errEl.textContent = `${PSHORT_S[ra.platform] || ra.platform} RDS：请填写账号名称`; return; }
    if (!ra.password)    { errEl.textContent = `${PSHORT_S[ra.platform] || ra.platform} RDS：请填写密码`; return; }
    if (!ra.databases.length) { errEl.textContent = `${PSHORT_S[ra.platform] || ra.platform} RDS：请填写数据库名称`; return; }
  }

  // 收集云主机配置（VPC、子网、安全组、JumpServer选项）
  const vmReqsFromDraft = (draft.other_requests || []).filter(r => ['ec2','ecs','bcc'].includes(r.type));
  const vm_configs = vmReqsFromDraft.map((r, idx) => {
    const vpcId = document.getElementById(`ta-vm-vpc-${idx}`)?.value || '';
    const subnetId = document.getElementById(`ta-vm-subnet-${idx}`)?.value || '';
    const sgId = document.getElementById(`ta-vm-sg-${idx}`)?.value || '';
    const addToJumpserver = document.getElementById(`ta-vm-jumpserver-${idx}`)?.checked ?? true;
    const jumpserverNodeId = document.getElementById(`ta-vm-jms-node-${idx}`)?.value || '';
    const jumpserverUserIds = _taGetJmsUserIds(idx);
    const _jmsTpl = _taGetJmsAccountTemplates(idx);
    const jumpserverAccountTemplateIds = _jmsTpl.templateIds;
    const jumpserverAccounts = _jmsTpl.usernames;
    const publicIp = document.getElementById(`ta-vm-pubip-${idx}`)?.checked || false;
    const systemDiskSize = parseInt(document.getElementById(`ta-vm-sysdisk-${idx}`)?.value) || 40;
    const dataDiskSize = parseInt(document.getElementById(`ta-vm-datadisk-${idx}`)?.value) || 0;
    return { index: idx, platform: r.platform, vpcId, subnetId, securityGroupId: sgId, addToJumpserver, jumpserverNodeId, jumpserverUserIds, jumpserverAccountTemplateIds, jumpserverAccounts, publicIp, systemDiskSize, dataDiskSize };
  });
  for (const vc of vm_configs) {
    if (!vc.vpcId) { errEl.textContent = `${PSHORT_S[vc.platform] || vc.platform} 云主机：请选择 VPC`; return; }
    if (!vc.subnetId) { errEl.textContent = `${PSHORT_S[vc.platform] || vc.platform} 云主机：请选择子网`; return; }
    if (!vc.securityGroupId) { errEl.textContent = `${PSHORT_S[vc.platform] || vc.platform} 云主机：请选择安全组`; return; }
    if (vc.systemDiskSize < 20) { errEl.textContent = `${PSHORT_S[vc.platform] || vc.platform} 云主机：系统盘至少 20GB`; return; }
  }

  btn.disabled = true; btn.textContent = '创建中...';
  const r = await post(`/feishu/tickets/${taCurrentTicket.id}/approve`, { cloud_accounts, vpn_configs, storage_grants, bucket_creates, rds_accounts, vm_configs });
  btn.disabled = false; btn.textContent = '确认授权';

  if (r.ok) {
    closeApproveModal();
    toast('正在创建账号，请稍后刷新查看工单状态', 'ok');
    loadTickets();
  } else {
    errEl.textContent = r.data?.error || '操作失败';
  }
}

function showRejectPanel() {
  document.getElementById('ta-reject-panel').classList.remove('hidden');
  document.getElementById('ta-action-row').style.display = 'none';
  document.getElementById('ta-reject-reason').value = '';
  document.getElementById('ta-reject-reason').style.borderColor = '';
  document.getElementById('ta-reject-reason').focus();
}

function cancelRejectPanel() {
  document.getElementById('ta-reject-panel').classList.add('hidden');
  document.getElementById('ta-action-row').style.display = '';
}

async function confirmRejectTicket() {
  if (!taCurrentTicket) return;
  const reasonEl = document.getElementById('ta-reject-reason');
  const reason   = reasonEl.value.trim();
  if (!reason) {
    reasonEl.style.borderColor = 'var(--danger, #dc2626)';
    reasonEl.focus();
    return;
  }
  const r = await post(`/feishu/tickets/${taCurrentTicket.id}/reject`, { reason });
  if (r.ok) {
    closeApproveModal();
    toast('工单已拒绝', 'ok');
    loadTickets();
  } else {
    toast(r.data?.error || '操作失败', 'err');
  }
}

// ── 在账号创建向导中提交审批 ──
async function submitApproval() {
  const btnA = document.getElementById('btn-submit-approval');
  const btnC = document.getElementById('btn-submit');
  btnA.disabled = true; btnA.textContent = '提交中...';
  btnC.disabled = true;

  const name       = document.getElementById('c-name').value.trim();
  const email      = document.getElementById('c-email').value.trim();
  const password   = document.getElementById('c-password').value;
  const department = document.getElementById('c-dept').value.trim();
  const notes      = document.getElementById('c-notes').value.trim();

  const cloud_accounts = [...selectedPlatforms].map(p => ({
    platform: p,
    policies: [...(checkedPolicies[p] || new Set())],
    groups:   [...document.querySelectorAll(`input[name="group-${p}"]:checked`)].map(el => el.value),
    enable_console: document.getElementById(`console-${p}`)?.checked || false,
  }));

  const r = await post('/feishu/tickets', { name, email, password, department, notes, cloud_accounts });

  btnA.disabled = false; btnA.textContent = '提交飞书审批';
  btnC.disabled = false;

  if (r.ok) {
    document.getElementById('confirm-actions').classList.add('hidden');
    const resultEl = document.getElementById('create-result');
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = `
      <div class="result-item success">
        <div class="result-icon">📋</div>
        <div class="result-text">
          <strong>审批工单已提交</strong>
          <p>已发送至飞书，等待审批人处理。审批通过后将自动创建云账号。</p>
          <p style="font-size:11.5px;color:var(--g500);margin-top:4px">工单 ID：${r.data.ticket_id}</p>
        </div>
      </div>
      <button class="btn-ghost" style="margin-top:12px" onclick="navTo('approval-tickets')">查看申请记录</button>
      <button class="btn-ghost" style="margin-top:12px;margin-left:10px" onclick="initCreate()">再提交一个</button>`;
  } else {
    toast(r.data?.error || '提交审批失败', 'err');
  }
}

// ── 工单申请页 ────────────────────────────────────────────

let atCredStatus      = {};
const atCheckedRes    = { aws: new Set(), aliyun: new Set(), baidu: new Set() };
let atCurrentTab      = 'cloud'; // 'cloud' | 'vpn' | 'system' | 'reset'

function atGeneratePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const special = '!@#$';
  const all = upper + lower + digits + special;
  let pw = upper[Math.floor(Math.random() * upper.length)]
         + lower[Math.floor(Math.random() * lower.length)]
         + digits[Math.floor(Math.random() * digits.length)]
         + special[Math.floor(Math.random() * special.length)];
  for (let i = 4; i < 12; i++) pw += all[Math.floor(Math.random() * all.length)];
  const arr = pw.split('');
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  const el = document.getElementById('at-initial-password');
  if (el) el.value = arr.join('');
}

function atSwitchTab(tab) {
  atCurrentTab = tab;
  // Tab 按钮样式
  const tabs = ['cloud', 'vpn', 'system', 'reset'];
  tabs.forEach(t => {
    const btn = document.getElementById(`at-tab-btn-${t}`);
    if (!btn) return;
    btn.style.borderBottomColor = tab === t ? 'var(--primary)' : 'transparent';
    btn.style.color             = tab === t ? 'var(--primary)' : 'var(--g500)';
  });
  // 面板显示
  document.getElementById('at-panel-cloud').classList.toggle('hidden',  tab !== 'cloud');
  document.getElementById('at-panel-vpn').classList.toggle('hidden',    tab !== 'vpn');
  document.getElementById('at-panel-system').classList.toggle('hidden', tab !== 'system');
  document.getElementById('at-panel-reset').classList.toggle('hidden',  tab !== 'reset');
  // 初始密码卡：仅新建账号（云账号 / VPN / 平台工具）需要，密码重置 Tab 隐藏避免与「新密码」混淆
  const initPwCard = document.getElementById('at-initial-password-card');
  if (initPwCard) initPwCard.classList.toggle('hidden', tab === 'reset');
  // 提交按钮文案
  const submitBtn = document.getElementById('at-btn-submit');
  if (submitBtn) submitBtn.textContent = tab === 'reset' ? '提交重置申请' : '提交申请';
  // 切换 tab 时清空云资源侧选中（离开 cloud 时）
  const clearCloud = () => {
    ['aws','aliyun','baidu'].forEach(p => {
      const chk = document.getElementById(`at-chk-${p}`);
      if (chk) chk.checked = false;
    });
    Object.keys(atCheckedRes).forEach(p => atCheckedRes[p].clear());
    atUpdateCol1Styles();
    atUpdateIamNotesArea();
  };
  const clearSys = () => {
    ['jumpserver', 'bytebase', 'kuboard', 'grafana-aws', 'grafana-wuwen', 'grafana-baidu'].forEach(p => {
      const chk = document.getElementById(`at-chk-${p}`);
      if (chk) chk.checked = false;
      atSysUpdateStyle(p);
    });
  };
  const clearVpn = () => {
    ['aliyun','baidu'].forEach(p => {
      const chk = document.getElementById(`at-vpn-chk-${p}`);
      if (chk) chk.checked = false;
      atVpnUpdateStyle(p);
    });
  };
  // 只清空非当前 tab 的选中，当前 tab 的选择保留
  if (tab !== 'cloud') clearCloud();
  if (tab !== 'vpn')   clearVpn();
  if (tab !== 'system') clearSys();
  document.getElementById('at-err').textContent = '';
}

// ── VPN 申请 Tab ─────────────────────────────────────────────────────────────
function atVpnOptClick(event, platform) {
  if (event.target.tagName === 'INPUT') { atVpnUpdateStyle(platform); return; }
  const chk = document.getElementById(`at-vpn-chk-${platform}`);
  if (chk) { chk.checked = !chk.checked; atVpnUpdateStyle(platform); }
}

function atVpnUpdateStyle(platform) {
  const optEl = document.getElementById(`at-vpn-opt-${platform}`);
  const chk   = document.getElementById(`at-vpn-chk-${platform}`);
  if (!optEl) return;
  if (chk?.checked) {
    optEl.style.background      = 'var(--blue-50, #eff6ff)';
    optEl.style.borderLeftColor = 'var(--primary, #2563eb)';
  } else {
    optEl.style.background      = '';
    optEl.style.borderLeftColor = 'transparent';
  }
}

function atSysOptClick(event, platform) {
  if (event.target.tagName === 'INPUT') {
    atSysUpdateStyle(platform);
    return;
  }
  const chk = document.getElementById(`at-chk-${platform}`);
  if (chk) { chk.checked = !chk.checked; atSysUpdateStyle(platform); }
}

function atSysUpdateStyle(platform) {
  const optEl = document.getElementById(`at-opt-${platform}`);
  const chk   = document.getElementById(`at-chk-${platform}`);
  if (!optEl) return;
  if (chk?.checked) {
    optEl.style.background      = 'var(--blue-50, #eff6ff)';
    optEl.style.borderLeftColor = 'var(--primary, #2563eb)';
  } else {
    optEl.style.background      = '';
    optEl.style.borderLeftColor = 'transparent';
  }
  // Bytebase：勾选后展示实例选择器
  if (platform === 'bytebase') {
    const wrap = document.getElementById('at-bb-instance-wrap');
    if (wrap) wrap.classList.toggle('hidden', !chk?.checked);
  }
}

// 加载启用的 Bytebase 实例到申请页下拉
async function atLoadBytebaseInstances() {
  const sel = document.getElementById('at-bb-instance');
  if (!sel) return;
  const r = await get('/bytebase/instances?enabledOnly=1');
  const list = (r.ok && r.data.instances) ? r.data.instances : [];
  if (!list.length) {
    sel.innerHTML = '<option value="">（暂无可用实例，请联系管理员配置）</option>';
    return;
  }
  sel.innerHTML = list.map(i => `<option value="${i.id}">${esc(i.name)}（${esc(i.base_url)}）</option>`).join('');
}

// ── 密码重置 Tab ─────────────────────────────────────────────────────────────

let atResetCurrentType = null;

function atResetTypeChange(type) {
  atResetCurrentType = type;
  // 卡片高亮
  ['cloud', 'vpn', 'system'].forEach(t => {
    const card = document.getElementById(`at-reset-card-${t}`);
    if (!card) return;
    if (t === type) {
      card.style.borderColor = 'var(--primary)';
      card.style.background  = 'var(--blue-50, #eff6ff)';
      card.style.boxShadow   = '0 0 0 3px rgba(37,99,235,.08)';
    } else {
      card.style.borderColor = 'var(--border)';
      card.style.background  = '';
      card.style.boxShadow   = '';
    }
  });
  // 子表单显示
  document.getElementById('at-reset-cloud-form').classList.toggle('hidden', type !== 'cloud');
  document.getElementById('at-reset-vpn-form').classList.toggle('hidden',   type !== 'vpn');
  document.getElementById('at-reset-system-form').classList.toggle('hidden', type !== 'system');
  // 重置各表单
  if (type === 'cloud') {
    document.getElementById('at-reset-cloud-platform').value = '';
    const accEl = document.getElementById('at-reset-cloud-account');
    accEl.value = me.cloud_username || '';
    accEl.readOnly = true;
  } else if (type === 'vpn') {
    document.getElementById('at-reset-vpn-platform').value = '';
    document.getElementById('at-reset-vpn-client').value = '';
  } else if (type === 'system') {
    document.getElementById('at-reset-system-tool').value = '';
  }
}


async function loadVpnClientsForReset() {
  const platform = document.getElementById('at-reset-vpn-platform').value;
  const clientSelect = document.getElementById('at-reset-vpn-client');

  clientSelect.innerHTML = '<option value="">加载中...</option>';

  if (!platform) {
    clientSelect.innerHTML = '<option value="">先选择云平台</option>';
    return;
  }

  const r = await get(`/vpn/clients?platform=${platform}`);
  if (!r.ok || !r.data.clients) {
    clientSelect.innerHTML = '<option value="">加载失败</option>';
    return;
  }

  const myUsername = me.cloud_username || '';
  const clients = r.data.clients.filter(c => c.client_name === myUsername);
  if (clients.length === 0) {
    clientSelect.innerHTML = '<option value="">您在该平台下暂无 VPN 客户端</option>';
    return;
  }

  clientSelect.innerHTML = '<option value="">请选择</option>' +
    clients.map(c => `<option value="${esc(c.client_name)}">${esc(c.client_name)}</option>`).join('');
}


function atResetGeneratePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$';
  let pw = '';
  pw += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 24)];
  pw += 'abcdefghjkmnpqrstuvwxyz'[Math.floor(Math.random() * 23)];
  pw += '23456789'[Math.floor(Math.random() * 8)];
  pw += '!@#$'[Math.floor(Math.random() * 4)];
  for (let i = 4; i < 14; i++) pw += chars[Math.floor(Math.random() * chars.length)];
  pw = pw.split('').sort(() => Math.random() - 0.5).join('');
  document.getElementById('at-reset-password').value = pw;
}

function onResetReasonChange() {
  const sel = document.getElementById('at-reset-reason-select');
  const input = document.getElementById('at-reset-reason');
  if (sel.value === 'other') {
    input.style.display = 'block';
    input.focus();
  } else {
    input.style.display = 'none';
    input.value = '';
  }
}

let arVpnServersCache = {};
let arCurrentTab      = 'aws';
const arCheckedRes    = { aws: new Set(), aliyun: new Set(), baidu: new Set() };

const AT_CLOUD_LABELS = { aws: 'Amazon Web Services', aliyun: '阿里云', baidu: '百度智能云' };

// 资源申请 — 存储 / 计算 / 数据库 / 网络 / 工单
const AR_CLOUD_RESOURCES = {
  aws: [
    { id: 's3',  label: 'S3 存储桶',       desc: '申请 S3 对象存储访问权限',   category: '存储资源' },
    { id: 'ec2', label: '云主机',           desc: '申请 EC2 云服务器资源',      category: '计算资源' },
    { id: 'rds-instance', label: '数据库实例', desc: '创建 RDS(MySQL/PG) 或 ElastiCache(Redis) 实例', category: '数据库资源' },
    { id: 'k8s', label: '集群权限 (EKS)',   desc: '申请 K8s 集群指定 Namespace 的 kubectl 访问权限', category: '容器资源' },
    { id: 'registry', label: 'ECR 镜像仓库', desc: '申请 Docker 镜像仓库 Push/Pull 权限', category: '容器资源' },
    { id: 'dns', label: 'Route53 域名解析', desc: '申请 DNS 域名解析配置',      category: '网络资源' },
    { id: 'case', label: '工单提交权限',    desc: '申请 AWS Support Case 工单提交权限', category: '云工单权限' },
  ],
  aliyun: [
    { id: 'oss', label: 'OSS 存储',        desc: '申请 OSS 存储桶访问权限',    category: '存储资源' },
    { id: 'ecs', label: '云主机',           desc: '申请 ECS 云服务器资源',      category: '计算资源' },
    { id: 'rds-instance', label: '数据库实例', desc: '创建 RDS(MySQL/PG) 或 Redis 实例', category: '数据库资源' },
    { id: 'k8s', label: '集群权限 (ACK)',   desc: '申请 K8s 集群指定 Namespace 的 kubectl 访问权限', category: '容器资源' },
    { id: 'registry', label: 'ACR 镜像仓库', desc: '申请 Docker 镜像仓库 Push/Pull 权限', category: '容器资源' },
    { id: 'dns', label: '云解析 DNS',       desc: '申请域名解析配置',           category: '网络资源' },
    { id: 'case', label: '工单提交权限',    desc: '申请阿里云工单系统提交权限', category: '云工单权限' },
  ],
  baidu: [
    { id: 'bos', label: 'BOS 存储',        desc: '申请 BOS 对象存储访问权限',  category: '存储资源' },
    { id: 'bcc', label: '云主机',           desc: '申请 BCC 云服务器资源',      category: '计算资源' },
    { id: 'rds-instance', label: '数据库实例', desc: '创建 RDS(MySQL/PG) 或 SCS(Redis) 实例', category: '数据库资源' },
    { id: 'k8s', label: '集群权限 (CCE)',   desc: '申请 K8s 集群指定 Namespace 的 kubectl 访问权限', category: '容器资源' },
    { id: 'registry', label: 'CCR 镜像仓库', desc: '申请 Docker 镜像仓库 Push/Pull 权限', category: '容器资源' },
    { id: 'dns', label: '智能 DNS',         desc: '申请域名解析配置',           category: '网络资源' },
    { id: 'case', label: '工单提交权限',    desc: '申请百度云工单系统提交权限', category: '云工单权限' },
  ],
};

// ── 管理员审批弹窗 ──────────────────────────────────────
const taCheckedPolicies = {};   // { [platform]: Set<policyId> }
const taPolicyState     = {};   // { [platform]: { items, page, pageSize, query } }
let   taGroupsData      = {};
let   taPolicies        = {};
let   taCurrentTicket   = null;
let   taCurrentVpnReqs  = [];
let   _taBucketReqs     = []; // 当前审批弹窗中的存储桶创建请求
let   _taStorageAuthReqs = []; // 当前审批弹窗中的存储桶授权请求
let   _taRdsReqs        = []; // 当前审批弹窗中的 RDS 数据库账号请求
let   _ticketsCache     = {};

// ── 个人信息 Profile ────────────────────────────────────────────────────────

function checkProfileCompletion() {
  if (!me.real_name || !me.cloud_username) showProfileSetupModal(true);
}

function showProfileSetupModal(forced = false) {
  const modal     = document.getElementById('profile-setup-modal');
  const cancelBtn = document.getElementById('profile-setup-cancel');
  if (!modal) return;
  if (cancelBtn) cancelBtn.style.display = forced ? 'none' : '';

  // 姓名字段：已有则只读展示，未设置则可编辑
  const nameInput   = document.getElementById('profile-real-name');
  const nameField   = document.getElementById('profile-name-field');
  const nameReadonly = document.getElementById('profile-name-readonly');
  if (me.real_name) {
    if (nameField)    nameField.style.display   = 'none';
    if (nameReadonly) { nameReadonly.style.display = ''; nameReadonly.textContent = me.real_name; }
  } else {
    if (nameField)    nameField.style.display   = '';
    if (nameReadonly) nameReadonly.style.display = 'none';
    if (nameInput)    nameInput.value            = '';
  }

  document.getElementById('profile-cloud-username').value = me.cloud_username || '';
  document.getElementById('profile-err').textContent      = '';
  modal.classList.remove('hidden');
}

function closeProfileSetupModal() {
  document.getElementById('profile-setup-modal').classList.add('hidden');
}

async function saveUserProfile() {
  // 若 real_name 已从飞书同步则直接用，否则读输入框
  const real_name      = me.real_name || document.getElementById('profile-real-name').value.trim();
  const cloud_username = document.getElementById('profile-cloud-username').value.trim();
  const errEl          = document.getElementById('profile-err');
  errEl.textContent    = '';
  if (!real_name)      { errEl.textContent = '请填写姓名'; return; }
  if (!cloud_username) { errEl.textContent = '请填写账号名称'; return; }
  if (!/^[a-zA-Z0-9_+=,.@-]+$/.test(cloud_username)) {
    errEl.textContent = '账号名称只能包含字母、数字及 _ + = , . @ - 字符'; return;
  }
  const r = await post('/accounts/me/profile', { real_name, cloud_username });
  if (!r.ok) { errEl.textContent = r.data?.error || '保存失败'; return; }
  me.real_name      = real_name;
  me.cloud_username = cloud_username;
  closeProfileSetupModal();
  toast('个人信息已保存');
  atRenderProfileCard();
}

function atRenderProfileCard() {
  const el = document.getElementById('at-profile-info');
  if (!el) return;
  if (!me.real_name || !me.cloud_username) {
    el.innerHTML = `<div style="display:flex;align-items:center;gap:12px">
      <span style="font-size:13px;color:var(--warn)">⚠ 请先完善个人信息才能提交账号申请</span>
      <button class="btn-ghost" style="font-size:12px" onclick="showProfileSetupModal(true)">立即完善</button>
    </div>`;
    return;
  }
  el.innerHTML = `<div style="display:flex;gap:32px;flex-wrap:wrap">
    <div>
      <div style="font-size:12px;color:var(--g500)">姓名</div>
      <div style="font-size:14px;font-weight:600;margin-top:2px">${esc(me.real_name)}</div>
    </div>
    <div>
      <div style="font-size:12px;color:var(--g500)">账号名称</div>
      <code style="display:block;font-size:13px;font-weight:600;margin-top:2px;background:var(--g100);padding:2px 8px;border-radius:4px">${esc(me.cloud_username)}</code>
    </div>
    <div>
      <div style="font-size:12px;color:var(--g500)">企业邮箱</div>
      <div style="font-size:14px;font-weight:600;margin-top:2px">${esc(me.email || '-')}</div>
    </div>
    ${me.feishu_open_id ? `<div>
      <div style="font-size:12px;color:var(--g500)">飞书 OpenID</div>
      <code style="display:block;font-size:12px;font-weight:600;margin-top:2px;background:var(--g100);padding:2px 8px;border-radius:4px">${esc(me.feishu_open_id)}</code>
    </div>` : ''}
  </div>`;
}

async function initApplyAccount() {
  // 加载凭据状态（用于显示未配置徽章）
  const credR = await get('/cloud/credentials');
  atCredStatus = {};
  if (credR.ok) credR.data.credentials.forEach(c => { atCredStatus[c.platform] = true; });

  // 加载申请项可见性配置
  await refreshApplyVisibility();

  // 重置所有平台选择 + 按可见性配置显隐
  ['aws','aliyun','baidu','jumpserver','bytebase','kuboard','grafana-aws','grafana-wuwen','grafana-baidu'].forEach(p => {
    const chk = document.getElementById(`at-chk-${p}`);
    if (chk) chk.checked = false;
    const badge = document.getElementById(`at-badge-${p}`);
    if (badge) { badge.textContent = (atCredStatus[p] || p === 'kuboard') ? '' : '未配置地址'; badge.style.color = (atCredStatus[p] || p === 'kuboard') ? '' : 'var(--warn)'; }
    const optEl = document.getElementById(`at-opt-${p}`);
    if (optEl) {
      optEl.style.background = ''; optEl.style.borderLeftColor = 'transparent';
      optEl.style.display = isAccountPlatformVisible(p) ? 'flex' : 'none';
    }
  });

  // 平台工具分组：整组被隐藏时连标题一起隐藏
  atUpdateSysGroupVisibility();

  // 根据工单平台权限禁用不可选的云平台
  ['aws','aliyun','baidu'].forEach(p => {
    const optEl = document.getElementById(`at-opt-${p}`);
    const chk = document.getElementById(`at-chk-${p}`);
    if (!optEl) return;
    if (!canSubmitTicketForPlatform(p)) {
      optEl.style.opacity = '0.5';
      optEl.style.pointerEvents = 'none';
      if (chk) chk.disabled = true;
      const badge = document.getElementById(`at-badge-${p}`);
      if (badge) { badge.textContent = '无提交权限'; badge.style.color = 'var(--danger, #dc2626)'; }
    } else {
      optEl.style.opacity = '';
      optEl.style.pointerEvents = '';
      if (chk) chk.disabled = false;
    }
  });

  // VPN 申请 Tab：阿里云 / 百度云（凭据徽章 + 权限禁用）
  ['aliyun','baidu'].forEach(p => {
    const chk = document.getElementById(`at-vpn-chk-${p}`);
    if (chk) chk.checked = false;
    atVpnUpdateStyle(p);
    const optEl = document.getElementById(`at-vpn-opt-${p}`);
    const badge = document.getElementById(`at-vpn-badge-${p}`);
    if (!optEl) return;
    // 申请项可见性：VPN 作为独立申请项，key 用 `vpn-<platform>`
    optEl.style.display = isVpnPlatformVisible(p) ? 'flex' : 'none';
    if (!canSubmitTicketForPlatform(p)) {
      optEl.style.opacity = '0.5';
      optEl.style.pointerEvents = 'none';
      if (chk) chk.disabled = true;
      if (badge) { badge.textContent = '无提交权限'; badge.style.color = 'var(--danger, #dc2626)'; }
    } else if (!atCredStatus[p]) {
      optEl.style.opacity = '';
      optEl.style.pointerEvents = '';
      if (chk) chk.disabled = false;
      if (badge) { badge.textContent = '未配置'; badge.style.color = 'var(--warn)'; }
    } else {
      optEl.style.opacity = '';
      optEl.style.pointerEvents = '';
      if (chk) chk.disabled = false;
      if (badge) badge.textContent = '';
    }
  });

  // Bytebase 实例下拉：加载启用实例，隐藏选择器（勾选后才展示）。徽章按有无实例提示
  atLoadBytebaseInstances().then(() => {
    const sel = document.getElementById('at-bb-instance');
    const bbBadge = document.getElementById('at-badge-bytebase');
    const hasInst = sel && [...sel.options].some(o => o.value);
    if (bbBadge) { bbBadge.textContent = hasInst ? '' : '未配置实例'; bbBadge.style.color = hasInst ? '' : 'var(--warn)'; }
  });
  const bbWrap = document.getElementById('at-bb-instance-wrap');
  if (bbWrap) bbWrap.classList.add('hidden');

  // 重置到云资源 Tab
  atCurrentTab = 'cloud';
  atSwitchTab('cloud');

  Object.keys(atCheckedRes).forEach(p => atCheckedRes[p].clear());

  // 重置密码重置 Tab
  atResetCurrentType = null;
  ['cloud', 'vpn', 'system'].forEach(t => {
    const card = document.getElementById(`at-reset-card-${t}`);
    if (card) { card.style.borderColor = ''; card.style.background = ''; card.style.boxShadow = ''; }
  });
  ['at-reset-cloud-form','at-reset-vpn-form','at-reset-system-form'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  const resetPwEl = document.getElementById('at-reset-password');
  if (resetPwEl) resetPwEl.value = '';
  const resetReasonEl = document.getElementById('at-reset-reason');
  if (resetReasonEl) resetReasonEl.value = '';
  const resetReasonSelEl = document.getElementById('at-reset-reason-select');
  if (resetReasonSelEl) { resetReasonSelEl.value = ''; }
  if (resetReasonEl) resetReasonEl.style.display = 'none';

  // 渲染申请人信息卡
  atRenderProfileCard();
  const pwEl = document.getElementById('at-initial-password');
  if (pwEl) pwEl.value = '';
  document.getElementById('at-err').textContent      = '';
  document.getElementById('at-result').classList.add('hidden');
  document.getElementById('at-submit-row').classList.remove('hidden');
  const submitBtn = document.getElementById('at-btn-submit');
  if (submitBtn) submitBtn.textContent = '提交申请';
  atUpdateIamNotesArea();
  loadAvailableWorkflows('at', 'account');
}

// 平台工具 Tab 的分组：整组平台都不可见时，隐藏该分组容器（含标题）
const _AT_SYS_GROUPS = {
  'at-sysgroup-host':    ['jumpserver'],
  'at-sysgroup-db':      ['bytebase'],
  'at-sysgroup-cluster': ['kuboard'],
  'at-sysgroup-monitor': ['grafana-aws', 'grafana-wuwen', 'grafana-baidu'],
};

function atUpdateSysGroupVisibility() {
  Object.entries(_AT_SYS_GROUPS).forEach(([groupId, platforms]) => {
    const groupEl = document.getElementById(groupId);
    if (!groupEl) return;
    const anyVisible = platforms.some(isAccountPlatformVisible);
    groupEl.style.display = anyVisible ? '' : 'none';
  });
}

const _AT_SHORT_LABELS = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };

function atUpdateIamNotesArea() {
  const area = document.getElementById('at-iam-notes-area');
  const rows = document.getElementById('at-iam-notes-rows');
  if (!area || !rows) return;
  const iamPlatforms = ['aws', 'aliyun', 'baidu'].filter(p => document.getElementById(`at-chk-${p}`)?.checked);
  if (iamPlatforms.length === 0) {
    area.classList.add('hidden');
    return;
  }
  // preserve existing values before re-render
  const saved = {};
  iamPlatforms.forEach(p => { saved[p] = document.getElementById(`at-iam-desc-${p}`)?.value || ''; });
  area.classList.remove('hidden');
  rows.innerHTML = iamPlatforms.map(p => `<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
      <label style="width:64px;font-size:13px;font-weight:600;color:var(--g700);flex-shrink:0">${_AT_SHORT_LABELS[p]} <span style="color:var(--danger,#dc2626)">*</span></label>
      <input type="text" id="at-iam-desc-${p}" value="${(saved[p] || '').replace(/"/g, '&quot;')}"
             placeholder="账号用途备注，如：开发测试、运营分析（必填）"
             style="flex:1;padding:8px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px;box-sizing:border-box">
    </div>`).join('');
}

// 云账号申请：勾选平台即申请该云的子账号（每个平台只有 IAM 子账号一种）
function atOnPlatformChange(platform) {
  const checked = document.getElementById(`at-chk-${platform}`)?.checked;
  if (checked) {
    atCheckedRes[platform]?.add('iam');
  } else {
    atCheckedRes[platform]?.clear();
  }
  atUpdateCol1Styles();
  atUpdateIamNotesArea();
}

function atOnPlatformOptClick(event, platform) {
  if (event.target.tagName === 'INPUT') return;
  const chk = document.getElementById(`at-chk-${platform}`);
  if (chk && !chk.disabled) {
    chk.checked = !chk.checked;
    atOnPlatformChange(platform);
  }
}

function atUpdateCol1Styles() {
  ['aws', 'aliyun', 'baidu'].forEach(p => {
    const optEl = document.getElementById(`at-opt-${p}`);
    const chk   = document.getElementById(`at-chk-${p}`);
    if (!optEl) return;
    if (chk?.checked) {
      optEl.style.background      = 'var(--blue-50, #eff6ff)';
      optEl.style.borderLeftColor = 'var(--primary, #2563eb)';
    } else {
      optEl.style.background      = '';
      optEl.style.borderLeftColor = 'transparent';
    }
  });
}

// ── 资源申请（ar-）Tab 导航 ───────────────────────────────────────────────

function arSwitchTab(platform) {
  arCurrentTab = platform;
  ['aws', 'aliyun', 'baidu'].forEach(p => {
    const btn   = document.getElementById(`ar-tab-btn-${p}`);
    const panel = document.getElementById(`ar-panel-${p}`);
    const active = p === platform;
    if (btn) {
      btn.style.borderBottomColor = active ? 'var(--primary)' : 'transparent';
      btn.style.color             = active ? 'var(--primary)' : 'var(--g500)';
      btn.style.fontWeight        = active ? '600' : '400';
    }
    if (panel) panel.classList.toggle('hidden', !active);
  });
  arRenderPanel(platform);
}

function arRenderPanel(platform) {
  const panel = document.getElementById(`ar-panel-${platform}`);
  if (!panel) return;

  const resources = (AR_CLOUD_RESOURCES[platform] || []).filter(r => isResourceTypeVisible(platform, r.id));
  // Group by category
  const categories = [];
  const catMap = {};
  resources.forEach(res => {
    if (!catMap[res.category]) {
      catMap[res.category] = [];
      categories.push(res.category);
    }
    catMap[res.category].push(res);
  });

  if (!resources.length) {
    panel.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;min-height:160px;color:var(--g400);font-size:13px;padding:16px;text-align:center">该平台暂无可申请的资源</div>';
    return;
  }

  let html = '';
  categories.forEach(cat => {
    html += `<div style="margin-bottom:4px">
      <div style="font-size:11px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:.06em;padding:10px 0 6px;border-bottom:1px solid var(--border);margin-bottom:4px">${cat}</div>`;
    catMap[cat].forEach(res => {
      const checked = arCheckedRes[platform]?.has(res.id);
      html += `<div id="ar-item-${platform}-${res.id}" style="border:1px solid ${checked ? 'var(--primary)' : 'var(--border)'};border-radius:8px;margin-bottom:8px;overflow:hidden;background:${checked ? 'var(--blue-50,#eff6ff)' : 'var(--card)'}">
        <label style="display:flex;align-items:flex-start;gap:10px;padding:12px 14px;cursor:pointer">
          <input type="checkbox" id="ar-chk-${platform}-${res.id}" ${checked ? 'checked' : ''} onchange="_arSyncCheckbox('${platform}','${res.id}')" style="flex-shrink:0;margin-top:3px;cursor:pointer">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600;color:var(--g900)">${res.label}</div>
            <div style="font-size:11.5px;color:var(--g500);margin-top:2px">${res.desc}</div>
          </div>
        </label>
        <div id="ar-form-${platform}-${res.id}" style="display:${checked ? '' : 'none'};border-top:1px solid var(--border);padding:14px 16px;background:var(--g50)"></div>
      </div>`;
    });
    html += `</div>`;
  });

  panel.innerHTML = html;

  // Rebuild forms for already-checked items (e.g. after tab switch)
  resources.forEach(res => {
    if (arCheckedRes[platform]?.has(res.id)) {
      _arFillForm(platform, res.id);
    }
  });
}

function _arSyncCheckbox(platform, resId) {
  const chk     = document.getElementById(`ar-chk-${platform}-${resId}`);
  const itemEl  = document.getElementById(`ar-item-${platform}-${resId}`);
  const formEl  = document.getElementById(`ar-form-${platform}-${resId}`);
  const checked = chk?.checked;

  if (checked) {
    arCheckedRes[platform].add(resId);
    if (itemEl) {
      itemEl.style.border     = '1px solid var(--primary)';
      itemEl.style.background = 'var(--blue-50,#eff6ff)';
    }
    if (formEl) {
      formEl.style.display = '';
      if (!formEl.dataset.built) {
        _arFillForm(platform, resId);
        formEl.dataset.built = '1';
      }
    }
  } else {
    arCheckedRes[platform].delete(resId);
    if (itemEl) {
      itemEl.style.border     = '1px solid var(--border)';
      itemEl.style.background = 'var(--card)';
    }
    if (formEl) formEl.style.display = 'none';
  }
}

function _arFillForm(platform, resId) {
  const formEl = document.getElementById(`ar-form-${platform}-${resId}`);
  if (!formEl || formEl.dataset.built) return;
  const pane = arBuildDetailPane(platform, resId);
  if (!pane) return;
  formEl.innerHTML = pane.innerHTML;
  formEl.dataset.built = '1';
  if (resId === 'rds') arLoadRdsInstances(platform);
  if (['ec2', 'ecs', 'bcc'].includes(resId)) arLoadVmRegions(platform);
  if (resId === 'k8s') _arLoadK8sGroups(platform);
}

async function initApplyResource() {
  arVpnServersCache = {};
  arCurrentTab = 'aws';
  Object.keys(arCheckedRes).forEach(p => arCheckedRes[p].clear());

  // 加载申请项可见性配置（资源类型过滤依赖）
  await refreshApplyVisibility();

  const arNotesEl = document.getElementById('ar-notes');
  if (arNotesEl) arNotesEl.value = '';
  document.getElementById('ar-err').textContent = '';
  document.getElementById('ar-result').classList.add('hidden');
  document.getElementById('ar-submit-row').classList.remove('hidden');

  // 根据工单平台权限禁用不可选的 Tab
  ['aws', 'aliyun', 'baidu'].forEach(p => {
    const btn = document.getElementById(`ar-tab-btn-${p}`);
    if (!btn) return;
    if (!canSubmitTicketForPlatform(p)) {
      btn.style.opacity = '0.4';
      btn.style.pointerEvents = 'none';
      btn.title = '无提交权限';
    } else {
      btn.style.opacity = '';
      btn.style.pointerEvents = '';
      btn.title = '';
    }
  });

  // 默认选第一个有权限的平台
  const firstAllowed = ['aws', 'aliyun', 'baidu'].find(p => canSubmitTicketForPlatform(p));
  arCurrentTab = firstAllowed || 'aws';
  arSwitchTab(arCurrentTab);
  loadAvailableWorkflows('ar');
}

async function arLoadBucketsForPlatform(platform) { /* removed */ }
function arOnBucketSelChange(platform) { /* removed */ }

function arOnStorageOpChange(platform) {
  const op = document.querySelector(`input[name="ar-storage-op-${platform}"]:checked`)?.value;
  document.getElementById(`ar-storage-create-${platform}`).style.display  = op === 'create'    ? '' : 'none';
  document.getElementById(`ar-storage-auth-${platform}`).style.display    = op === 'authorize' ? '' : 'none';
}

// ── 云主机配置动态加载 ──────────────────────────────────────
async function arLoadVmRegions(platform) {
  const sel = document.getElementById(`ar-vm-region-${platform}`);
  if (!sel) {
    console.error('arLoadVmRegions: select element not found for platform', platform);
    return;
  }
  sel.innerHTML = '<option value="">加载中...</option>';

  const token = localStorage.getItem('token');
  console.log('arLoadVmRegions:', { platform, hasToken: !!token });

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const res = await fetch(`/api/instances/regions?platform=${platform}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    clearTimeout(timeout);

    console.log('arLoadVmRegions response:', res.status, res.ok);
    const data = await res.json();
    console.log('arLoadVmRegions data:', data);

    if (!res.ok || !data?.regions?.length) {
      sel.innerHTML = '<option value="">加载失败</option>';
      console.error('Load regions failed:', res.status, data);
      return;
    }
    sel.innerHTML = '<option value="">请选择地域</option>' + data.regions.map(rg =>
      `<option value="${rg.id}">${rg.name} (${rg.id})</option>`
    ).join('');
    console.log('arLoadVmRegions: loaded', data.regions.length, 'regions');
  } catch (err) {
    sel.innerHTML = '<option value="">网络错误</option>';
    console.error('Load regions error:', err);
  }
}

// 缓存云主机规格和镜像数据
const _arVmCache = {};

async function arLoadVmSpecs(platform) {
  const region = document.getElementById(`ar-vm-region-${platform}`)?.value;
  const typeSel = document.getElementById(`ar-vm-type-${platform}`);
  const imgSel = document.getElementById(`ar-vm-image-${platform}`);
  if (!region) {
    if (typeSel) typeSel.innerHTML = '<option value="">请先选择地域</option>';
    if (imgSel) imgSel.innerHTML = '<option value="">请先选择地域</option>';
    return;
  }
  if (typeSel) typeSel.innerHTML = '<option value="">加载中...</option>';
  if (imgSel) imgSel.innerHTML = '<option value="">加载中...</option>';
  _arSetSpecsLoading(platform, true);

  try {
    const token = localStorage.getItem('token');
    const [typeRes, imgRes] = await Promise.all([
      fetch(`/api/instances/instance-types?platform=${platform}&region=${region}`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => r.json()),
      fetch(`/api/instances/images?platform=${platform}&region=${region}`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => r.json())
    ]);

    // 缓存数据
    const cacheKey = `${platform}-${region}`;
    _arVmCache[cacheKey] = { types: typeRes?.types || [], images: imgRes?.images || [] };

    // 初始化筛选下拉（基于实际数据）
    _arUpdateFilterOptions(platform, region);
    arFilterVmSpecs(platform, region);
  } catch (err) {
    console.error('Load VM specs error:', err);
    if (typeSel) typeSel.innerHTML = '<option value="">加载失败</option>';
    if (imgSel) imgSel.innerHTML = '<option value="">加载失败</option>';
  } finally {
    _arSetSpecsLoading(platform, false);
  }
}

// 切换规格加载状态：显示/隐藏加载动画，并禁用筛选下拉避免误操作
function _arSetSpecsLoading(platform, loading) {
  const loadEl = document.getElementById(`ar-vm-loading-${platform}`);
  if (loadEl) loadEl.style.display = loading ? 'inline-flex' : 'none';
  ['vcpu-filter', 'mem-filter', 'os-filter', 'type', 'image'].forEach(k => {
    const el = document.getElementById(`ar-vm-${k}-${platform}`);
    if (el) el.disabled = loading;
  });
}

function _arUpdateFilterOptions(platform, region) {
  const cacheKey = `${platform}-${region}`;
  const cached = _arVmCache[cacheKey];
  if (!cached) return;

  const vcpuFilter = document.getElementById(`ar-vm-vcpu-filter-${platform}`);
  const memFilter = document.getElementById(`ar-vm-mem-filter-${platform}`);

  // 从数据中提取唯一的 CPU 和内存值
  const vcpus = [...new Set(cached.types.map(t => t.vcpu))].sort((a, b) => a - b);
  const selectedVcpu = parseInt(vcpuFilter?.value) || 0;

  // 根据当前 CPU 筛选，计算可用内存值
  const filteredByVcpu = selectedVcpu > 0 ? cached.types.filter(t => t.vcpu === selectedVcpu) : cached.types;
  const mems = [...new Set(filteredByVcpu.map(t => Math.round(t.memory / 1024)))].filter(m => m > 0).sort((a, b) => a - b);

  // 更新 CPU 下拉
  if (vcpuFilter) {
    const curVcpu = vcpuFilter.value;
    vcpuFilter.innerHTML = '<option value="0">不限</option>' + vcpus.map(v =>
      `<option value="${v}" ${String(v) === curVcpu ? 'selected' : ''}>${v} 核</option>`
    ).join('');
  }

  // 更新内存下拉
  if (memFilter) {
    const curMem = memFilter.value;
    memFilter.innerHTML = '<option value="0">不限</option>' + mems.map(m =>
      `<option value="${m}" ${String(m) === curMem ? 'selected' : ''}>${m} GB</option>`
    ).join('');
  }
}

function arFilterVmSpecs(platform, region) {
  if (!region) region = document.getElementById(`ar-vm-region-${platform}`)?.value;
  const cacheKey = `${platform}-${region}`;
  const cached = _arVmCache[cacheKey];
  if (!cached) return;

  // CPU / 内存 影响实例规格，操作系统 影响镜像，两者互不干扰
  _arRenderSpecs(platform, region);
  _arRenderImages(platform, region);
}

// 仅重建实例规格下拉（CPU / 内存 筛选变化时调用）
function _arRenderSpecs(platform, region) {
  if (!region) region = document.getElementById(`ar-vm-region-${platform}`)?.value;
  const cached = _arVmCache[`${platform}-${region}`];
  if (!cached) return;
  const typeSel = document.getElementById(`ar-vm-type-${platform}`);
  if (!typeSel) return;

  const vcpuFilter = parseInt(document.getElementById(`ar-vm-vcpu-filter-${platform}`)?.value) || 0;
  const memFilter = parseInt(document.getElementById(`ar-vm-mem-filter-${platform}`)?.value) || 0;
  const kw = (document.getElementById(`ar-vm-type-search-${platform}`)?.value || '').toLowerCase().trim();

  let filteredTypes = cached.types;
  if (vcpuFilter > 0) filteredTypes = filteredTypes.filter(t => t.vcpu === vcpuFilter);
  if (memFilter > 0) {
    const memMB = memFilter * 1024;
    filteredTypes = filteredTypes.filter(t => Math.abs(t.memory - memMB) < 512);
  }
  if (kw) filteredTypes = filteredTypes.filter(t => (t.type || '').toLowerCase().includes(kw));

  const prevType = typeSel.value;
  if (filteredTypes.length) {
    const sorted = filteredTypes.slice().sort((a, b) => a.vcpu - b.vcpu || a.memory - b.memory);
    typeSel.innerHTML = '<option value="">请选择规格 (' + filteredTypes.length + ')</option>' + sorted
      .map(t => {
        const mem = t.memory >= 1024 ? `${(t.memory / 1024).toFixed(0)}GB` : `${t.memory}MB`;
        const free = t.freeTier ? ' ★免费套餐' : '';
        const fam = _arSpecFamilyShort(platform, t.type);
        const famTxt = fam ? ` · ${fam}` : '';
        return `<option value="${t.type}">${t.type} (${t.vcpu}核 / ${mem})${famTxt}${free}</option>`;
      }).join('');
    // 若之前选中的规格仍在筛选结果内，保留选择
    if (prevType && sorted.some(t => t.type === prevType)) typeSel.value = prevType;
    // 自动在下拉里标注月价，方便直接对比。规格过多时（未充分筛选）跳过以免发太多价格请求
    if (sorted.length <= 40) _arAnnotatePrices(platform, region, sorted);
  } else {
    typeSel.innerHTML = '<option value="">无符合条件的规格</option>';
  }

  // 规格选择被重置时才清空详情，保留则不动
  const infoEl = document.getElementById(`ar-vm-spec-info-${platform}`);
  if (infoEl && typeSel.value !== prevType) { infoEl.style.display = 'none'; infoEl.innerHTML = ''; }

  _arUpdateMemOptions(platform, region);
}

// 规格系列简称：同 CPU/内存 下用于区分不同规格族（主要用于阿里云/百度下拉）
function _arSpecFamilyShort(platform, type) {
  const t = (type || '').toLowerCase();
  if (platform === 'aliyun') {
    const fam = t.replace(/^ecs\./, '');
    if (fam.startsWith('hfc')) return '高主频计算型';
    if (fam.startsWith('hfg')) return '高主频通用型';
    if (fam.startsWith('hfr')) return '高主频内存型';
    if (fam.startsWith('ic'))  return '计算网络增强型';
    if (fam.startsWith('re'))  return '内存增强型';
    if (fam.startsWith('g'))   return '通用型';
    if (fam.startsWith('c'))   return '计算型';
    if (fam.startsWith('r'))   return '内存型';
    if (fam.startsWith('t'))   return '突发性能型';
    if (fam.startsWith('u'))   return '通用算力型';
    if (fam.startsWith('e'))   return '经济型';
    if (fam.startsWith('s'))   return '共享型';
    if (fam.startsWith('v'))   return '通用型';
    if (/^(n|mn|xn|sn)/.test(fam)) return '共享型';
    return '';
  }
  if (platform === 'baidu') {
    const fam = (t.match(/bcc\.([a-z]+)/) || [, ''])[1] || '';
    if (fam.startsWith('ic')) return '高性能计算型';
    if (fam.startsWith('g'))  return '通用型';
    if (fam.startsWith('c'))  return '计算型';
    if (fam.startsWith('m'))  return '内存型';
    if (fam.startsWith('n'))  return '普通型';
    return '';
  }
  return '';
}

// 仅重建镜像下拉（操作系统 筛选变化时调用）
function _arRenderImages(platform, region) {
  if (!region) region = document.getElementById(`ar-vm-region-${platform}`)?.value;
  const cached = _arVmCache[`${platform}-${region}`];
  if (!cached) return;
  const imgSel = document.getElementById(`ar-vm-image-${platform}`);
  if (!imgSel) return;

  const osFilter = document.getElementById(`ar-vm-os-filter-${platform}`)?.value || '';
  let filteredImages = cached.images;
  if (osFilter) {
    filteredImages = filteredImages.filter(i =>
      (i.name || '').toLowerCase().includes(osFilter.toLowerCase()) ||
      (i.description || '').toLowerCase().includes(osFilter.toLowerCase())
    );
  }

  const prevImg = imgSel.value;
  if (filteredImages.length) {
    imgSel.innerHTML = '<option value="">请选择镜像 (' + filteredImages.length + ')</option>' + filteredImages.map(i =>
      `<option value="${i.id}" title="${i.description || ''}">${i.name}</option>`
    ).join('');
    if (prevImg && filteredImages.some(i => String(i.id) === prevImg)) imgSel.value = prevImg;
  } else {
    imgSel.innerHTML = '<option value="">无符合条件的镜像</option>';
  }
}

// 规格族命名说明：解释同样 CPU/内存的不同规格的差异
function _arSpecFamilyHint(platform, type) {
  const t = (type || '').toLowerCase();
  if (platform === 'aws') {
    const fam = t.split('.')[0] || '';
    const gen = (fam.match(/\d+/) || [''])[0];
    const series = fam.charAt(0);
    const seriesMap = { m: '均衡型（通用）', c: '计算优化型（CPU 强）', r: '内存优化型（内存大）', t: '突发性能型（低负载省钱）' };
    const rest = fam.slice(1);
    const feats = [];
    if (/g/.test(rest)) feats.push('ARM Graviton 处理器，性价比高');
    if (/d/.test(rest)) feats.push('本地实例存储');
    if (/n/.test(rest)) feats.push('增强网络带宽');
    if (/i/.test(rest)) feats.push('本地 NVMe/更高网络');
    let s = seriesMap[series] || '通用型';
    if (gen) s += `，第 ${gen} 代`;
    if (feats.length) s += '，' + feats.join('、');
    return s;
  }
  if (platform === 'aliyun') {
    const parts = t.replace(/^ecs\./, '').split('.');
    const fam = parts[0] || '';
    const series = fam.charAt(0);
    const gen = (fam.match(/\d+/) || [''])[0];
    const seriesMap = { g: '通用均衡型', c: '计算型（CPU 强）', r: '内存型（内存大）', t: '突发性能型', h: '高主频型' };
    let s = seriesMap[series] || '通用型';
    if (gen) s += `，第 ${gen} 代（代际越新性能越好）`;
    if (/a$/.test(fam)) s += '，AMD 处理器';
    return s;
  }
  if (platform === 'baidu') {
    const fam = (t.match(/bcc\.([a-z]+\d*)/) || [, ''])[1] || '';
    const series = fam.charAt(0);
    const gen = (fam.match(/\d+/) || [''])[0];
    const seriesMap = { g: '通用型', c: '计算型（CPU 强）', m: '内存型（内存大）' };
    let s = seriesMap[series] || '通用型';
    if (gen) s += `，第 ${gen} 代`;
    return s;
  }
  return '';
}

// 选择某个规格后：展示规格族说明 + 硬件信息 + 分操作系统价格
async function arOnSpecChange(platform) {
  const region = document.getElementById(`ar-vm-region-${platform}`)?.value;
  const type   = document.getElementById(`ar-vm-type-${platform}`)?.value;
  const infoEl = document.getElementById(`ar-vm-spec-info-${platform}`);
  if (!infoEl) return;
  if (!type) { infoEl.style.display = 'none'; infoEl.innerHTML = ''; return; }

  const hint = _arSpecFamilyHint(platform, type);
  const meta = (_arVmCache[`${platform}-${region}`]?.types || []).find(t => t.type === type);

  // 硬件信息行：vCPU / 内存 / 代际 / 架构 / 主频，以及免费套餐徽章
  let metaHtml = '';
  if (meta) {
    const bits = [];
    if (meta.vcpu) bits.push(`${meta.vcpu} vCPU`);
    if (meta.memory) bits.push(`${(meta.memory / 1024).toFixed(meta.memory % 1024 ? 1 : 0)} GiB 内存`);
    if (meta.arch) bits.push(esc(meta.arch));
    if (meta.clockSpeed) bits.push(`${meta.clockSpeed} GHz`);
    if (meta.currentGen === false) bits.push('<span style="color:#b45309">上一代</span>');
    const freeBadge = meta.freeTier
      ? `<span style="background:#dcfce7;color:#15803d;font-weight:600;padding:1px 8px;border-radius:10px;font-size:11px">符合条件的免费套餐</span>`
      : '';
    metaHtml = `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px">
      <span style="color:var(--g600)">${bits.join('　')}</span>${freeBadge}</div>`;
  }

  infoEl.style.display = '';
  infoEl.innerHTML = metaHtml +
    (hint ? `<div style="color:var(--g600)"><strong style="color:var(--g700)">规格说明：</strong>${hint}</div>` : '') +
    `<div id="ar-vm-price-${platform}" style="color:var(--g400);margin-top:4px">正在查询价格...</div>`;

  const price = await _arFetchPrice(platform, region, type);
  const priceEl = document.getElementById(`ar-vm-price-${platform}`);
  if (priceEl) priceEl.outerHTML = `<div style="margin-top:4px">${_arFormatPrice(price)}</div>`;
}

// 价格查询（带前端缓存，复用 /cloud/price 接口）
const _arPriceCache = {};
async function _arFetchPrice(platform, region, type) {
  const key = `${platform}:${region}:${type}`;
  if (key in _arPriceCache) return _arPriceCache[key];
  const r = await get(`/cloud/price/${platform}?region=${encodeURIComponent(region)}&instanceType=${encodeURIComponent(type)}`);
  const data = r.ok ? r.data : null;
  _arPriceCache[key] = data;
  return data;
}

function _arFormatPrice(data) {
  if (!data || data.price == null) {
    return `<span style="color:var(--g400)">${(data && data.note) || '暂无公开价格数据'}</span>`;
  }
  const sym = data.currency === 'USD' ? '$' : '¥';

  // AWS 返回分操作系统价格时，列成小表格便于对比
  if (Array.isArray(data.osPrices) && data.osPrices.length) {
    const rows = data.osPrices
      .slice()
      .sort((a, b) => a.price - b.price)
      .map(o => {
        const perMonth = (o.price * 730).toFixed(2);
        return `<div style="display:flex;justify-content:space-between;gap:16px;padding:2px 0">
          <span style="color:var(--g600)">${esc(o.os)}</span>
          <span><strong style="color:var(--primary)">${sym}${o.price.toFixed(4)}</strong><span style="color:var(--g400)"> /时 · ≈${sym}${perMonth}/月</span></span>
        </div>`;
      }).join('');
    return `<div><strong style="color:var(--g700)">按需价格（按操作系统）：</strong></div>` +
      `<div style="margin-top:2px">${rows}</div>`;
  }

  const price = parseFloat(data.price);
  // 若接口返回的已经是月价（预付费），直接展示月价；否则按小时价 ×730 估算月价
  if (data.unit === '月') {
    return `<span style="color:var(--g600)"><strong style="color:var(--g700)">预付费价格：</strong>` +
      `<strong style="color:var(--primary)">${sym}${price.toFixed(2)}</strong> / 月</span>`;
  }
  const perMonth = (price * 730).toFixed(2);
  return `<span style="color:var(--g600)"><strong style="color:var(--g700)">按需价格：</strong>` +
    `<strong style="color:var(--primary)">${sym}${price.toFixed(4)}</strong> / ${data.unit}` +
    `<span style="color:var(--g400);margin-left:10px">≈ ${sym}${perMonth} / 月</span></span>`;
}

// 为下拉每个选项追加月价，方便横向对比划算程度。分批并发查询，边查边回填。
async function _arAnnotatePrices(platform, region, specs) {
  const typeSel = document.getElementById(`ar-vm-type-${platform}`);
  if (!typeSel) return;

  // 单个选项处理：不可购买则移除，有价则回填价格（保留规格名+系列标签）
  const applyPrice = (type, d) => {
    const cur = document.getElementById(`ar-vm-type-${platform}`);
    if (!cur) return;
    const opt = Array.from(cur.options).find(o => o.value === type);
    if (!opt) return;
    // 该地域不可购买的规格直接从下拉移除（选了也创建不了）
    if (d && d.unavailable) {
      if (opt.selected) cur.value = '';   // 若正巧选中，重置
      opt.remove();
      return;
    }
    if (!d || d.price == null) return;
    const sym = d.currency === 'USD' ? '$' : '¥';
    const base = opt.textContent.replace(/\s·\s[¥$][\d.]+\/月$/, '');
    // unit==='月' 时价格本身就是月价，否则按小时价 ×730
    const monthly = d.unit === '月' ? parseFloat(d.price) : parseFloat(d.price) * 730;
    opt.textContent = `${base} · ${sym}${monthly.toFixed(0)}/月`;
  };

  // 分批并发（每批 6 个），避免瞬间打太多请求触发云侧限流
  const BATCH = 6;
  for (let i = 0; i < specs.length; i += BATCH) {
    // 用户已切换地域则中止
    if (document.getElementById(`ar-vm-region-${platform}`)?.value !== region) return;
    const batch = specs.slice(i, i + BATCH);
    const priced = await Promise.all(batch.map(async t => [t.type, await _arFetchPrice(platform, region, t.type)]));
    if (document.getElementById(`ar-vm-region-${platform}`)?.value !== region) return;
    priced.forEach(([type, d]) => applyPrice(type, d));
  }
  // 移除不可购买规格后，刷新占位项的数量显示
  const cur = document.getElementById(`ar-vm-type-${platform}`);
  if (cur && cur.options.length && !cur.options[0].value) {
    cur.options[0].textContent = `请选择规格 (${cur.options.length - 1})`;
  }
}

function _arUpdateMemOptions(platform, region) {
  const cacheKey = `${platform}-${region}`;
  const cached = _arVmCache[cacheKey];
  if (!cached) return;

  const vcpuFilter = parseInt(document.getElementById(`ar-vm-vcpu-filter-${platform}`)?.value) || 0;
  const memFilter = document.getElementById(`ar-vm-mem-filter-${platform}`);
  if (!memFilter) return;

  const filteredByVcpu = vcpuFilter > 0 ? cached.types.filter(t => t.vcpu === vcpuFilter) : cached.types;
  const mems = [...new Set(filteredByVcpu.map(t => Math.round(t.memory / 1024)))].filter(m => m > 0).sort((a, b) => a - b);

  const curMem = memFilter.value;
  memFilter.innerHTML = '<option value="0">不限</option>' + mems.map(m =>
    `<option value="${m}" ${String(m) === curMem ? 'selected' : ''}>${m} GB</option>`
  ).join('');
}

// ── RDS 实例加载 ──────────────────────────────────────────────
const _arRdsCache = {};

async function arLoadRdsInstances(platform) {
  const sel = document.getElementById(`ar-rds-instance-${platform}`);
  if (!sel) return;
  if (_arRdsCache[platform]) {
    _fillRdsSel(sel, _arRdsCache[platform]);
    return;
  }
  const r = await get(`/rds/instances?platform=${platform}`);
  const instances = r.ok ? (r.data.instances || []) : [];
  _arRdsCache[platform] = instances;
  _fillRdsSel(sel, instances);
}

function _fillRdsSel(sel, instances) {
  if (!instances.length) {
    sel.innerHTML = '<option value="">暂无已同步的 RDS 实例（请先同步）</option>';
    return;
  }
  sel.innerHTML = '<option value="">-- 请选择 RDS 实例 --</option>'
    + instances.map(i =>
      `<option value="${esc(i.instance_id)}" data-name="${esc(i.instance_name)}" data-engine="${esc(i.engine)}">
        ${esc(i.instance_name || i.instance_id)} (${esc(i.engine)} ${esc(i.engine_version || '')})
      </option>`
    ).join('');
}

async function arOnRdsInstanceChange(platform) {
  const sel = document.getElementById(`ar-rds-instance-${platform}`);
  const instanceId = sel?.value;
  if (!instanceId) return;
  const r = await get(`/rds/instances/${platform}/${instanceId}/databases`);
  if (r.ok && (r.data.databases || []).length) {
    const dbInput = document.getElementById(`ar-rds-db-${platform}`);
    if (dbInput) dbInput.placeholder = `可选: ${r.data.databases.join(', ')}`;
  }
}

// 申请表单「创建数据库实例」：切换引擎时用枚举表填充版本/规格下拉（复用 rds-instances.js 常量）
function arOnDbiEngineChange(platform) {
  const engine = document.getElementById(`ar-dbi-engine-${platform}`)?.value || 'mysql';
  // 版本下拉
  const verSel = document.getElementById(`ar-dbi-version-${platform}`);
  if (verSel) {
    const versions = (typeof DB_VERSIONS !== 'undefined' && DB_VERSIONS[platform]?.[engine]) || [];
    verSel.innerHTML = versions.map(v => `<option value="${v}">${v}</option>`).join('') || '<option value="">-</option>';
  }
  // 规格下拉
  const classSel = document.getElementById(`ar-dbi-class-${platform}`);
  if (classSel) {
    const classes = (typeof DB_CLASSES !== 'undefined' && DB_CLASSES[platform]?.[engine]) || [];
    classSel.innerHTML = classes.map(([v, l]) => `<option value="${v}">${l}</option>`).join('') || '<option value="">-</option>';
  }
  // 百度云 RDS 规格实为 CPU/内存组合，标签提示
  const labelEl = document.getElementById(`ar-dbi-class-label-${platform}`);
  if (labelEl) labelEl.innerHTML = (typeof isBaiduCpuMem !== 'undefined' && isBaiduCpuMem(platform, engine))
    ? '实例规格 (CPU/内存) <span class="req">*</span>'
    : '实例规格 <span class="req">*</span>';
  // Redis 无存储
  const storageWrap = document.getElementById(`ar-dbi-storage-wrap-${platform}`);
  if (storageWrap) storageWrap.style.display = engine === 'redis' ? 'none' : '';
}

// K8s 业务组列表加载（供申请表单选择）
async function _arLoadK8sGroups(platform) {
  const sel = document.getElementById(`ar-k8s-group-${platform}`);
  if (!sel) return;
  const r = await get('/clusters/groups');
  const groups = r.ok ? (r.data.groups || []) : [];
  if (!groups.length) {
    sel.innerHTML = '<option value="">暂无业务组（请管理员先创建）</option>';
    return;
  }
  sel.innerHTML = '<option value="">-- 请选择业务组 --</option>'
    + groups.map(g => `<option value="${esc(g.id)}" data-name="${esc(g.name)}">${esc(g.name)}</option>`).join('');
}

// 业务组变更 → 联动加载该组下的集群列表
// 判断是否为生产环境 namespace（production/prod，大小写不敏感，允许 prod-xxx / xxx-prod 等）
function _isProdNamespace(ns) {
  const n = String(ns || '').trim().toLowerCase();
  return /(^|[-_])(prod|production)([-_]|$)/.test(n);
}

async function _arOnK8sGroupChange(platform) {
  const groupId = document.getElementById(`ar-k8s-group-${platform}`)?.value;
  const clSel = document.getElementById(`ar-k8s-cluster-${platform}`);
  if (!clSel) return;
  if (!groupId) { clSel.innerHTML = '<option value="">请先选择业务组</option>'; return; }
  clSel.innerHTML = '<option value="">加载中...</option>';
  const r = await get(`/clusters/groups/${encodeURIComponent(groupId)}`);
  const allClusters = r.ok ? (r.data.clusters || []) : [];
  // 按当前申请的平台过滤（AWS 下只显示 AWS 集群，阿里云下只显示阿里云集群）
  const clusters = allClusters.filter(c => c.platform === platform);
  if (!clusters.length) {
    clSel.innerHTML = '<option value="">该组在当前平台下无关联集群</option>';
    return;
  }
  clSel.innerHTML = '<option value="">-- 请选择集群 --</option>'
    + clusters.map(c => `<option value="${esc(c.cluster_id)}" data-name="${esc(c.cluster_name)}">${esc(c.cluster_name)} (${esc(c.region || '')})</option>`).join('');
}

function arBuildDetailPane(platform, resId) {
  const pane = document.createElement('div');
  pane.dataset.arPane = `${platform}-${resId}`;
  pane.style.cssText = 'padding:16px';
  if (['s3', 'oss', 'bos'].includes(resId)) {
    pane.innerHTML = `
      <div style="margin-bottom:14px">
        <div style="font-size:13px;font-weight:600;color:var(--g700);margin-bottom:8px">操作类型</div>
        <div style="display:flex;gap:20px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="radio" name="ar-storage-op-${platform}" value="create" checked onchange="arOnStorageOpChange('${platform}')">
            创建新 Bucket
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="radio" name="ar-storage-op-${platform}" value="authorize" onchange="arOnStorageOpChange('${platform}')">
            授权访问现有 Bucket
          </label>
        </div>
      </div>
      <div id="ar-storage-create-${platform}">
        <div class="field">
          <label>Bucket 名称 <span class="req">*</span></label>
          <input type="text" id="ar-storage-new-name-${platform}" placeholder="如：my-prod-data">
        </div>
        <div class="field" style="margin-top:10px">
          <label>地域 <span class="req">*</span></label>
          <select id="ar-storage-new-region-${platform}" style="width:100%">
            <option value="">请选择地域</option>
            ${(BUCKET_REGIONS[platform] || []).map(r => `<option value="${r}">${r}</option>`).join('')}
          </select>
          <div style="font-size:11.5px;color:var(--warning,#d97706);margin-top:5px;line-height:1.5">⚠️ 请先确认业务所在 region 再申请创建，不清楚的先问下 mentor</div>
        </div>
        <div class="field" style="margin-top:10px">
          <label>备注（可选）</label>
          <input type="text" id="ar-storage-new-desc-${platform}" placeholder="如：生产环境数据存储">
        </div>
      </div>
      <div id="ar-storage-auth-${platform}" style="display:none">
        <div class="field">
          <label>Bucket 名称 <span class="req">*</span></label>
          <input type="text" id="ar-storage-auth-bucket-${platform}" placeholder="如：company-data">
        </div>
        <div class="field" style="margin-top:10px">
          <label>地域 <span class="req">*</span></label>
          <select id="ar-storage-auth-region-${platform}" style="width:100%">
            <option value="">请选择地域</option>
            ${(BUCKET_REGIONS[platform] || []).map(r => `<option value="${r}">${r}</option>`).join('')}
          </select>
          <div style="font-size:11.5px;color:var(--g400);margin-top:4px">选择该 Bucket 所在地域，便于审批人确认目标资源</div>
        </div>
        <div class="field">
          <label>云账号名 <span class="req">*</span></label>
          <input type="text" id="ar-storage-auth-user-${platform}" placeholder="如：zhangsan（即 IAM/RAM 子账号名称）" style="margin-top:6px">
          <div style="font-size:11.5px;color:var(--g400);margin-top:4px">填写目标云平台的子账号名称，策略将直接附加到该账号</div>
        </div>
        <div style="margin-top:10px">
          <div style="font-size:13px;font-weight:500;color:var(--g700);margin-bottom:6px">权限类型 <span class="req">*</span></div>
          <div style="display:flex;gap:20px">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
              <input type="radio" name="ar-storage-auth-perm-${platform}" value="read" checked>
              只读
            </label>
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
              <input type="radio" name="ar-storage-auth-perm-${platform}" value="readwrite">
              读写
            </label>
          </div>
        </div>
        <div class="field" style="margin-top:10px">
          <label>路径（可选）</label>
          <input type="text" id="ar-storage-auth-path-${platform}" placeholder="如：/data/prod/（留空表示整个 Bucket）">
        </div>
        <div class="field" style="margin-top:10px">
          <label>备注（可选）</label>
          <input type="text" id="ar-storage-auth-desc-${platform}" placeholder="如：需要读取生产数据">
        </div>
      </div>`;
  } else if (resId === 'rds') {
    pane.innerHTML = `
      <div class="field">
        <label>RDS 实例 <span class="req">*</span></label>
        <select id="ar-rds-instance-${platform}" style="width:100%" onchange="arOnRdsInstanceChange('${platform}')">
          <option value="">加载中...</option>
        </select>
        <div style="font-size:11.5px;color:var(--g400);margin-top:4px">列表来自已同步数据，若为空请先在管理后台同步 RDS 实例</div>
      </div>
      <div class="field" style="margin-top:10px">
        <label>数据库名称 <span class="req">*</span></label>
        <input type="text" id="ar-rds-db-${platform}" placeholder="输入要授权的数据库名称，多个用逗号分隔" style="width:100%;box-sizing:border-box">
      </div>
      <div class="field" style="margin-top:10px">
        <label>账号名称 <span class="req">*</span></label>
        <input type="text" id="ar-rds-account-${platform}" placeholder="如：app_readonly">
      </div>
      <div style="margin-top:10px">
        <div style="font-size:13px;font-weight:500;color:var(--g700);margin-bottom:6px">权限类型 <span class="req">*</span></div>
        <div style="display:flex;gap:20px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="radio" name="ar-rds-perm-${platform}" value="ReadOnly" checked> 只读
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="radio" name="ar-rds-perm-${platform}" value="ReadWrite"> 读写
          </label>
        </div>
      </div>
      <div class="field" style="margin-top:10px">
        <label>备注（可选）</label>
        <input type="text" id="ar-rds-desc-${platform}" placeholder="如：生产环境只读查询">
      </div>`;
    // 异步加载 RDS 实例列表
    arLoadRdsInstances(platform);
  } else if (['ec2', 'ecs', 'bcc'].includes(resId)) {
    pane.innerHTML = `
      <div style="margin-bottom:12px;padding:10px 14px;background:#fffbe6;border:1px solid #ffe58f;border-radius:6px;display:flex;align-items:flex-start;gap:8px">
        <span style="font-size:16px;line-height:1.3">⚠️</span>
        <div style="font-size:12px;color:#874d00;line-height:1.5">
          <b>请提前确认地域</b>：创建后不可更改。请根据需要访问的服务选择同一地域，跨地域访问会产生额外延迟和流量费用。
        </div>
      </div>
      <div class="form-row">
        <div class="field" style="flex:1">
          <label>地域 <span class="req">*</span></label>
          <select id="ar-vm-region-${platform}" style="width:100%" onchange="arLoadVmSpecs('${platform}')">
            <option value="">加载中...</option>
          </select>
        </div>
        <div class="field" style="flex:0 0 80px">
          <label>数量</label>
          <input type="number" id="ar-vm-count-${platform}" value="1" min="1" max="5" style="width:100%">
        </div>
      </div>
      <!-- 实例规格：CPU / 内存 筛选紧邻规格下拉 -->
      <div style="margin-top:10px;padding:10px;background:var(--g50);border-radius:6px;border:1px solid var(--border)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px">
          <span style="font-size:11px;color:var(--g500)">按 CPU / 内存 筛选后，请点击「实例规格」下拉框选择</span>
          <span id="ar-vm-loading-${platform}" style="display:none;font-size:11px;color:var(--primary);align-items:center;gap:4px">
            <span class="ar-spinner"></span>正在加载规格...
          </span>
        </div>
        <div class="form-row" style="gap:10px;margin-bottom:8px">
          <div class="field" style="flex:1;margin:0">
            <label style="font-size:11px">CPU 核数（筛选）</label>
            <select id="ar-vm-vcpu-filter-${platform}" style="width:100%;font-size:12px" onchange="_arRenderSpecs('${platform}')">
              <option value="0">不限</option>
            </select>
          </div>
          <div class="field" style="flex:1;margin:0">
            <label style="font-size:11px">内存大小（筛选）</label>
            <select id="ar-vm-mem-filter-${platform}" style="width:100%;font-size:12px" onchange="_arRenderSpecs('${platform}')">
              <option value="0">不限</option>
            </select>
          </div>
        </div>
        <div class="field" style="margin:0">
          <label>实例规格 <span class="req">*</span></label>
          <input type="text" id="ar-vm-type-search-${platform}" placeholder="按规格名搜索，如 t3 / m7g / large..." style="width:100%;font-size:12px;margin-bottom:4px" oninput="_arRenderSpecs('${platform}')">
          <select id="ar-vm-type-${platform}" style="width:100%" onchange="arOnSpecChange('${platform}')">
            <option value="">请先选择地域</option>
          </select>
          <div id="ar-vm-spec-info-${platform}" style="display:none;margin-top:8px;padding:8px 10px;background:#fff;border:1px solid var(--border);border-radius:6px;font-size:12px;line-height:1.6"></div>
        </div>
      </div>
      <!-- 镜像：操作系统筛选紧邻镜像下拉 -->
      <div style="margin-top:10px;padding:10px;background:var(--g50);border-radius:6px;border:1px solid var(--border)">
        <div class="field" style="margin:0 0 8px 0">
          <label style="font-size:11px">操作系统（筛选）</label>
          <select id="ar-vm-os-filter-${platform}" style="width:100%;font-size:12px" onchange="_arRenderImages('${platform}')">
            <option value="">全部</option>
            <option value="ubuntu">Ubuntu</option>
            <option value="centos">CentOS</option>
            <option value="debian">Debian</option>
            <option value="amazon">Amazon Linux</option>
            <option value="windows">Windows</option>
          </select>
        </div>
        <div class="field" style="margin:0">
          <label>操作系统镜像 <span class="req">*</span></label>
          <select id="ar-vm-image-${platform}" style="width:100%">
            <option value="">请先选择地域</option>
          </select>
        </div>
      </div>
      <div class="field" style="margin-top:10px">
        <label>公网 IP</label>
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;font-weight:normal;padding:8px 10px;border:1px solid var(--border);border-radius:6px">
          <input type="checkbox" id="ar-vm-pubip-${platform}" style="width:auto;flex-shrink:0;margin:0">
          <span>需要分配公网 IP（默认仅内网访问，勾选后可从公网访问，可能产生带宽/EIP 费用）</span>
        </label>
      </div>
      <div class="form-row" style="margin-top:10px;gap:16px">
        <div class="field" style="flex:1;margin:0">
          <label>系统盘大小 (GB) <span class="req">*</span></label>
          <input type="number" id="ar-vm-sysdisk-${platform}" value="40" min="20" max="500" style="width:100%">
          <div style="font-size:11px;color:var(--g400);margin-top:2px">操作系统所在盘，高性能 SSD，默认 40GB</div>
        </div>
        <div class="field" style="flex:1;margin:0">
          <label>数据盘大小 (GB)</label>
          <input type="number" id="ar-vm-datadisk-${platform}" value="0" min="0" max="2000" style="width:100%">
          <div style="font-size:11px;color:var(--g400);margin-top:2px">额外挂载一块数据盘，高性能 SSD；填 0 表示不挂</div>
        </div>
      </div>
      <div class="field" style="margin-top:10px">
        <label>主机名称 <span class="req">*</span></label>
        <input type="text" id="ar-vm-name-${platform}" placeholder="如：web-prod-01">
      </div>
      <div class="field" style="margin-top:10px">
        <label>用途说明 <span class="req">*</span></label>
        <input type="text" id="ar-vm-desc-${platform}" placeholder="请描述清楚要访问哪些资源，便于管理员指定具体子网，否则无法正常使用">
      </div>`;
  } else if (resId === 'rds-instance') {
    const regions = (typeof DB_REGIONS !== 'undefined' && DB_REGIONS[platform]) || [];
    pane.innerHTML = `
      <div style="margin-bottom:12px;padding:10px 14px;background:#fffbe6;border:1px solid #ffe58f;border-radius:6px;font-size:12px;color:#874d00;line-height:1.5">
        ⚠️ 创建数据库实例会产生真实云计费。请确认引擎、规格与地域，审批通过后由系统自动创建。
      </div>
      <div class="form-row">
        <div class="field" style="flex:1">
          <label>数据库类型 <span class="req">*</span></label>
          <select id="ar-dbi-engine-${platform}" style="width:100%" onchange="arOnDbiEngineChange('${platform}')">
            <option value="mysql">MySQL</option>
            <option value="postgres">PostgreSQL</option>
            <option value="redis">Redis</option>
          </select>
        </div>
        <div class="field" style="flex:1">
          <label>地域 <span class="req">*</span></label>
          <select id="ar-dbi-region-${platform}" style="width:100%">
            ${regions.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="field" style="margin-top:10px">
        <label>实例名称（可选）</label>
        <input type="text" id="ar-dbi-name-${platform}" placeholder="留空则自动生成">
      </div>
      <div class="form-row" style="margin-top:10px">
        <div class="field" style="flex:1">
          <label>引擎版本 <span class="req">*</span></label>
          <select id="ar-dbi-version-${platform}" style="width:100%"></select>
        </div>
        <div class="field" style="flex:1" id="ar-dbi-storage-wrap-${platform}">
          <label>存储 (GB)</label>
          <input type="number" id="ar-dbi-storage-${platform}" value="20" min="20">
        </div>
      </div>
      <div class="field" style="margin-top:10px" id="ar-dbi-class-wrap-${platform}">
        <label id="ar-dbi-class-label-${platform}">实例规格 <span class="req">*</span></label>
        <select id="ar-dbi-class-${platform}" style="width:100%"></select>
      </div>
      <div class="field" style="margin-top:10px">
        <label>用途说明 <span class="req">*</span></label>
        <input type="text" id="ar-dbi-desc-${platform}" placeholder="如：xx 项目生产库">
      </div>`;
    // 初始化版本/规格下拉
    setTimeout(() => arOnDbiEngineChange(platform), 0);
  } else if (resId === 'k8s') {
    pane.innerHTML = `
      <div class="field">
        <label>业务组 <span class="req">*</span></label>
        <select id="ar-k8s-group-${platform}" style="width:100%" onchange="_arOnK8sGroupChange('${platform}')">
          <option value="">加载中...</option>
        </select>
      </div>
      <div class="field" style="margin-top:10px">
        <label>集群 <span class="req">*</span></label>
        <select id="ar-k8s-cluster-${platform}" style="width:100%">
          <option value="">请先选择业务组</option>
        </select>
        <div style="font-size:11.5px;color:var(--g400);margin-top:4px">选择业务组后联动加载该组下的集群</div>
      </div>
      <div class="field" style="margin-top:10px">
        <label>Namespace <span class="req">*</span></label>
        <input type="text" id="ar-k8s-ns-${platform}" placeholder="多个用逗号分隔，如 default, production">
        <div style="font-size:11.5px;color:var(--g400);margin-top:4px">填写需要访问的 namespace，逗号分隔多个</div>
      </div>
      <div style="margin-top:10px">
        <div style="font-size:13px;font-weight:500;color:var(--g700);margin-bottom:6px">权限级别 <span class="req">*</span></div>
        <div style="display:flex;gap:20px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="radio" name="ar-k8s-perm-${platform}" value="view" checked> 只读 (view)
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="radio" name="ar-k8s-perm-${platform}" value="edit"> 读写 (edit)
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="radio" name="ar-k8s-perm-${platform}" value="admin"> Namespace 管理员
          </label>
        </div>
        <div style="font-size:11.5px;color:var(--g400);margin-top:4px">最高为 Namespace 级别管理员，不允许申请集群 ClusterAdmin 权限</div>
        <div style="font-size:11.5px;color:var(--warn);margin-top:4px">⚠ 生产环境 namespace（production / prod）只允许申请「只读(view)」，不可申请读写或管理员权限</div>
      </div>
      <div class="field" style="margin-top:10px">
        <label>用途说明 <span class="req">*</span></label>
        <input type="text" id="ar-k8s-desc-${platform}" placeholder="如：部署服务到 production namespace">
      </div>`;
    // 注意：_arLoadK8sGroups 不在这里调(pane 还没插入 DOM,getElementById 找不到)
    // 而是在外部 formEl.innerHTML 赋值后再调(见 2556 行)
  } else if (resId === 'registry') {
    pane.innerHTML = `
      <div style="margin-bottom:14px">
        <div style="font-size:13px;font-weight:600;color:var(--g700);margin-bottom:8px">权限类型 <span class="req">*</span></div>
        <div style="display:flex;gap:20px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="radio" name="ar-registry-perm-${platform}" value="push-pull" checked>
            Push + Pull（读写）
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="radio" name="ar-registry-perm-${platform}" value="pull">
            Pull（只读）
          </label>
        </div>
      </div>
      <div class="field">
        <label>用途说明 <span class="req">*</span></label>
        <input type="text" id="ar-registry-desc-${platform}" placeholder="如：CI/CD 流水线推送和拉取业务镜像" style="width:100%;box-sizing:border-box">
      </div>
      ${platform === 'aws' ? '<div style="margin-top:10px;font-size:12px;color:var(--g400)">AWS ECR 不支持固定密码，授权后使用 <code>aws ecr get-login-password</code> 获取临时令牌</div>' : ''}`;
  } else if (resId === 'dns') {
    pane.innerHTML = `
      <div class="field">
        <label>域名 <span class="req">*</span></label>
        <input type="text" id="ar-dns-domain-${platform}" placeholder="如：api.example.com" style="width:100%;box-sizing:border-box">
      </div>
      <div class="field" style="margin-top:10px">
        <label>用途说明 <span class="req">*</span></label>
        <input type="text" id="ar-dns-desc-${platform}" placeholder="如：API 服务域名解析到生产环境 ALB" style="width:100%;box-sizing:border-box">
      </div>`;
  } else if (resId === 'case') {
    const PLATFORM_LABELS = { aws: 'AWS Support Case', aliyun: '阿里云工单', baidu: '百度云工单' };
    pane.innerHTML = `
      <div class="field">
        <label>云账号名 <span class="req">*</span></label>
        <input type="text" id="ar-case-user-${platform}" placeholder="填写需要开通工单权限的云账号名称（IAM/RAM 子账号）" style="width:100%;box-sizing:border-box">
        <div style="font-size:11.5px;color:var(--g400);margin-top:4px">将为该账号授予 ${PLATFORM_LABELS[platform]} 提交权限</div>
      </div>
      <div style="margin-top:10px">
        <div style="font-size:13px;font-weight:500;color:var(--g700);margin-bottom:6px">权限级别</div>
        <div style="display:flex;gap:20px">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="radio" name="ar-case-level-${platform}" value="basic" checked>
            基础支持（查看工单）
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
            <input type="radio" name="ar-case-level-${platform}" value="full">
            完整权限（提交工单）
          </label>
        </div>
      </div>
      <div class="field" style="margin-top:10px">
        <label>用途说明 <span class="req">*</span></label>
        <input type="text" id="ar-case-desc-${platform}" placeholder="如：运维团队需要提交技术支持工单" style="width:100%;box-sizing:border-box">
      </div>`;
  } else {
    return null;
  }
  return pane;
}

async function submitResourceApply() {
  const btn   = document.getElementById('ar-btn-submit');
  const errEl = document.getElementById('ar-err');
  errEl.textContent = '';

  const notes = document.getElementById('ar-notes')?.value.trim() || '';

  const other_requests = [];
  const PLATFORM_LABELS = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };

  for (const platform of ['aws', 'aliyun', 'baidu']) {
    const checkedResIds = [...(arCheckedRes[platform] || [])];
    for (const resId of checkedResIds) {
      const res = (AR_CLOUD_RESOURCES[platform] || []).find(r => r.id === resId);
      if (!res) continue;
      const label = PLATFORM_LABELS[platform];
      if (['s3', 'oss', 'bos'].includes(resId)) {
        const op = document.querySelector(`input[name="ar-storage-op-${platform}"]:checked`)?.value || 'create';
        if (op === 'create') {
          const bucket = document.getElementById(`ar-storage-new-name-${platform}`)?.value.trim();
          if (!bucket) { errEl.textContent = `${label} 存储：请填写要创建的 Bucket 名称`; return; }
          const region = document.getElementById(`ar-storage-new-region-${platform}`)?.value.trim();
          if (!region) { errEl.textContent = `${label} 存储：请选择地域`; return; }
          const desc = document.getElementById(`ar-storage-new-desc-${platform}`)?.value.trim() || '';
          other_requests.push({ platform, type: resId, action: 'create', name: res.label, bucket, region, description: desc });
        } else {
          const bucket = document.getElementById(`ar-storage-auth-bucket-${platform}`)?.value.trim();
          if (!bucket) { errEl.textContent = `${label} 存储：请填写要授权的 Bucket 名称`; return; }
          const region = document.getElementById(`ar-storage-auth-region-${platform}`)?.value || '';
          if (!region) { errEl.textContent = `${label} 存储：请选择 Bucket 所在地域`; return; }
          const cloudUsername = document.getElementById(`ar-storage-auth-user-${platform}`)?.value?.trim();
          if (!cloudUsername) { errEl.textContent = `${label} 存储：请填写云账号名`; return; }
          const permission = document.querySelector(`input[name="ar-storage-auth-perm-${platform}"]:checked`)?.value || 'read';
          const path = document.getElementById(`ar-storage-auth-path-${platform}`)?.value.trim() || '';
          const desc = document.getElementById(`ar-storage-auth-desc-${platform}`)?.value.trim() || '';
          other_requests.push({ platform, type: resId, action: 'authorize', name: res.label, bucket, region, path, permission, description: desc, cloudUsername });
        }
      } else if (['ec2', 'ecs', 'bcc'].includes(resId)) {
        const region = document.getElementById(`ar-vm-region-${platform}`)?.value;
        if (!region) { errEl.textContent = `${label} 云主机：请选择地域`; return; }
        const instance_type = document.getElementById(`ar-vm-type-${platform}`)?.value;
        if (!instance_type) { errEl.textContent = `${label} 云主机：请选择实例规格`; return; }
        const image_id = document.getElementById(`ar-vm-image-${platform}`)?.value;
        if (!image_id) { errEl.textContent = `${label} 云主机：请选择镜像`; return; }
        // 架构校验：规格与镜像架构必须匹配（AWS 会因 x86/arm64 不匹配创建失败）
        if (platform === 'aws') {
          const _c = _arVmCache[`${platform}-${region}`];
          const _t = _c && _c.types.find(t => t.type === instance_type);
          const _i = _c && _c.images.find(im => String(im.id) === String(image_id));
          const _norm = a => /arm64|aarch64/i.test(a || '') ? 'arm64' : (/(i386|x86_64|x86|amd64)/i.test(a || '') ? 'x86_64' : '');
          if (_t && _i) {
            const ta = _norm(_t.arch), ia = _norm(_i.arch);
            if (ta && ia && ta !== ia) {
              errEl.textContent = `${label} 云主机：规格架构(${ta})与镜像架构(${ia})不匹配，请选择架构一致的规格和镜像`;
              return;
            }
          }
        }
        const instance_name = document.getElementById(`ar-vm-name-${platform}`)?.value.trim();
        if (!instance_name) { errEl.textContent = `${label} 云主机：请填写主机名称`; return; }
        const count = parseInt(document.getElementById(`ar-vm-count-${platform}`)?.value) || 1;
        const public_ip = document.getElementById(`ar-vm-pubip-${platform}`)?.checked || false;
        const system_disk_size = parseInt(document.getElementById(`ar-vm-sysdisk-${platform}`)?.value) || 40;
        const data_disk_size = parseInt(document.getElementById(`ar-vm-datadisk-${platform}`)?.value) || 0;
        if (system_disk_size < 20) { errEl.textContent = `${label} 云主机：系统盘至少 20GB`; return; }
        const desc = document.getElementById(`ar-vm-desc-${platform}`)?.value.trim() || '';
        if (!desc) { errEl.textContent = `${label} 云主机：请填写用途说明`; return; }
        other_requests.push({ platform, type: resId, name: res.label, region, instance_type, image_id, instance_name, count, public_ip, system_disk_size, data_disk_size, description: desc });
      } else if (resId === 'rds') {
        const instanceSel = document.getElementById(`ar-rds-instance-${platform}`);
        const instanceId  = instanceSel?.value;
        if (!instanceId) { errEl.textContent = `${label} RDS：请选择实例`; return; }
        const instanceName = instanceSel?.options[instanceSel.selectedIndex]?.dataset.name || instanceId;
        const dbStr = document.getElementById(`ar-rds-db-${platform}`)?.value.trim();
        if (!dbStr) { errEl.textContent = `${label} RDS：请填写数据库名称`; return; }
        const databases = dbStr.split(/[,，\s]+/).filter(Boolean);
        const accountName = document.getElementById(`ar-rds-account-${platform}`)?.value.trim();
        if (!accountName) { errEl.textContent = `${label} RDS：请填写账号名称`; return; }
        const privilege = document.querySelector(`input[name="ar-rds-perm-${platform}"]:checked`)?.value || 'ReadOnly';
        const desc = document.getElementById(`ar-rds-desc-${platform}`)?.value.trim() || '';
        other_requests.push({ platform, type: 'rds', name: res.label, instanceId, instanceName, databases, accountName, privilege, description: desc });
      } else if (resId === 'rds-instance') {
        const engineKind = document.getElementById(`ar-dbi-engine-${platform}`)?.value || 'mysql';
        const region = document.getElementById(`ar-dbi-region-${platform}`)?.value;
        if (!region) { errEl.textContent = `${label} 数据库实例：请选择地域`; return; }
        const engineVersion = document.getElementById(`ar-dbi-version-${platform}`)?.value.trim() || '';
        if (!engineVersion) { errEl.textContent = `${label} 数据库实例：请选择引擎版本`; return; }
        const classVal = document.getElementById(`ar-dbi-class-${platform}`)?.value.trim() || '';
        if (!classVal) { errEl.textContent = `${label} 数据库实例：请选择实例规格`; return; }
        const desc = document.getElementById(`ar-dbi-desc-${platform}`)?.value.trim();
        if (!desc) { errEl.textContent = `${label} 数据库实例：请填写用途说明`; return; }
        const instanceName = document.getElementById(`ar-dbi-name-${platform}`)?.value.trim() || '';
        const storageGb = engineKind === 'redis' ? undefined : (document.getElementById(`ar-dbi-storage-${platform}`)?.value || 20);
        const req = { platform, type: 'rds-instance', name: res.label, engineKind, region, engineVersion, storageGb, instanceName, description: desc };
        // 百度云 RDS 规格值格式 "cpu:mem"，拆成 cpuCount/memoryGb；其余用 instanceClass
        if (typeof isBaiduCpuMem !== 'undefined' && isBaiduCpuMem(platform, engineKind)) {
          const [cpu, mem] = classVal.split(':');
          req.cpuCount = cpu; req.memoryGb = mem;
        } else {
          req.instanceClass = classVal;
        }
        other_requests.push(req);
      } else if (resId === 'dns') {
        const domain = document.getElementById(`ar-dns-domain-${platform}`)?.value.trim();
        if (!domain) { errEl.textContent = `${label} DNS：请填写域名`; return; }
        const desc = document.getElementById(`ar-dns-desc-${platform}`)?.value.trim();
        if (!desc) { errEl.textContent = `${label} DNS：请填写用途说明`; return; }
        other_requests.push({ platform, type: 'dns', name: res.label, domain, description: desc });
      } else if (resId === 'registry') {
        const permission = document.querySelector(`input[name="ar-registry-perm-${platform}"]:checked`)?.value || 'push-pull';
        const desc = document.getElementById(`ar-registry-desc-${platform}`)?.value.trim();
        if (!desc) { errEl.textContent = `${label} 镜像仓库：请填写用途说明`; return; }
        other_requests.push({ platform, type: 'registry', name: res.label, permission, description: desc });
      } else if (resId === 'k8s') {
        const groupSel = document.getElementById(`ar-k8s-group-${platform}`);
        const group_id = groupSel?.value;
        if (!group_id) { errEl.textContent = `${label} 集群权限：请选择业务组`; return; }
        const group_name = groupSel?.options[groupSel.selectedIndex]?.dataset.name || group_id;
        const clusterSel = document.getElementById(`ar-k8s-cluster-${platform}`);
        const cluster_id = clusterSel?.value;
        if (!cluster_id) { errEl.textContent = `${label} 集群权限：请选择集群`; return; }
        const cluster_name = clusterSel?.options[clusterSel.selectedIndex]?.dataset.name || cluster_id;
        const nsStr = (document.getElementById(`ar-k8s-ns-${platform}`)?.value || '').trim();
        if (!nsStr) { errEl.textContent = `${label} 集群权限：请填写 Namespace`; return; }
        const namespaces = nsStr.split(/[,，\s]+/).filter(Boolean);
        const permission = document.querySelector(`input[name="ar-k8s-perm-${platform}"]:checked`)?.value || 'view';
        if (permission === 'cluster-admin') { errEl.textContent = `${label} 集群权限：不允许申请 ClusterAdmin`; return; }
        // 生产 namespace 保护：production/prod 不允许申请 读写(edit) 或 Namespace 管理员(admin)，只能只读(view)
        if (permission !== 'view') {
          const prodNs = namespaces.filter(ns => _isProdNamespace(ns));
          if (prodNs.length) {
            errEl.textContent = `${label} 集群权限：生产环境 namespace（${prodNs.join(', ')}）只允许申请「只读(view)」，不允许读写或管理员权限`;
            return;
          }
        }
        const desc = document.getElementById(`ar-k8s-desc-${platform}`)?.value.trim();
        if (!desc) { errEl.textContent = `${label} 集群权限：请填写用途说明`; return; }
        other_requests.push({ platform, type: 'k8s', name: res.label, group_id, group_name, cluster_id, cluster_name, namespaces, permission, description: desc });
      } else if (resId === 'case') {
        const cloudUser = document.getElementById(`ar-case-user-${platform}`)?.value.trim();
        if (!cloudUser) { errEl.textContent = `${label} 工单权限：请填写云账号名`; return; }
        const desc = document.getElementById(`ar-case-desc-${platform}`)?.value.trim();
        if (!desc) { errEl.textContent = `${label} 工单权限：请填写用途说明`; return; }
        const level = document.querySelector(`input[name="ar-case-level-${platform}"]:checked`)?.value || 'basic';
        other_requests.push({ platform, type: 'case', name: res.label, cloudUsername: cloudUser, level, description: desc });
      }
    }
  }

  if (other_requests.length === 0) { errEl.textContent = '请至少勾选一项资源'; return; }

  // 自动匹配工作流模板（根据第一个资源的类型和平台）
  const firstReq = other_requests[0] || {};

  btn.disabled = true; btn.textContent = '提交中...';
  const r = await post('/feishu/tickets', {
    notes,
    real_name:      me.real_name      || '',
    cloud_username: me.cloud_username || '',
    cloud_platforms: [],
    iam_notes:      {},
    vpn_requests:   [],
    other_requests,
  });
  btn.disabled = false; btn.textContent = '提交申请';

  if (r.ok) {
    document.getElementById('ar-submit-row').classList.add('hidden');
    const resultEl = document.getElementById('ar-result');
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = `
      <div class="alert alert-success" style="margin-bottom:12px">
        <strong>申请已提交</strong>，等待管理员审批。
      </div>
      <button class="btn-ghost" onclick="initApplyResource()">再提交一个</button>`;
  } else {
    errEl.textContent = r.data?.error || '提交失败，请重试';
  }
}

async function submitApplyAccount() {
  const btn   = document.getElementById('at-btn-submit');
  const errEl = document.getElementById('at-err');
  errEl.textContent = '';

  // 密码重置 Tab
  if (atCurrentTab === 'reset') {
    const resetType = atResetCurrentType;
    if (!resetType) { errEl.textContent = '请选择账号类型'; return; }

    const newPassword = document.getElementById('at-reset-password').value.trim();
    const reasonSelect = document.getElementById('at-reset-reason-select').value;
    const reasonInput = document.getElementById('at-reset-reason').value.trim();
    const reason = reasonSelect === 'other' ? reasonInput : reasonSelect;

    if (!newPassword) { errEl.textContent = '请填写新密码'; return; }
    if (newPassword.length < 8) { errEl.textContent = '新密码至少 8 位'; return; }
    if (!/[A-Z]/.test(newPassword)) { errEl.textContent = '新密码需包含大写字母'; return; }
    if (!/[a-z]/.test(newPassword)) { errEl.textContent = '新密码需包含小写字母'; return; }
    if (!/[0-9]/.test(newPassword)) { errEl.textContent = '新密码需包含数字'; return; }
    if (!reason) { errEl.textContent = reasonSelect === 'other' ? '请填写具体原因' : '请选择重置原因'; return; }

    let resetTarget = {};
    if (resetType === 'cloud') {
      const platform = document.getElementById('at-reset-cloud-platform').value;
      const account = document.getElementById('at-reset-cloud-account').value;
      if (!platform) { errEl.textContent = '请选择云平台'; return; }
      if (!account) { errEl.textContent = '请填写账号名称'; return; }
      if (account !== me.cloud_username) { errEl.textContent = '只能重置您自己的密码'; return; }
      resetTarget = { type: 'cloud', platform, account };
    } else if (resetType === 'vpn') {
      const platform = document.getElementById('at-reset-vpn-platform').value;
      const client = document.getElementById('at-reset-vpn-client').value;
      if (!platform) { errEl.textContent = '请选择云平台'; return; }
      if (!client) { errEl.textContent = '请选择 VPN 客户端'; return; }
      resetTarget = { type: 'vpn', platform, client };
    } else if (resetType === 'system') {
      const tool = document.getElementById('at-reset-system-tool').value;
      if (!tool) { errEl.textContent = '请选择平台工具'; return; }
      resetTarget = { type: 'system', tool };
    }

    btn.disabled = true; btn.textContent = '提交中...';
    const r = await post('/feishu/tickets', {
      ticket_type: 'password_reset',
      reset_target: resetTarget,
      new_password: newPassword,
      reason: reason,
      real_name: me.real_name || '',
      cloud_username: me.cloud_username || '',
    });
    btn.disabled = false; btn.textContent = '提交重置申请';

    if (r.ok) {
      document.getElementById('at-submit-row').classList.add('hidden');
      const resultEl = document.getElementById('at-result');
      resultEl.classList.remove('hidden');
      const autoApproved = r.data.auto_approved;
      resultEl.innerHTML = `
        <div class="result-item success">
          <div class="result-icon">🔐</div>
          <div class="result-text">
            <strong>${autoApproved ? '密码重置已提交，正在执行...' : '密码重置申请已提交'}</strong>
            <p>${autoApproved ? '密码正在重置中，请稍候刷新查看结果。' : '等待管理员审批，审批通过后将自动重置密码。'}</p>
            <p style="font-size:11.5px;color:var(--g500);margin-top:4px">工单 ID：${r.data.ticket_id}</p>
          </div>
        </div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <button class="btn-ghost" onclick="navTo('approval-tickets')">查看申请记录</button>
          <button class="btn-ghost" onclick="initApplyAccount()">再提交一个</button>
        </div>`;
    } else {
      errEl.textContent = r.data?.error || '提交失败';
    }
    return;
  }

  // 原有的账号申请逻辑
  const real_name      = me.real_name || '';
  const cloud_username = me.cloud_username || '';
  const notes          = '';
  const initial_password = document.getElementById('at-initial-password')?.value.trim() || '';

  if (!real_name || !cloud_username) {
    errEl.textContent = '请先完善个人信息（姓名和账号名称）';
    showProfileSetupModal(true);
    return;
  }

  if (!initial_password) { errEl.textContent = '请填写初始密码'; return; }
  if (initial_password.length < 8) { errEl.textContent = '初始密码至少 8 位'; return; }
  if (!/[A-Z]/.test(initial_password)) { errEl.textContent = '初始密码需包含大写字母'; return; }
  if (!/[a-z]/.test(initial_password)) { errEl.textContent = '初始密码需包含小写字母'; return; }
  if (!/[0-9]/.test(initial_password)) { errEl.textContent = '初始密码需包含数字'; return; }

  const cloud_platforms = [];
  const iam_notes      = {};
  const vpn_requests   = [];
  const other_requests = [];
  let bytebase_instance_id = '';

  if (atCurrentTab === 'vpn') {
    // VPN 申请 Tab：阿里云 / 百度云
    const selectedVpn = ['aliyun','baidu'].filter(p => document.getElementById(`at-vpn-chk-${p}`)?.checked);
    if (selectedVpn.length === 0) { errEl.textContent = '请至少选择一个云平台'; return; }
    const unconfiguredVpn = selectedVpn.filter(p => !atCredStatus[p]);
    if (unconfiguredVpn.length > 0) {
      const names = unconfiguredVpn.map(p => PNAMES[p] || p).join('、');
      errEl.textContent = `${names} 模块暂未启用，请联系管理员`;
      return;
    }
    selectedVpn.forEach(p => vpn_requests.push({ platform: p }));
  } else if (atCurrentTab === 'system') {
    // 系统账号 Tab：JumpServer / Bytebase / Kuboard / Grafana
    if (document.getElementById('at-chk-jumpserver')?.checked)    cloud_platforms.push('jumpserver');
    if (document.getElementById('at-chk-bytebase')?.checked)      cloud_platforms.push('bytebase');
    if (document.getElementById('at-chk-kuboard')?.checked)       cloud_platforms.push('kuboard');
    if (document.getElementById('at-chk-grafana-aws')?.checked)   cloud_platforms.push('grafana-aws');
    if (document.getElementById('at-chk-grafana-wuwen')?.checked) cloud_platforms.push('grafana-wuwen');
    if (document.getElementById('at-chk-grafana-baidu')?.checked) cloud_platforms.push('grafana-baidu');
    if (cloud_platforms.length === 0) { errEl.textContent = '请至少勾选一个系统账号'; return; }

    // Bytebase 多实例：必须选中一个实例
    if (cloud_platforms.includes('bytebase')) {
      const instId = document.getElementById('at-bb-instance')?.value;
      if (!instId) { errEl.textContent = 'Bytebase：请选择一个实例（若无可用实例，请联系管理员配置）'; return; }
      bytebase_instance_id = instId;
    }

    // 检查选中的系统平台是否已配置（bytebase 走实例校验，此处排除）
    const unconfigured = cloud_platforms.filter(p => p !== 'bytebase' && !atCredStatus[p]);
    if (unconfigured.length > 0) {
      const names = unconfigured.map(p => PNAMES[p] || p).join('、');
      errEl.textContent = `${names} 模块暂未启用，请联系管理员`;
      return;
    }
  } else {
    // 云资源 Tab：AWS / 阿里云 / 百度云
    const selectedClouds = ['aws','aliyun','baidu'].filter(p => document.getElementById(`at-chk-${p}`)?.checked);
    if (selectedClouds.length === 0) { errEl.textContent = '请至少选择一个云平台'; return; }

    // 检查选中的云平台是否已配置
    const unconfiguredClouds = selectedClouds.filter(p => !atCredStatus[p]);
    if (unconfiguredClouds.length > 0) {
      const names = unconfiguredClouds.map(p => PNAMES[p] || p).join('、');
      errEl.textContent = `${names} 模块暂未启用，请联系管理员`;
      return;
    }

    // 每个云平台只有 IAM 子账号一种：勾选平台即申请该云子账号，备注必填
    for (const platform of selectedClouds) {
      cloud_platforms.push(platform);
      const iamDesc = document.getElementById(`at-iam-desc-${platform}`)?.value.trim();
      if (!iamDesc) {
        errEl.textContent = `${AT_CLOUD_LABELS[platform]}：请填写账号用途备注`;
        document.getElementById(`at-iam-desc-${platform}`)?.focus();
        return;
      }
      iam_notes[platform] = iamDesc;
    }
    if (cloud_platforms.length === 0) {
      errEl.textContent = '请至少选择一个云平台'; return;
    }
  }

  btn.disabled = true; btn.textContent = '提交中...';
  const r = await post('/feishu/tickets', { notes, real_name, cloud_username, initial_password, cloud_platforms, iam_notes, vpn_requests, other_requests, bytebase_instance_id });
  btn.disabled = false; btn.textContent = '提交申请';

  if (r.ok) {
    document.getElementById('at-submit-row').classList.add('hidden');
    const resultEl = document.getElementById('at-result');
    resultEl.classList.remove('hidden');
    resultEl.innerHTML = `
      <div class="result-item success">
        <div class="result-icon">📋</div>
        <div class="result-text">
          <strong>申请已提交</strong>
          <p>等待管理员审批，审批通过后将自动开通账号。</p>
          <p style="font-size:11.5px;color:var(--g500);margin-top:4px">工单 ID：${r.data.ticket_id}</p>
        </div>
      </div>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="btn-ghost" onclick="navTo('approval-tickets')">查看申请记录</button>
        <button class="btn-ghost" onclick="initApplyAccount()">再提交一个</button>
      </div>`;
  } else {
    errEl.textContent = r.data?.error || '提交失败';
  }
}

// Cache buster: 1781052823
