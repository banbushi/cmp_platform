// ─────────────────────────────────────────
// 组同步
// ─────────────────────────────────────────
async function loadGroups() {
  const keyword  = document.getElementById('group-keyword')?.value.trim() || '';
  const platform = groupFilter === 'all' ? '' : groupFilter;
  const params   = new URLSearchParams();
  if (platform) params.set('platform', platform);
  if (keyword)  params.set('keyword', keyword);
  const r = await get(`/sync/groups?${params}`);
  if (!r.ok) return;
  _grpFiltered = r.data.groups || [];
  _grpPage = 1;
  _renderGroupsPage();
}

function _renderGroupsPage() {
  const wrap = document.getElementById('groups-table-wrap');
  const total = _grpFiltered.length;
  if (!total) {
    wrap.innerHTML = '<div class="empty-tip">暂无用户组数据，请点击右上角「同步」或「创建用户组」</div>';
    return;
  }
  const totalPages = Math.max(1, Math.ceil(total / _grpPageSize));
  if (_grpPage > totalPages) _grpPage = totalPages;
  const start = (_grpPage - 1) * _grpPageSize;
  const groups = _grpFiltered.slice(start, start + _grpPageSize);
  renderGroupsTable(groups, total);
}

function renderGroupsTable(groups, total) {
  const wrap = document.getElementById('groups-table-wrap');
  const PCOLORS = { aws: '#FF9900', aliyun: '#FF6A00', baidu: '#2932E1' };
  const PSHORT  = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
  wrap.innerHTML = `
    <div class="sync-table-container"><table class="sync-table" style="min-width:700px">
      <thead><tr>
        <th style="width:80px">云平台</th><th style="width:180px">组名</th><th style="width:160px">显示名</th><th style="width:80px">成员数</th><th style="width:140px;white-space:nowrap">最后同步</th><th style="width:80px">操作</th>
      </tr></thead>
      <tbody>${groups.map(g => `<tr>
        <td><span class="platform-pill" style="background:${PCOLORS[g.platform] || '#6B7280'}">${PSHORT[g.platform] || g.platform}</span></td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(g.group_name)}"><strong>${esc(g.group_name)}</strong></td>
        <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(g.display_name||g.group_name)}">${esc(g.display_name || g.group_name)}</td>
        <td><button class="member-count-btn" onclick='showGroupMembers(${JSON.stringify(g.platform)},${JSON.stringify(g.group_name)},${JSON.stringify(g.display_name||g.group_name)})'>${g.member_count} 人 ›</button></td>
        <td style="color:var(--g400);font-size:12px;white-space:nowrap">${g.synced_at ? new Date(g.synced_at).toLocaleString('zh-CN') : '-'}</td>
        <td class="perm-operate"><button class="btn-ghost btn-sm btn-danger" onclick='deleteGroup(${JSON.stringify(g.platform)},${JSON.stringify(g.group_name)})'>删除</button></td>
      </tr>`).join('')}</tbody>
    </table></div>
    ${_buildPagination(total, _grpPage, _grpPageSize, '_goGrpPage', '_setGrpPageSize')}`;
}

function _goGrpPage(n) {
  const totalPages = Math.max(1, Math.ceil(_grpFiltered.length / _grpPageSize));
  _grpPage = Math.min(Math.max(1, n), totalPages);
  _renderGroupsPage();
}
function _setGrpPageSize(size) {
  _grpPageSize = size;
  _grpPage = 1;
  _renderGroupsPage();
}

function showGroupCreateModal() {
  document.getElementById('gc-name').value = '';
  document.getElementById('gc-display').value = '';
  document.getElementById('gc-desc').value = '';
  document.getElementById('gc-err').textContent = '';
  ['gc-aws','gc-aliyun','gc-baidu'].forEach(id => { document.getElementById(id).checked = false; });
  document.getElementById('modal-group-create').classList.remove('hidden');
}
function closeGroupCreateModal() {
  document.getElementById('modal-group-create').classList.add('hidden');
}

async function submitGroupCreate() {
  const group_name  = document.getElementById('gc-name').value.trim();
  const display_name = document.getElementById('gc-display').value.trim();
  const description = document.getElementById('gc-desc').value.trim();
  const platforms   = ['gc-aws','gc-aliyun','gc-baidu']
    .filter(id => document.getElementById(id).checked)
    .map(id => document.getElementById(id).value);
  const err = document.getElementById('gc-err');
  err.textContent = '';
  if (!group_name) { err.textContent = '请填写组名'; return; }
  if (!platforms.length) { err.textContent = '请至少选择一个云平台'; return; }

  const r = await post('/sync/groups/create', { group_name, display_name, description, platforms });
  if (r.ok) {
    const results = r.data.results || [];
    const failed  = results.filter(x => !x.success);
    const ok      = results.filter(x => x.success);
    if (failed.length) {
      const PSHORT = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
      err.textContent = failed.map(x => `${PSHORT[x.platform] || x.platform}: ${x.message}`).join('；');
    }
    if (ok.length) {
      toast(`用户组「${group_name}」已在 ${ok.map(x=>({aws:'AWS',aliyun:'阿里云',baidu:'百度云'})[x.platform]).join('、')} 创建成功`, 'ok');
      closeGroupCreateModal();
      loadGroups();
    }
  } else {
    err.textContent = r.data.error || '创建失败';
  }
}

async function deleteGroup(platform, groupName) {
  const PSHORT = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };
  if (!confirm(`确定删除 ${PSHORT[platform] || platform} 上的用户组「${groupName}」？\n组内成员将被移出，但用户账号本身不会删除。`)) return;
  try {
    const r = await del(`/sync/groups/${encodeURIComponent(platform)}/${encodeURIComponent(groupName)}`);
    if (r.ok) {
      toast(`用户组「${groupName}」已删除`, 'ok');
      loadGroups();
    } else {
      toast('删除失败: ' + (r.data.error || '未知错误'), 'err');
    }
  } catch (e) {
    toast('删除失败: ' + e.message, 'err');
  }
}

async function syncGroups(platform) {
  const LABELS = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云', all: '全部平台' };
  const loadingEl = document.getElementById('groups-loading');
  const wrapEl    = document.getElementById('groups-table-wrap');
  if (loadingEl) loadingEl.classList.remove('hidden');
  if (wrapEl)    wrapEl.innerHTML = '';
  toast(`正在同步 ${LABELS[platform]} 用户组...`);
  const r = await post(`/sync/groups/${platform}`, {});
  if (loadingEl) loadingEl.classList.add('hidden');
  if (r.ok) {
    const msgs = (r.data.results || []).map(res =>
      res.success ? `${PNAMES[res.platform] || res.platform}: 同步 ${res.count} 个组` : `${res.platform}: ${res.message}`
    );
    toast(msgs.join(' | '), (r.data.results || []).every(res => res.success) ? 'ok' : 'err');
    await loadGroups();
  } else {
    toast('同步失败: ' + (r.data.error || '未知错误'), 'err');
  }
}

function setGroupFilter(filter, btn) {
  groupFilter = filter;
  btn.closest('.sec').querySelectorAll('.filter-tab').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  loadGroups();
}

// ─────────────────────────────────────────
