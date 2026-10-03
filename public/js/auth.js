// ═══════════════════════════════════════════════════════════════
// 认证模块：登录、登出、初始化
// ═══════════════════════════════════════════════════════════════

window.addEventListener('hashchange', () => {
  const section = location.hash.match(/^#section=(.+)$/)?.[1];
  if (section && token) navTo(section);
});

window.onload = async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const feishuToken = urlParams.get('feishu_token');
  const feishuError = urlParams.get('error');
  if (feishuToken) {
    token = feishuToken;
    localStorage.setItem('token', token);
    window.history.replaceState({}, '', window.location.pathname);
  }
  if (feishuError) {
    window.history.replaceState({}, '', window.location.pathname);
  }

  if (token) {
    const ok = await fetchMe();
    if (ok) {
      showMain();
    } else {
      showLogin();
      if (feishuError) document.getElementById('login-err').textContent = decodeURIComponent(feishuError);
    }
  } else {
    showLogin();
    if (feishuError) document.getElementById('login-err').textContent = decodeURIComponent(feishuError);
  }
};

function showLogin() {
  document.getElementById('login-page').classList.remove('hidden');
  document.getElementById('main-layout').classList.add('hidden');
}

async function showMain() {
  document.getElementById('login-page').classList.add('hidden');
  document.getElementById('main-layout').classList.remove('hidden');
  document.getElementById('nav-name').textContent = me.name;
  document.getElementById('nav-avatar').textContent = me.name[0].toUpperCase();
  await loadAndApplyPermissions();
  initLogo();
  _restoreNavGroups();
  _restoreSidebarCollapsed();
  checkProfileCompletion();

  // 根据角色权限决定默认页面，避免闪现无权限页面
  const fallback = defaultSection();
  let targetSection = fallback;

  const hashSection = location.hash.match(/^#section=(.+)$/)?.[1];
  const lastSection = localStorage.getItem('lastSection');
  const requestedSection = hashSection || lastSection || fallback;

  // 检查请求的页面是否有权限访问（lastSection 可能是改角色前留下的旧页面）
  if (requestedSection !== 'overview' && requestedSection !== 'my-profile' && requestedSection !== 'perm-query' && _myRoleData) {
    if (!roleHasSection(_myRoleData, requestedSection)) {
      targetSection = fallback; // 无权限，回到该角色的默认页
    } else {
      targetSection = requestedSection;
    }
  } else {
    targetSection = requestedSection;
  }

  navTo(targetSection);
}

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-err');
  errEl.textContent = '';
  if (!email || !password) {
    errEl.textContent = '请输入邮箱和密码';
    return;
  }
  try {
    const r = await post('/accounts/login', { email, password });
    if (r.ok) {
      token = r.data.token;
      me = r.data.user;
      localStorage.setItem('token', token);
      showMain();
    } else {
      errEl.textContent = r.data.error || '登录失败';
    }
  } catch {
    errEl.textContent = '网络错误';
  }
}

function toggleSystemLogin() {
  const form = document.getElementById('system-login-form');
  const toggle = document.getElementById('toggle-system-login');
  const opened = form.classList.toggle('hidden') === false;
  toggle.textContent = opened ? '收起' : '账号密码登录';
  if (opened) document.getElementById('login-email').focus();
}

async function feishuLogin() {
  const btn = document.getElementById('btn-feishu-login');
  const note = document.getElementById('feishu-login-note');
  const errEl = document.getElementById('login-err');
  btn.disabled = true;
  note.classList.remove('hidden');
  errEl.textContent = '';
  try {
    const res = await fetch('/api/feishu/oauth/url');
    const data = await res.json();
    if (data.url) {
      window.location.href = data.url;
    } else {
      throw new Error(data.error || '飞书登录不可用');
    }
  } catch (e) {
    btn.disabled = false;
    note.classList.add('hidden');
    errEl.textContent = e.message;
  }
}

function logout() {
  token = null;
  me = null;
  localStorage.removeItem('token');
  showLogin();
}

async function fetchMe() {
  try {
    const r = await get('/accounts/me');
    if (r.ok) {
      me = r.data.user;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
