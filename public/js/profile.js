// ─────────────────────────────────────────
// 我的资源画像
// ─────────────────────────────────────────
let _profileUserId = null;

function viewUserProfile(userId) {
  if (!userId || userId === me.id) {
    // 查看自己的资源，正常跳转
    _profileUserId = null;
    navTo('my-profile');
    return;
  }
  // 查看他人资源：在云账号 section 内嵌展示，不跳转
  _profileUserId = userId;
  const wrap = document.getElementById('accounts-table-wrap');
  if (wrap) {
    wrap.innerHTML = '<div class="sync-loading"><div class="spin"></div> 加载中...</div>';
    loadUserProfileInline(userId, wrap);
  }
}

async function loadUserProfileInline(userId, container) {
  const r = await get(`/accounts/${userId}/profile`);
  if (!r.ok) {
    container.innerHTML = '<div class="empty-tip">加载失败</div>';
    return;
  }

  const { user, cloud_accounts, vpn_accounts, buckets, db_accounts, ticket_count } = r.data;
  const PLABEL = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
  const CLOUD_PLATFORMS = new Set(['aws', 'aliyun', 'baidu']);

  const cloud_only = cloud_accounts.filter(a => CLOUD_PLATFORMS.has(a.platform));

  let html = `<div style="margin-bottom:16px;display:flex;align-items:center;gap:12px">
    <button class="btn-ghost btn-sm" onclick="loadAccounts()" style="padding:5px 12px">← 返回列表</button>
    <h3 style="margin:0;font-size:16px;font-weight:600">${esc(user.real_name || user.name || user.email)} 的资源画像</h3>
  </div>`;

  html += `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start">`;

  // 云账号卡片
  html += `<div class="card" style="padding:18px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
      <span style="font-size:15px;font-weight:600">☁️ 云平台账号</span>
      <span class="badge badge-info">${cloud_only.length}</span>
    </div>`;
  if (cloud_only.length === 0) {
    html += `<div style="color:var(--g400);font-size:13px">暂无云账号</div>`;
  } else {
    cloud_only.forEach(acc => {
      const pname = PLABEL[acc.platform] || acc.platform;
      const badgeColor = acc.platform === 'aws' ? 'warn' : acc.platform === 'aliyun' ? 'info' : 'ok';
      const sourceTag = acc.source === 'synced'
        ? `<span style="font-size:10px;color:var(--g400);margin-left:4px">已同步</span>`
        : `<span style="font-size:10px;color:var(--g400);margin-left:4px">已托管</span>`;
      const policies = acc.policies || [];
      const groups = acc.groups || [];
      const policyHtml = policies.length > 0
        ? `<div style="margin-top:6px"><div style="font-size:10px;color:var(--g400);margin-bottom:3px">权限策略 (${policies.length})</div><div style="display:flex;flex-wrap:wrap;gap:4px">${policies.map(p => {
            const shortName = p.replace(/^arn:[^:]+:iam::[^:]*:policy\//, '');
            return `<span style="font-size:10px;background:var(--g100);color:var(--g600);padding:1px 6px;border-radius:10px" title="${esc(p)}">${esc(shortName)}</span>`;
          }).join('')}</div></div>`
        : '';
      const groupHtml = groups.length > 0
        ? `<div style="margin-top:4px"><div style="font-size:10px;color:var(--g400);margin-bottom:3px">用户组 (${groups.length})</div><div style="display:flex;flex-wrap:wrap;gap:4px">${groups.map(g => {
            return `<span style="font-size:10px;background:#e3f2fd;color:#1565c0;padding:1px 6px;border-radius:10px">${esc(g)}</span>`;
          }).join('')}</div></div>`
        : '';
      const timeLabel = acc.synced_at
        ? `同步时间：${acc.synced_at.slice(0, 16)}`
        : `创建时间：${(acc.created_at || '').slice(0, 16)}`;
      html += `<div style="padding:10px;background:var(--g50);border-radius:6px;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span class="badge badge-${badgeColor}">${esc(pname)}</span>
          <code style="font-size:12px;background:var(--card);padding:2px 6px;border-radius:4px">${esc(acc.cloud_username)}</code>
          ${sourceTag}
        </div>
        ${policyHtml}
        ${groupHtml}
        <div style="font-size:11px;color:var(--g400);margin-top:5px">${timeLabel}</div>
      </div>`;
    });
  }
  html += `</div>`;

  // VPN 账号卡片
  html += `<div class="card" style="padding:18px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
      <span style="font-size:15px;font-weight:600">🔒 VPN 账号</span>
      <span class="badge badge-info">${vpn_accounts?.length || 0}</span>
    </div>`;
  if (!vpn_accounts?.length) {
    html += `<div style="color:var(--g400);font-size:13px">暂无 VPN 账号</div>`;
  } else {
    vpn_accounts.forEach(v => {
      const pname = PLABEL[v.platform] || v.platform;
      html += `<div style="padding:10px;background:var(--g50);border-radius:6px;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="badge badge-info">${pname}</span>
          <span style="font-size:13px;font-weight:600">${esc(v.client_name || '-')}</span>
        </div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px;color:var(--g600)">
          ${v.client_id ? `<span style="color:var(--g400)">客户端 ID</span><span><code style="background:var(--g100);padding:1px 5px;border-radius:3px;font-size:11px">${esc(v.client_id)}</code></span>` : ''}
          ${v.server_name ? `<span style="color:var(--g400)">服务端</span><span>${esc(v.server_name)}</span>` : ''}
          ${v.region ? `<span style="color:var(--g400)">地域</span><span>${esc(v.region)}</span>` : ''}
        </div>
      </div>`;
    });
  }
  html += `</div>`;

  // 工单统计卡片
  html += `<div class="card" style="padding:18px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
      <span style="font-size:15px;font-weight:600">📋 工单统计</span>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
      <div style="text-align:center;padding:12px;background:var(--g50);border-radius:6px">
        <div style="font-size:24px;font-weight:600;color:var(--primary)">${ticket_count?.total || 0}</div>
        <div style="font-size:12px;color:var(--g500);margin-top:4px">总工单数</div>
      </div>
      <div style="text-align:center;padding:12px;background:var(--g50);border-radius:6px">
        <div style="font-size:24px;font-weight:600;color:var(--success)">${ticket_count?.approved || 0}</div>
        <div style="font-size:12px;color:var(--g500);margin-top:4px">已通过</div>
      </div>
    </div>
  </div>`;

  html += `</div>`; // close grid

  container.innerHTML = html;
}

async function loadMyProfile(userId) {
  const wrap = document.getElementById('profile-wrap');
  const loading = document.getElementById('profile-loading');
  const titleEl = document.getElementById('profile-title');
  if (!wrap) return;

  const targetUserId = userId || _profileUserId || me.id;
  _profileUserId = null;
  const isViewingOther = targetUserId !== me.id;

  loading?.classList.remove('hidden');
  wrap.innerHTML = '';

  const r = await get(`/accounts/${targetUserId}/profile`);
  loading?.classList.add('hidden');

  if (!r.ok) {
    wrap.innerHTML = '<div class="empty-tip">加载失败</div>';
    return;
  }

  const { user, cloud_accounts, vpn_accounts, buckets, db_accounts, ticket_count } = r.data;

  if (titleEl) {
    if (isViewingOther) {
      titleEl.innerHTML = `
        <div style="display:flex;align-items:center;gap:12px">
          <button class="btn-ghost btn-sm" onclick="navTo('cloud-accounts')" style="padding:4px 8px">← 返回</button>
          <span>${user.real_name || user.email} 的资源</span>
        </div>
      `;
    } else {
      titleEl.textContent = '我的资源';
    }
  }

  const PLABEL = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
  const CLOUD_PLATFORMS = new Set(['aws', 'aliyun', 'baidu']);

  const cloud_only = cloud_accounts.filter(a => CLOUD_PLATFORMS.has(a.platform));

  let html = `<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start">`;

  // 云账号卡片
  html += `<div class="card" style="padding:18px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
      <span style="font-size:15px;font-weight:600">☁️ 云平台账号</span>
      <span class="badge badge-info">${cloud_only.length}</span>
    </div>`;
  if (cloud_only.length === 0) {
    html += `<div style="color:var(--g400);font-size:13px">暂无云账号</div>`;
  } else {
    cloud_only.forEach(acc => {
      const pname = PLABEL[acc.platform] || acc.platform;
      const badgeColor = acc.platform === 'aws' ? 'warn' : acc.platform === 'aliyun' ? 'info' : 'ok';
      const sourceTag = acc.source === 'synced'
        ? `<span style="font-size:10px;color:var(--g400);margin-left:4px">已同步</span>`
        : `<span style="font-size:10px;color:var(--g400);margin-left:4px">已托管</span>`;
      const policies = acc.policies || [];
      const groups = acc.groups || [];
      const isAdmin = me.role === 'admin';
      const policyHtml = policies.length > 0
        ? `<div style="margin-top:6px"><div style="font-size:10px;color:var(--g400);margin-bottom:3px">权限策略 (${policies.length})</div><div style="display:flex;flex-wrap:wrap;gap:4px">${policies.map(p => {
            const shortName = p.replace(/^arn:[^:]+:iam::[^:]*:policy\//, '');
            return `<span style="font-size:10px;background:var(--g100);color:var(--g600);padding:1px 6px;border-radius:10px" title="${esc(p)}">${esc(shortName)}</span>`;
          }).join('')}</div></div>`
        : '';
      const groupHtml = groups.length > 0
        ? `<div style="margin-top:4px"><div style="font-size:10px;color:var(--g400);margin-bottom:3px">用户组 (${groups.length})</div><div style="display:flex;flex-wrap:wrap;gap:4px">${groups.map(g => {
            return `<span style="font-size:10px;background:#e3f2fd;color:#1565c0;padding:1px 6px;border-radius:10px">${esc(g)}</span>`;
          }).join('')}</div></div>`
        : '';
      const timeLabel = acc.synced_at
        ? `同步时间：${acc.synced_at.slice(0, 16)}`
        : `创建时间：${(acc.created_at || '').slice(0, 16)}`;
      const enterBtn = !isViewingOther
        ? `<button class="btn-ghost" style="font-size:11px;padding:2px 8px;margin-left:auto" onclick="ssoLogin('${acc.platform}')">进入控制台</button>`
        : '';
      html += `<div style="padding:10px;background:var(--g50);border-radius:6px;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
          <span class="badge badge-${badgeColor}">${esc(pname)}</span>
          <code style="font-size:12px;background:var(--card);padding:2px 6px;border-radius:4px">${esc(acc.cloud_username)}</code>
          ${sourceTag}
          ${enterBtn}
        </div>
        ${policyHtml}
        ${groupHtml}
        <div style="font-size:11px;color:var(--g400);margin-top:5px">${timeLabel}</div>
      </div>`;
    });
  }
  html += `</div>`;

  // VPN 账号卡片
  html += `<div class="card" style="padding:18px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">
      <span style="font-size:15px;font-weight:600">🔐 VPN 账号</span>
      <span class="badge badge-info">${vpn_accounts.length}</span>
    </div>`;
  if (vpn_accounts.length === 0) {
    html += `<div style="color:var(--g400);font-size:13px">暂无 VPN 账号</div>`;
  } else {
    vpn_accounts.forEach(vpn => {
      const pname = PLABEL[vpn.platform] || vpn.platform;
      html += `<div style="padding:10px;background:var(--g50);border-radius:6px;margin-bottom:8px">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <span class="badge badge-${vpn.platform === 'aws' ? 'warn' : vpn.platform === 'aliyun' ? 'info' : 'ok'}">${esc(pname)}</span>
          <span style="font-size:13px;font-weight:600">${esc(vpn.client_name || vpn.clientName || '-')}</span>
        </div>
        <div style="display:grid;grid-template-columns:auto 1fr;gap:2px 10px;font-size:12px;color:var(--g600)">
          ${vpn.client_id || vpn.clientId ? `<span style="color:var(--g400)">客户端 ID</span><span><code style="background:var(--g100);padding:1px 5px;border-radius:3px;font-size:11px">${esc(vpn.client_id || vpn.clientId)}</code></span>` : ''}
          ${vpn.server_name || vpn.serverName ? `<span style="color:var(--g400)">服务端</span><span>${esc(vpn.server_name || vpn.serverName)}</span>` : ''}
          ${vpn.region ? `<span style="color:var(--g400)">地域</span><span>${esc(vpn.region)}</span>` : ''}
        </div>
      </div>`;
    });
  }
  html += `</div>`;

  html += `</div>`;

  // 统计信息 + 同步按钮
  html += `<div class="card" style="margin-top:16px;padding:16px;background:var(--g50)">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
      <div style="display:flex;align-items:center;gap:20px;font-size:13px;color:var(--g600)">
        <span>📊 已通过工单：<strong>${ticket_count?.approved || 0}</strong> 个</span>
        <span>👤 用户：<strong>${esc(user.real_name || user.email)}</strong></span>
        <span>📧 邮箱：<strong>${esc(user.email)}</strong></span>
        ${user.cloud_username ? `<span>🔑 云账号名：<strong>${esc(user.cloud_username)}</strong></span>` : ''}
      </div>
      <button class="btn-ghost" style="font-size:12px;padding:4px 12px" onclick="syncAndReloadProfile('${targetUserId}')">↻ 同步权限</button>
    </div>
  </div>`;

  wrap.innerHTML = html;
}

async function syncAndReloadProfile(userId) {
  const btn = document.querySelector('[onclick^="syncAndReloadProfile"]');
  if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
  // 只同步当前这个人在各云的账号权限，而非全平台
  const r = await post(`/sync/user/${userId}`, {});
  if (r.ok) {
    const results = r.data.results || [];
    const ok = results.filter(x => x.success);
    const fail = results.filter(x => !x.success);
    if (r.data.message) {
      toast(r.data.message, 'warn');
    } else if (fail.length) {
      toast(`部分同步失败：${fail.map(f => `${f.platform} ${f.message || ''}`).join('；')}`, fail.length === results.length ? 'err' : 'warn');
    } else {
      toast(`已同步 ${ok.length} 个平台的权限`, 'ok');
    }
  } else {
    toast(r.data?.error || '同步失败', 'err');
  }
  await loadMyProfile(userId);
}

async function ssoLogin(platform) {
  const r = await get(`/sso/${platform}/login-url`);
  if (!r.ok) {
    toast(r.data?.error || '获取登录地址失败', 'err');
    return;
  }
  const { url, method } = r.data;
  if (!url) {
    toast('该平台未配置登录地址', 'warn');
    return;
  }
  window.open(url, '_blank');
}

