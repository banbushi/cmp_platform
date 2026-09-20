// ─────────────────────────────────────────
// 账号同步
// ─────────────────────────────────────────
async function loadSyncStatus() {
  const r = await get('/sync/status');
  if (!r.ok) return;
  const { status } = r.data;
  const PNAMES_SHORT = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
  for (const [p, s] of Object.entries(status)) {
    const totalEl = document.getElementById(`sync-total-${p}`);
    const managedEl = document.getElementById(`sync-managed-${p}`);
    const lastEl = document.getElementById(`sync-last-${p}`);
    const credEl = document.getElementById(`sync-status-${p}`);
    if (totalEl) totalEl.textContent = s.total > 0 ? s.total : (s.last_sync ? s.total : '-');
    if (managedEl) managedEl.textContent = s.total > 0 ? s.managed : '-';
    if (lastEl) lastEl.textContent = s.last_sync ? `最后同步：${new Date(s.last_sync).toLocaleString('zh-CN')}` : '未同步';
    if (credEl) credEl.textContent = s.has_cred ? '已配置' : '未配置凭据';
  }
}


async function syncPlatform(platform) {
  const PNAMES_LABEL = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云', jumpserver: 'JumpServer', kuboard: 'Kuboard', all: '全部平台', 'third-all': '全部工具平台' };
  const label = PNAMES_LABEL[platform] || platform;

  const THIRD_PLATFORMS = ['jumpserver', 'kuboard', 'third-all'];
  const loadingEl = document.getElementById(THIRD_PLATFORMS.includes(platform) ? 'third-acc-sync-loading' : 'cloud-acc-sync-loading');
  if (loadingEl) loadingEl.classList.remove('hidden');

  toast(`正在同步 ${label}...`);

  const r = await post(`/sync/${platform}`, {});

  if (loadingEl) loadingEl.classList.add('hidden');

  if (r.ok) {
    const results = r.data.results || [];
    const nameOf = p => PNAMES_LABEL[p] || p;
    const msgs = results.map(x => x.success ? `${nameOf(x.platform)} 同步 ${x.count} 个账号` : `${nameOf(x.platform)}: ${x.message}`);
    toast(msgs.join(' | '), results.every(x => x.success) ? 'ok' : 'err');
    await loadSyncStatus();
    if (THIRD_PLATFORMS.includes(platform)) {
      if (typeof loadThirdAccounts === 'function') await loadThirdAccounts();
    } else {
      if (typeof loadAccounts === 'function') await loadAccounts();
      if (platform === 'all' && typeof loadThirdAccounts === 'function') await loadThirdAccounts();
    }
  } else {
    toast('同步失败: ' + (r.data.error || '未知错误'), 'err');
  }
}


// ─────────────────────────────────────────
