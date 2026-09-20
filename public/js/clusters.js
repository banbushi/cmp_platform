// ─────────────────────────────────────────
// 容器集群管理
// ─────────────────────────────────────────

let allClusters = [];
let filteredClusters = [];
let clusterFilter = 'all';

async function loadClusters() {
  document.getElementById('cluster-loading').classList.remove('hidden');
  const r = await get('/clusters');
  document.getElementById('cluster-loading').classList.add('hidden');

  if (!r.ok) {
    toast('加载集群失败: ' + (r.data?.error || '未知错误'), 'err');
    return;
  }

  allClusters = r.data.clusters || [];
  filteredClusters = allClusters;
  renderClusterStats();
  renderClusterTable();
}

function renderClusterStats() {
  const awsCount = allClusters.filter(c => c.platform === 'aws').length;
  const aliyunCount = allClusters.filter(c => c.platform === 'aliyun').length;
  const baiduCount = allClusters.filter(c => c.platform === 'baidu').length;

  document.getElementById('cluster-count-aws').textContent = awsCount;
  document.getElementById('cluster-count-aliyun').textContent = aliyunCount;
  document.getElementById('cluster-count-baidu').textContent = baiduCount;
}

function renderClusterTable() {
  const wrap = document.getElementById('cluster-table-wrap');
  if (!filteredClusters.length) {
    wrap.innerHTML = '<div class="empty-tip">暂无集群数据</div>';
    return;
  }

  const PLATFORM_LABEL = { aws: 'AWS EKS', aliyun: '阿里云 ACK', baidu: '百度云 CCE' };
  const PLATFORM_COLOR = { aws: '#FF9900', aliyun: '#FF6A00', baidu: '#2932E1' };

  const rows = filteredClusters.map(c => {
    const platformLabel = PLATFORM_LABEL[c.platform] || c.platform;
    const platformColor = PLATFORM_COLOR[c.platform] || 'var(--g500)';
    return `
      <tr>
        <td>
          <div style="display:inline-block;padding:2px 8px;border-radius:4px;background:${platformColor}15;color:${platformColor};font-size:11px;font-weight:600">
            ${esc(platformLabel)}
          </div>
        </td>
        <td style="font-weight:600;color:var(--g900)">${esc(c.cluster_name || '-')}</td>
        <td style="font-family:monospace;font-size:12px;color:var(--g600)">${esc(c.cluster_id || '-')}</td>
        <td>${esc(c.region || '-')}</td>
        <td>
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;background:${c.status === 'ACTIVE' || c.status === 'running' ? '#10b98115' : '#f59e0b15'};color:${c.status === 'ACTIVE' || c.status === 'running' ? '#10b981' : '#f59e0b'};font-size:11px;font-weight:600">
            ${esc(c.status || '-')}
          </span>
        </td>
        <td>${esc(c.k8s_version || '-')}</td>
        <td style="text-align:center;font-weight:600;color:var(--g900)">${c.node_count || 0}</td>
        <td style="color:var(--g500);font-size:12px">${c.synced_at ? c.synced_at.slice(0, 16).replace('T', ' ') : '-'}</td>
      </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="sync-table-container"><table class="sync-table" style="min-width:1000px">
      <thead>
        <tr>
          <th style="width:80px">云平台</th>
          <th style="width:180px">集群名称</th>
          <th style="width:220px">集群 ID</th>
          <th style="width:130px">区域</th>
          <th style="width:90px">状态</th>
          <th style="width:110px">K8s 版本</th>
          <th style="width:70px;text-align:center">节点数</th>
          <th style="width:120px;white-space:nowrap">同步时间</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function setClusterFilter(filter, btn) {
  clusterFilter = filter;
  document.querySelectorAll('.sync-filter-tabs .filter-tab').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  applyClusterFilter();
}

function onClusterSearch() {
  applyClusterFilter();
}

function applyClusterFilter() {
  const keyword = document.getElementById('cluster-keyword')?.value.trim().toLowerCase() || '';

  filteredClusters = allClusters.filter(c => {
    if (clusterFilter !== 'all' && c.platform !== clusterFilter) return false;
    if (keyword) {
      const name = (c.cluster_name || '').toLowerCase();
      const id = (c.cluster_id || '').toLowerCase();
      if (!name.includes(keyword) && !id.includes(keyword)) return false;
    }
    return true;
  });

  renderClusterTable();
}

async function syncClusters(platform) {
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = '同步中...'; }

  const loading = document.getElementById('cluster-loading');
  const platformLabel = { aws: 'AWS EKS', aliyun: '阿里云 ACK', baidu: '百度云 CCE' }[platform] || platform;
  if (loading) {
    loading.innerHTML = `<div class="spin"></div> 正在同步 ${platformLabel} 集群...`;
    loading.classList.remove('hidden');
  }

  try {
    const r = await post(`/clusters/sync/${platform}`);
    if (loading) loading.classList.add('hidden');

    if (!r.ok) {
      toast('同步失败: ' + (r.data?.error || '未知错误'), 'err');
      return;
    }

    const results = r.data.results || [];
    const result = results[0];
    if (result && !result.success) {
      toast(`同步失败: ${result.message}`, 'err');
    } else {
      const count = results.reduce((s, x) => s + (x.count || 0), 0);
      toast(`${platformLabel} 同步完成，共 ${count} 个集群`, 'ok');
    }
    loadClusters();
  } catch (e) {
    if (loading) loading.classList.add('hidden');
    toast('同步异常: ' + (e.message || '网络错误'), 'err');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = { aws: '↻ 同步 AWS', aliyun: '↻ 同步阿里云', baidu: '↻ 同步百度云' }[platform] || '↻ 同步';
    }
  }
}

// ── 集群页 Tab 切换（集群列表 / 业务组管理） ──
let _clTab = 'list';

function clTabSwitch(tab) {
  _clTab = tab;
  ['list', 'groups'].forEach(t => {
    const btn = document.getElementById(`cl-tab-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
    const content = document.getElementById(`cl-tab-${t}-content`);
    if (content) content.style.display = t === tab ? '' : 'none';
  });
  if (tab === 'groups') _clLoadGroups();
}

// ── 业务组管理 ──
async function _clLoadGroups() {
  const wrap = document.getElementById('cl-groups-wrap');
  if (!wrap) return;
  wrap.innerHTML = '<div class="sync-loading"><div class="spin"></div> 加载中...</div>';
  const r = await get('/clusters/groups');
  if (!r.ok) { wrap.innerHTML = `<div class="empty-tip">加载失败: ${esc(r.data?.error || '')}</div>`; return; }
  const groups = r.data.groups || [];
  const header = `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
    <span style="font-size:12px;color:var(--g400)">共 ${groups.length} 个业务组</span>
    <button class="btn-primary btn-sm perm-operate" onclick="_clShowGroupCreate()">+ 新建业务组</button>
  </div>`;
  if (!groups.length) {
    wrap.innerHTML = header + '<div class="empty-tip">暂无业务组，请先创建</div>';
    return;
  }
  const rows = groups.map(g => `<tr>
    <td style="font-weight:500">${esc(g.name)}</td>
    <td style="font-size:12px;color:var(--g500)">${esc(g.description || '-')}</td>
    <td style="font-size:13px">${g.cluster_count || 0} 个集群</td>
    <td class="perm-operate" style="white-space:nowrap">
      <button class="btn-ghost btn-sm" style="padding:2px 10px;font-size:12px" onclick="_clEditGroup('${esc(g.id)}')">编辑</button>
      <button class="btn-ghost btn-sm" style="padding:2px 10px;font-size:12px;color:var(--err,#dc2626)" onclick="_clDeleteGroup('${esc(g.id)}','${esc(g.name.replace(/'/g,''))}')">删除</button>
    </td>
  </tr>`).join('');
  wrap.innerHTML = header + `<table class="acc-table"><thead><tr>
    <th>业务组</th><th>描述</th><th>关联集群</th><th class="perm-operate">操作</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

async function _clDeleteGroup(id, name) {
  if (!confirm(`确定删除业务组「${name}」？关联关系也会移除。`)) return;
  const r = await del(`/clusters/groups/${encodeURIComponent(id)}`);
  if (!r.ok) { toast(r.data?.error || '删除失败', 'err'); return; }
  toast('已删除', 'ok');
  _clLoadGroups();
}

// 创建/编辑业务组弹窗
async function _clShowGroupCreate(editId) {
  let modal = document.getElementById('modal-cl-group');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'modal-cl-group';
    modal.className = 'modal-overlay hidden';
    modal.onclick = () => modal.classList.add('hidden');
    modal.innerHTML = `<div class="modal" style="width:520px;max-width:95vw" onclick="event.stopPropagation()">
      <div class="modal-header"><h3 id="cl-grp-title">新建业务组</h3><button class="modal-close" onclick="document.getElementById('modal-cl-group').classList.add('hidden')">✕</button></div>
      <div style="display:flex;flex-direction:column;gap:14px">
        <div class="field"><label>名称 <span class="req">*</span></label><input type="text" id="cl-grp-name" placeholder="如 AI / Infra / tripo" style="margin-top:6px"></div>
        <div class="field"><label>描述</label><input type="text" id="cl-grp-desc" placeholder="业务组用途描述" style="margin-top:6px"></div>
        <div class="field">
          <label>关联集群（多选）</label>
          <div id="cl-grp-clusters" style="margin-top:6px;max-height:200px;overflow:auto;border:1px solid var(--g200);border-radius:6px;padding:8px">加载中...</div>
        </div>
        <div id="cl-grp-err" class="err-text"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end">
          <button class="btn-ghost" onclick="document.getElementById('modal-cl-group').classList.add('hidden')">取消</button>
          <button class="btn-primary" id="cl-grp-submit" onclick="_clSubmitGroup()">创建</button>
        </div>
      </div></div>`;
    document.body.appendChild(modal);
  }
  // 重置
  document.getElementById('cl-grp-name').value = '';
  document.getElementById('cl-grp-desc').value = '';
  document.getElementById('cl-grp-err').textContent = '';
  document.getElementById('cl-grp-title').textContent = editId ? '编辑业务组' : '新建业务组';
  document.getElementById('cl-grp-submit').textContent = editId ? '保存' : '创建';
  document.getElementById('cl-grp-submit').dataset.editId = editId || '';
  modal.classList.remove('hidden');
  // 加载全部集群列表
  const cr = await get('/clusters');
  const clusters = cr.ok ? (cr.data.clusters || []) : [];
  let checkedIds = new Set();
  // 编辑模式：回填
  if (editId) {
    const dr = await get(`/clusters/groups/${editId}`);
    if (dr.ok && dr.data) {
      document.getElementById('cl-grp-name').value = dr.data.group?.name || '';
      document.getElementById('cl-grp-desc').value = dr.data.group?.description || '';
      (dr.data.clusters || []).forEach(c => checkedIds.add(c.cluster_id));
    }
  }
  const box = document.getElementById('cl-grp-clusters');
  box.innerHTML = clusters.length ? clusters.map(c => `
    <label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;font-size:12px">
      <input type="checkbox" class="cl-grp-cluster-cb" value="${esc(c.cluster_id)}" ${checkedIds.has(c.cluster_id) ? 'checked' : ''}>
      <span style="font-weight:500">${esc(c.cluster_name)}</span>
      <span style="color:var(--g400)">${esc(c.platform)} · ${esc(c.region || '')}</span>
    </label>`).join('') : '<div style="color:var(--g400)">暂无集群，请先同步</div>';
}

function _clEditGroup(id) { _clShowGroupCreate(id); }

async function _clSubmitGroup() {
  const errEl = document.getElementById('cl-grp-err');
  errEl.textContent = '';
  const name = document.getElementById('cl-grp-name').value.trim();
  const description = document.getElementById('cl-grp-desc').value.trim();
  if (!name) { errEl.textContent = '请填写名称'; return; }
  const cluster_ids = Array.from(document.querySelectorAll('.cl-grp-cluster-cb:checked')).map(cb => cb.value);
  const editId = document.getElementById('cl-grp-submit').dataset.editId;
  const btn = document.getElementById('cl-grp-submit');
  btn.disabled = true;
  let r;
  if (editId) {
    r = await put(`/clusters/groups/${editId}`, { name, description, cluster_ids });
  } else {
    r = await post('/clusters/groups', { name, description, cluster_ids });
  }
  btn.disabled = false;
  if (!r.ok) { errEl.textContent = r.data?.error || '操作失败'; return; }
  toast(editId ? '已更新' : '已创建', 'ok');
  document.getElementById('modal-cl-group').classList.add('hidden');
  _clLoadGroups();
}
