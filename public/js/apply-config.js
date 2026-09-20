// ─────────────────────────────────────────
// 申请项配置（管理员控制账号申请平台 / 资源申请资源类型的展示）
// ─────────────────────────────────────────

// 账号申请分三类：云账号 / VPN 账号 / 平台工具账号
const AC_CLOUD_PLATFORMS = ['aws', 'aliyun', 'baidu'];
const AC_VPN_PLATFORMS   = ['aliyun', 'baidu'];
const AC_TOOL_PLATFORMS  = ['jumpserver', 'bytebase', 'kuboard', 'grafana-aws', 'grafana-wuwen', 'grafana-baidu'];

function _acItem(checked, onchange, label, sub) {
  return `<label class="group-checkbox-item" style="cursor:pointer">
    <input type="checkbox" ${checked ? 'checked' : ''} ${onchange}>
    <span class="group-checkbox-name">${esc(label)}</span>
    ${sub ? `<span class="group-checkbox-count">${esc(sub)}</span>` : ''}
  </label>`;
}

async function loadApplyConfig() {
  await refreshApplyVisibility();

  // 云账号（aws/aliyun/baidu，account 键）
  const cloudWrap = document.getElementById('ac-cloud-switches');
  if (cloudWrap) {
    cloudWrap.innerHTML = `<div class="group-checkbox-list">${
      AC_CLOUD_PLATFORMS.map(p => _acItem(
        isAccountPlatformVisible(p),
        `data-ac-account="${p}"`,
        PNAMES[p] || p
      )).join('')
    }</div>`;
  }

  // VPN 账号（aliyun/baidu，vpn 键）
  const vpnWrap = document.getElementById('ac-vpn-switches');
  if (vpnWrap) {
    const VLABEL = { aliyun: '阿里云 VPN', baidu: '百度云 VPN' };
    vpnWrap.innerHTML = `<div class="group-checkbox-list">${
      AC_VPN_PLATFORMS.map(p => _acItem(
        isVpnPlatformVisible(p),
        `data-ac-vpn="${p}"`,
        VLABEL[p]
      )).join('')
    }</div>`;
  }

  // 平台工具账号（jumpserver/bytebase/kuboard/grafana-*，account 键）
  const toolWrap = document.getElementById('ac-tool-switches');
  if (toolWrap) {
    toolWrap.innerHTML = `<div class="group-checkbox-list">${
      AC_TOOL_PLATFORMS.map(p => _acItem(
        isAccountPlatformVisible(p),
        `data-ac-account="${p}"`,
        PNAMES[p] || p
      )).join('')
    }</div>`;
  }

  // 功能入口开关（feature 键，控制菜单项是否展示）
  const featWrap = document.getElementById('ac-feature-switches');
  if (featWrap) {
    featWrap.innerHTML = `<div class="group-checkbox-list">${
      Object.entries(FEATURE_SECTIONS).map(([section, label]) => _acItem(
        isFeatureVisible(section),
        `data-ac-feature="${section}"`,
        label
      )).join('')
    }</div>`;
  }

  // 资源申请资源类型开关（按云平台分组）
  const resWrap = document.getElementById('ac-resource-switches');
  if (resWrap) {
    const PLABEL = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
    resWrap.innerHTML = ['aws', 'aliyun', 'baidu'].map(platform => {
      const resources = AR_CLOUD_RESOURCES[platform] || [];
      return `<div style="margin-bottom:16px">
        <div style="font-size:13px;font-weight:600;color:var(--g700);margin-bottom:8px">${PLABEL[platform]}</div>
        <div class="group-checkbox-list">${
          resources.map(r => _acItem(
            isResourceTypeVisible(platform, r.id),
            `data-ac-resource="${platform}:${r.id}"`,
            r.label
          )).join('')
        }</div>
      </div>`;
    }).join('');
  }
}

async function saveApplyConfig() {
  const config = { account: {}, resource: {}, vpn: {}, feature: {} };

  document.querySelectorAll('[data-ac-account]').forEach(el => {
    config.account[el.dataset.acAccount] = el.checked;
  });
  document.querySelectorAll('[data-ac-vpn]').forEach(el => {
    config.vpn[el.dataset.acVpn] = el.checked;
  });
  document.querySelectorAll('[data-ac-feature]').forEach(el => {
    config.feature[el.dataset.acFeature] = el.checked;
  });
  document.querySelectorAll('[data-ac-resource]').forEach(el => {
    const [platform, type] = el.dataset.acResource.split(':');
    if (!config.resource[platform]) config.resource[platform] = {};
    config.resource[platform][type] = el.checked;
  });

  const r = await put('/apply-config', { config });
  if (r.ok) {
    _applyVis = { account: config.account, resource: config.resource, vpn: config.vpn, feature: config.feature };
    applyFeatureVisibility();
    toast('申请项配置已保存', 'ok');
  } else {
    toast(r.data?.error || '保存失败', 'err');
  }
}
