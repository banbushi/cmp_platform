// ─────────────────────────────────────────
// 云平台配置
// ─────────────────────────────────────────
function switchIntegrationTab(name, el) {
  ['cloud', 'feishu'].forEach(t => {
    document.getElementById(`itab-${t}`)?.classList.toggle('hidden', t !== name);
  });
  document.querySelectorAll('#sec-settings .filter-tab').forEach(b => b.classList.remove('active'));
  if (el) {
    el.classList.add('active');
  } else {
    document.querySelector(`#sec-settings .filter-tab[onclick*="'${name}'"]`)?.classList.add('active');
  }
}

// ── Bytebase 多实例管理 ─────────────────────────────────────────
async function loadBytebaseInstances() {
  const wrap = document.getElementById('bytebase-instances-list');
  if (!wrap) return;
  wrap.innerHTML = '<div class="empty-tip">加载中...</div>';
  const r = await get('/bytebase/instances');
  if (!r.ok) { wrap.innerHTML = `<div class="empty-tip">加载失败：${esc(r.data?.error || '')}</div>`; return; }
  const list = r.data.instances || [];
  if (!list.length) { wrap.innerHTML = '<div class="empty-tip">暂无实例，点右上角「+ 添加实例」</div>'; return; }
  wrap.innerHTML = `
    <table class="acc-table">
      <thead><tr><th>名称</th><th>地址</th><th>CF 防护</th><th>状态</th><th style="text-align:right">操作</th></tr></thead>
      <tbody>${list.map(i => {
        const cf = i.cf_client_id ? '<span class="badge badge-ok" style="font-size:10px;padding:1px 7px;border-radius:10px">已配置</span>' : '<span style="color:var(--g400);font-size:12px">无</span>';
        const st = i.enabled ? '<span class="badge badge-ok" style="font-size:10px;padding:1px 7px;border-radius:10px">启用</span>' : '<span class="badge" style="background:var(--g100);color:var(--g500);font-size:10px;padding:1px 7px;border-radius:10px">停用</span>';
        return `<tr>
          <td><strong>${esc(i.name)}</strong></td>
          <td style="color:var(--g600);font-size:12px">${esc(i.base_url)}</td>
          <td>${cf}</td>
          <td>${st}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn-ghost btn-sm" onclick='showBytebaseInstanceModal(${JSON.stringify(i)})'>编辑</button>
            <button class="btn-ghost btn-sm btn-danger" style="margin-left:4px" onclick="deleteBytebaseInstance('${i.id}','${esc(i.name)}')">删除</button>
          </td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

function showBytebaseInstanceModal(inst) {
  const isEdit = inst && inst.id;
  document.getElementById('bb-modal-title').textContent = isEdit ? '编辑 Bytebase 实例' : '添加 Bytebase 实例';
  document.getElementById('bb-inst-id').value = isEdit ? inst.id : '';
  document.getElementById('bb-inst-name').value = isEdit ? inst.name : '';
  document.getElementById('bb-inst-url').value = isEdit ? inst.base_url : '';
  document.getElementById('bb-inst-email').value = isEdit ? (inst.service_account_email || '') : '';
  document.getElementById('bb-inst-token').value = '';
  document.getElementById('bb-inst-cfid').value = isEdit ? (inst.cf_client_id || '') : '';
  document.getElementById('bb-inst-cfsecret').value = '';
  // 编辑时 token/secret 留空表示不修改
  document.getElementById('bb-inst-token-hint').textContent = isEdit ? '（留空表示不修改）' : '';
  document.getElementById('bb-inst-cfsecret-hint').textContent = isEdit ? '（留空表示不修改）' : '（可选）';
  document.getElementById('bb-inst-err').textContent = '';
  document.getElementById('bytebase-instance-modal').classList.remove('hidden');
}

function closeBytebaseInstanceModal() {
  document.getElementById('bytebase-instance-modal').classList.add('hidden');
}

function _bbInstPayload() {
  return {
    name: document.getElementById('bb-inst-name').value.trim(),
    base_url: document.getElementById('bb-inst-url').value.trim(),
    service_account_email: document.getElementById('bb-inst-email').value.trim(),
    token: document.getElementById('bb-inst-token').value.trim(),
    cf_client_id: document.getElementById('bb-inst-cfid').value.trim(),
    cf_client_secret: document.getElementById('bb-inst-cfsecret').value.trim(),
  };
}

async function submitBytebaseInstance() {
  const errEl = document.getElementById('bb-inst-err');
  errEl.textContent = '';
  const id = document.getElementById('bb-inst-id').value;
  const payload = _bbInstPayload();
  if (!payload.name) { errEl.textContent = '请填写实例名称'; return; }
  if (!payload.base_url) { errEl.textContent = '请填写 Bytebase 地址'; return; }
  if (!payload.service_account_email) { errEl.textContent = '请填写服务账号邮箱'; return; }
  if (!id && !payload.token) { errEl.textContent = '请填写 Service Account Key'; return; }

  const r = id
    ? await put(`/bytebase/instances/${id}`, payload)
    : await post('/bytebase/instances', payload);
  if (r.ok) { toast(id ? '实例已更新' : '实例已添加', 'ok'); closeBytebaseInstanceModal(); loadBytebaseInstances(); }
  else errEl.textContent = r.data?.error || '保存失败';
}

async function testBytebaseInstance(btn) {
  const errEl = document.getElementById('bb-inst-err');
  const setMsg = (text, ok) => { errEl.textContent = text; errEl.style.color = ok ? 'var(--success, #16a34a)' : ''; };
  setMsg('', false);
  const id = document.getElementById('bb-inst-id').value;
  const payload = _bbInstPayload();
  // 编辑时若未填 token，用已存库的（传 id 让后端取）
  const body = (id && !payload.token) ? { id } : payload;
  if (!body.id && (!body.base_url || !body.token)) { setMsg('请填写地址和 Token 后再测试', false); return; }

  // 就地反馈：按钮转 loading + 弹窗内显示结果，避免只靠角落 toast 被忽略
  const el = btn || (typeof event !== 'undefined' && event?.target);
  const oldText = el ? el.textContent : '';
  if (el) { el.disabled = true; el.textContent = '测试中...'; }
  setMsg('正在测试连接...', true);
  try {
    const r = await post('/bytebase/instances/test', body);
    if (r.ok) { setMsg('✓ ' + (r.data.message || '连接成功'), true); toast(r.data.message || '连接成功', 'ok'); }
    else { setMsg('✗ ' + (r.data?.error || '连接失败'), false); }
  } catch (e) {
    setMsg('✗ 请求失败：' + (e.message || '网络错误'), false);
  } finally {
    if (el) { el.disabled = false; el.textContent = oldText; }
  }
}

async function deleteBytebaseInstance(id, name) {
  if (!confirm(`确定删除 Bytebase 实例「${name}」吗？\n已开通的账号不受影响，但后续申请将无法选择该实例。`)) return;
  const r = await del(`/bytebase/instances/${id}`);
  if (r.ok) { toast('实例已删除', 'ok'); loadBytebaseInstances(); }
  else toast(r.data?.error || '删除失败', 'err');
}

async function loadSettings() {
  const r = await get('/cloud/credentials');
  if (!r.ok) return;
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  r.data.credentials.forEach(c => {
    credStatus[c.platform] = true;
    const el = document.getElementById(`cred-status-${c.platform}`);
    if (el) { el.textContent = '已配置'; el.className = 'cred-status configured'; }

    // 回填非密钥字段（密钥/token/secret 不回显）。注意各平台字段复用了不同的 DB 列：
    //   aws/aliyun/baidu：access_key=AK ID，region=区域，ssh_key_name=密钥对名
    //   jumpserver：region=URL，access_key=KeyID
    //   kuboard/grafana-*：access_key=URL
    if (c.platform === 'aws' || c.platform === 'aliyun' || c.platform === 'baidu') {
      const P = { aws: 'aws', aliyun: 'ali', baidu: 'bai' }[c.platform];
      setVal(`s-${P}-ak`, c.access_key);
      setVal(`s-${P}-region`, c.region);
      setVal(`s-${P}-ssh-key`, c.ssh_key_name);
    } else if (c.platform === 'jumpserver') {
      setVal('s-js-url', c.region);
      setVal('s-js-ak', c.access_key);
    } else if (c.platform === 'kuboard') {
      setVal('s-kb-url', c.access_key);
      setVal('s-kb-username', c.account_name);
      setVal('s-kb-cfid', c.cf_client_id);
      const hint = document.getElementById('s-kb-cfsecret-hint');
      if (hint) hint.textContent = c.has_cf_secret ? '（留空表示不修改）' : '（可选）';
    } else if (c.platform.startsWith('grafana')) {
      setVal(`s-${c.platform}-url`, c.access_key);
    }
  });
  const allPlatforms = ['aws', 'aliyun', 'baidu', 'jumpserver', 'kuboard', 'grafana-aws', 'grafana-wuwen', 'grafana-baidu'];
  allPlatforms.forEach(p => {
    if (!credStatus[p]) {
      const el = document.getElementById(`cred-status-${p}`);
      if (el) { el.textContent = '未配置'; el.className = 'cred-status not-configured'; }
    }
  });
  loadFeishuConfig();
}

async function saveCred(platform) {
  const akMap = { aws: 's-aws-ak', aliyun: 's-ali-ak', baidu: 's-bai-ak', jumpserver: 's-js-ak', kuboard: 's-kb-url', 'grafana-aws': 's-grafana-aws-url', 'grafana-wuwen': 's-grafana-wuwen-url', 'grafana-baidu': 's-grafana-baidu-url' };
  const skMap = { aws: 's-aws-sk', aliyun: 's-ali-sk', baidu: 's-bai-sk', jumpserver: 's-js-sk', kuboard: 's-kb-token', 'grafana-aws': 's-grafana-aws-token', 'grafana-wuwen': 's-grafana-wuwen-token', 'grafana-baidu': 's-grafana-baidu-token' };
  const rgMap = { aws: 's-aws-region', aliyun: 's-ali-region', baidu: 's-bai-region', jumpserver: 's-js-url' };
  const access_key = document.getElementById(akMap[platform])?.value.trim();
  let secret_key = document.getElementById(skMap[platform])?.value.trim();
  const region = document.getElementById(rgMap[platform])?.value.trim() || '';
  if (platform === 'jumpserver') {
    if (!region || !access_key || !secret_key) {
      toast('请填写 JumpServer 地址、Access Key ID 和 Secret Key', 'err'); return;
    }
  } else if (platform === 'kuboard') {
    // Kuboard 访问密钥分两段（密钥ID + 密钥），拼成 id.secret 作为 KuboardAccessKey
    const keyId = document.getElementById('s-kb-keyid')?.value.trim() || '';
    if (!access_key) { toast('请填写 Kuboard 地址', 'err'); return; }
    if (!keyId || !secret_key) { toast('请填写 Kuboard 访问密钥 ID 和访问密钥', 'err'); return; }
    if (!document.getElementById('s-kb-username')?.value.trim()) {
      toast('请填写 Kuboard 登录用户名（生成访问密钥的账号）', 'err'); return;
    }
    secret_key = `${keyId}.${secret_key}`;
  } else if (['grafana-aws', 'grafana-wuwen', 'grafana-baidu'].includes(platform)) {
    if (!access_key || !secret_key) {
      toast('请填写 Grafana 地址和 API Key', 'err'); return;
    }
  } else if (!access_key || !secret_key) {
    toast('请填写 Access Key 和 Secret Key', 'err'); return;
  }
  const body = { platform, access_key, secret_key, region };
  // SSH Key Name（仅 aws/aliyun/baidu）
  const sshKeyMap = { aws: 's-aws-ssh-key', aliyun: 's-ali-ssh-key', baidu: 's-bai-ssh-key' };
  if (sshKeyMap[platform]) {
    body.ssh_key_name = document.getElementById(sshKeyMap[platform])?.value.trim() || '';
  }
  // Cloudflare Access 凭据 + 登录用户名（仅 kuboard；secret 留空=保留原值）
  if (platform === 'kuboard') {
    body.account_name = document.getElementById('s-kb-username')?.value.trim() || '';
    body.cf_client_id = document.getElementById('s-kb-cfid')?.value.trim() || '';
    body.cf_client_secret = document.getElementById('s-kb-cfsecret')?.value.trim() || '';
  }
  const r = await post('/cloud/credentials', body);
  if (r.ok) {
    toast('配置保存成功', 'ok');
    credStatus[platform] = true;
    loadSettings();
  } else {
    toast(r.data.error || '保存失败', 'err');
  }
}

async function updateAdminProfile() {
  const curPw = document.getElementById('admin-cur-pw').value;
  const newEmail = document.getElementById('admin-new-email').value.trim();
  const newPw = document.getElementById('admin-new-pw').value;
  const confirmPw = document.getElementById('admin-confirm-pw').value;
  const errEl = document.getElementById('admin-profile-err');
  errEl.textContent = '';

  if (!curPw) { errEl.textContent = '请填写当前密码'; return; }
  if (newPw && newPw !== confirmPw) { errEl.textContent = '两次输入的新密码不一致'; return; }
  if (!newEmail && !newPw) { errEl.textContent = '请至少填写新邮箱或新密码之一'; return; }

  const body = { current_password: curPw };
  if (newEmail) body.new_email = newEmail;
  if (newPw) body.new_password = newPw;

  const r = await fetch(API + '/accounts/me', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('token')}` },
    body: JSON.stringify(body)
  });
  const data = await r.json();

  if (r.ok) {
    // 更新本地 token 和邮箱
    localStorage.setItem('token', data.token);
    if (me) me.email = data.email;
    // 清空表单
    ['admin-cur-pw', 'admin-new-email', 'admin-new-pw', 'admin-confirm-pw'].forEach(id => {
      document.getElementById(id).value = '';
    });
    toast('账号信息已更新', 'ok');
  } else {
    errEl.textContent = data.error || '修改失败';
  }
}

async function deleteCred(platform) {  if (!confirm(`确认删除 ${PNAMES[platform]} 的主账号凭据？`)) return;
  const r = await del(`/cloud/credentials/${platform}`);
  if (r.ok) {
    toast('凭据已删除', 'ok');
    credStatus[platform] = false;
    loadSettings();
  }
}

async function testCred(platform) {
  const akMap = { aws: 's-aws-ak', aliyun: 's-ali-ak', baidu: 's-bai-ak', jumpserver: 's-js-ak', kuboard: 's-kb-url', 'grafana-aws': 's-grafana-aws-url', 'grafana-wuwen': 's-grafana-wuwen-url', 'grafana-baidu': 's-grafana-baidu-url' };
  const skMap = { aws: 's-aws-sk', aliyun: 's-ali-sk', baidu: 's-bai-sk', jumpserver: 's-js-sk', kuboard: 's-kb-token', 'grafana-aws': 's-grafana-aws-token', 'grafana-wuwen': 's-grafana-wuwen-token', 'grafana-baidu': 's-grafana-baidu-token' };
  const rgMap = { aws: 's-aws-region', aliyun: 's-ali-region', baidu: 's-bai-region', jumpserver: 's-js-url' };

  const access_key = document.getElementById(akMap[platform])?.value.trim();
  let secret_key = document.getElementById(skMap[platform])?.value.trim();
  const region = document.getElementById(rgMap[platform])?.value.trim() || '';

  // Kuboard 访问密钥分两段（密钥ID + 密钥），拼成 id.secret
  if (platform === 'kuboard') {
    const keyId = document.getElementById('s-kb-keyid')?.value.trim() || '';
    if (!access_key || !keyId || !secret_key) { toast('请先填写 Kuboard 地址、访问密钥 ID 和访问密钥', 'err'); return; }
    secret_key = `${keyId}.${secret_key}`;
  } else if (!access_key || !secret_key) {
    toast('请先填写凭据信息', 'err'); return;
  }

  const body = { platform, access_key, secret_key, region };
  // Kuboard：带上登录用户名 + CF 凭据（secret/用户名 留空则后端用已存库的）
  if (platform === 'kuboard') {
    body.account_name = document.getElementById('s-kb-username')?.value.trim() || '';
    body.cf_client_id = document.getElementById('s-kb-cfid')?.value.trim() || '';
    body.cf_client_secret = document.getElementById('s-kb-cfsecret')?.value.trim() || '';
  }
  toast('正在测试连接...', 'info');
  const r = await post('/cloud/credentials/test', body);

  if (r.ok && r.data.success) {
    toast(`${PNAMES[platform] || platform} 连接成功`, 'ok');
  } else {
    toast(`连接失败：${r.data?.message || r.data?.error || '未知错误'}`, 'err');
  }
}

// ─────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────
function platformBadge(p) {
  const labels = { aws: 'AWS', aliyun: '阿里', baidu: '百度', bytebase: 'Bytebase', jumpserver: 'JS', kuboard: 'KB', 'grafana-aws': 'GF-AWS', 'grafana-wuwen': 'GF-无问', 'grafana-baidu': 'GF-百度' };
  const cls = { aws: 'aws-bg', aliyun: 'ali-bg', baidu: 'bai-bg', bytebase: 'bb-bg' }[p] || '';
  const style = p === 'jumpserver' ? ' style="background:#e65c00;color:#fff"' : p === 'kuboard' ? ' style="background:#0052cc;color:#fff"' : p === 'grafana-aws' ? ' style="background:#ff6f00;color:#fff"' : p === 'grafana-wuwen' ? ' style="background:#2e7d32;color:#fff"' : p === 'grafana-baidu' ? ' style="background:#1565c0;color:#fff"' : '';
  return `<span class="cloud-badge ${cls}"${style}>${labels[p] || p}</span>`;
}

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

let toastTimer;
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ─────────────────────────────────────────
// OAuth Client 管理
// ─────────────────────────────────────────
async function loadOAuthClients() {
  const wrap = document.getElementById('oauth-clients-list');
  if (!wrap) return;
  const r = await get('/oauth/clients');
  if (!r.ok) { wrap.innerHTML = '<div style="color:var(--g400);font-size:13px">加载失败</div>'; return; }
  const clients = r.data.clients || [];
  if (!clients.length) {
    wrap.innerHTML = '<div style="color:var(--g400);font-size:13px">暂无 OAuth Client，点击右上角"新建"创建</div>';
    return;
  }
  wrap.innerHTML = clients.map(c => `<div style="padding:12px;background:var(--g50);border-radius:6px;margin-bottom:8px">
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
      <strong style="font-size:13px">${esc(c.name)}</strong>
      ${c.platform ? `<span class="badge badge-info" style="font-size:10px">${esc(c.platform)}</span>` : ''}
      <button class="btn-danger" style="font-size:10px;padding:2px 6px;margin-left:auto" onclick="deleteOAuthClient('${c.id}')">删除</button>
    </div>
    <div style="font-size:12px;color:var(--g600);display:grid;grid-template-columns:auto 1fr;gap:2px 10px">
      <span style="color:var(--g400)">Client ID</span><code style="background:var(--g100);padding:1px 4px;border-radius:3px;font-size:11px">${esc(c.client_id)}</code>
      <span style="color:var(--g400)">回调地址</span><span style="font-size:11px">${esc(c.redirect_uri)}</span>
    </div>
  </div>`).join('');
}

function showCreateOAuthClient() {
  const name = prompt('Client 名称（如：JumpServer SSO）');
  if (!name) return;
  const platform = prompt('关联平台标识（如：jumpserver、grafana-aws，可留空）') || '';
  const redirect_uri = prompt('回调地址（如：https://jumpserver.example.com/core/auth/oauth2/callback/）');
  if (!redirect_uri) { toast('回调地址不能为空', 'err'); return; }
  createOAuthClient(name, platform, redirect_uri);
}

async function createOAuthClient(name, platform, redirect_uri) {
  const r = await post('/oauth/clients', { name, platform, redirect_uri });
  if (r.ok) {
    const d = r.data;
    alert(`OAuth Client 创建成功！\n\nClient ID: ${d.client_id}\nClient Secret: ${d.client_secret}\n\n请妥善保存 Secret，此后不再显示。`);
    loadOAuthClients();
  } else {
    toast(r.data?.error || '创建失败', 'err');
  }
}

async function deleteOAuthClient(id) {
  if (!confirm('确认删除该 OAuth Client？关联的 SSO 登录将失效。')) return;
  const r = await del(`/oauth/clients/${id}`);
  if (r.ok) { toast('已删除', 'ok'); loadOAuthClients(); }
  else toast('删除失败', 'err');
}
