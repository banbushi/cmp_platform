let _fbFormVisible = false;

function loadFeedback() {
  renderFeedbackForm();
  loadFeedbackList();
}

function renderFeedbackForm() {
  const area = document.getElementById('feedback-form-area');
  area.innerHTML = `
    <div class="card" style="padding:20px 24px;margin-bottom:24px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${_fbFormVisible ? '16px' : '0'}">
        <div style="display:flex;align-items:center;gap:10px">
          <span style="font-size:20px">💡</span>
          <span style="font-size:14px;font-weight:500;color:var(--g700)">有建议或发现问题？</span>
        </div>
        <button class="btn-primary" style="font-size:13px;padding:6px 16px" onclick="toggleFeedbackForm()">
          ${_fbFormVisible ? '收起' : '写反馈'}
        </button>
      </div>
      ${_fbFormVisible ? `
      <div style="border-top:1px solid var(--border);padding-top:16px">
        <div style="display:grid;grid-template-columns:1fr 160px;gap:12px;margin-bottom:12px">
          <div>
            <label style="display:block;font-size:12px;font-weight:500;color:var(--g600);margin-bottom:4px">标题 <span style="color:var(--danger)">*</span></label>
            <input id="fb-title" type="text" placeholder="一句话描述您的建议或问题" maxlength="200"
              style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:13px;outline:none;box-sizing:border-box">
          </div>
          <div>
            <label style="display:block;font-size:12px;font-weight:500;color:var(--g600);margin-bottom:4px">分类</label>
            <select id="fb-category" style="width:100%;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:13px;outline:none;background:#fff">
              <option value="suggestion">💡 功能建议</option>
              <option value="bug">🐛 问题反馈</option>
              <option value="other">📋 其他</option>
            </select>
          </div>
        </div>
        <div style="margin-bottom:12px">
          <label style="display:block;font-size:12px;font-weight:500;color:var(--g600);margin-bottom:4px">详细描述</label>
          <textarea id="fb-description" rows="4" placeholder="详细说明您的建议或遇到的问题，描述越清楚越容易被采纳"
            style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:6px;font-size:13px;outline:none;resize:vertical;box-sizing:border-box;font-family:inherit"></textarea>
        </div>
        <div style="margin-bottom:16px">
          <label style="display:block;font-size:12px;font-weight:500;color:var(--g600);margin-bottom:6px">截图（可选，最多5张，支持粘贴）</label>
          <div id="fb-upload-area" style="border:2px dashed var(--border);border-radius:8px;padding:20px;text-align:center;cursor:pointer;transition:border-color .2s"
            onclick="document.getElementById('fb-files').click()"
            ondragover="event.preventDefault();this.style.borderColor='var(--primary)'"
            ondragleave="this.style.borderColor='var(--border)'"
            ondrop="handleFileDrop(event)">
            <div style="color:var(--g400);font-size:13px">
              <span style="font-size:24px;display:block;margin-bottom:6px">📎</span>
              点击选择图片或拖拽到此处
            </div>
            <input type="file" id="fb-files" accept="image/*" multiple style="display:none" onchange="previewFiles(event)">
          </div>
          <div id="fb-previews" style="display:flex;gap:10px;flex-wrap:wrap;margin-top:10px"></div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:10px">
          <button class="btn-ghost" style="font-size:13px;padding:7px 16px" onclick="toggleFeedbackForm()">取消</button>
          <button class="btn-primary" style="font-size:13px;padding:7px 20px" onclick="submitFeedback()">提交反馈</button>
        </div>
      </div>` : ''}
    </div>`;
}

function toggleFeedbackForm() {
  _fbFormVisible = !_fbFormVisible;
  renderFeedbackForm();
}

async function loadFeedbackList() {
  const loading = document.getElementById('feedback-loading');
  const list = document.getElementById('feedback-list');
  loading.classList.remove('hidden');

  try {
    const res = await get('/feedback');
    if (!res.ok) { list.innerHTML = ''; return; }
    const feedbacks = res.data?.feedbacks || [];

    if (feedbacks.length === 0) {
      list.innerHTML = `<div style="text-align:center;padding:48px 20px;color:var(--g400)">
        <div style="font-size:36px;margin-bottom:12px">📭</div>
        <div>暂无反馈记录</div>
      </div>`;
    } else {
      list.innerHTML = `<div style="font-size:13px;font-weight:600;color:var(--g600);margin-bottom:12px">历史反馈</div>`
        + feedbacks.map(f => renderFeedbackCard(f)).join('');
    }
  } catch (err) {
    list.innerHTML = '';
  } finally {
    loading.classList.add('hidden');
  }
}

function renderFeedbackCard(f) {
  const categoryMap = { suggestion: '💡 建议', bug: '🐛 缺陷', other: '📋 其他' };
  const statusColors = { pending: { bg: '#fef3cd', color: '#856404' }, resolved: { bg: '#d4edda', color: '#155724' } };
  const statusLabels = { pending: '待处理', resolved: '已处理' };
  const screenshots = (() => {
    if (!f.screenshots) return [];
    if (Array.isArray(f.screenshots)) return f.screenshots;
    try { return JSON.parse(f.screenshots); } catch { return []; }
  })();
  const isAdmin = me?.role === 'admin';
  const sc = statusColors[f.status] || statusColors.pending;
  const expandId = `fb-expand-${f.id}`;

  return `
    <div class="card" style="padding:16px 20px;margin-bottom:12px;cursor:pointer" onclick="toggleFeedbackDetail('${f.id}')">
      <div style="display:flex;align-items:start;justify-content:space-between;gap:12px">
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
            <span style="font-size:14px;font-weight:600;color:var(--g800)">${esc(f.title)}</span>
            <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:${sc.bg};color:${sc.color}">${statusLabels[f.status] || f.status}</span>
            <span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--g100);color:var(--g600)">${categoryMap[f.category] || f.category}</span>
          </div>
          <div style="font-size:12px;color:var(--g400);display:flex;gap:12px">
            ${isAdmin && f.real_name ? `<span>${esc(f.real_name)}</span>` : ''}
            <span>${f.created_at || ''}</span>
          </div>
        </div>
        ${isAdmin && f.status === 'pending' ? `<button class="btn-ghost" style="font-size:12px;padding:4px 12px;white-space:nowrap" onclick="event.stopPropagation();openReplyModal('${f.id}')">回复</button>` : ''}
      </div>
      <div id="${expandId}" style="display:none;margin-top:12px;padding-top:12px;border-top:1px solid var(--g100)">
        ${f.description ? `<div style="font-size:13px;color:var(--g700);line-height:1.6;white-space:pre-wrap;margin-bottom:12px">${esc(f.description)}</div>` : ''}
        ${screenshots.length > 0 ? `
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">
            ${screenshots.map(s => `<img src="${esc(s)}" onclick="event.stopPropagation();window.open('${esc(s)}','_blank')" style="height:120px;border-radius:6px;cursor:pointer;border:1px solid var(--g200);object-fit:cover" />`).join('')}
          </div>` : ''}
        ${f.admin_reply ? `
          <div style="padding:10px 14px;background:var(--g50);border-radius:6px;border-left:3px solid var(--primary)">
            <div style="font-size:11px;color:var(--g500);margin-bottom:4px">管理员回复</div>
            <div style="font-size:13px;color:var(--g700);white-space:pre-wrap">${esc(f.admin_reply)}</div>
          </div>` : ''}
      </div>
    </div>`;
}

function toggleFeedbackDetail(id) {
  const el = document.getElementById(`fb-expand-${id}`);
  if (!el) return;
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

function handleFileDrop(e) {
  e.preventDefault();
  e.currentTarget.style.borderColor = 'var(--border)';
  const input = document.getElementById('fb-files');
  const dt = new DataTransfer();
  Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/')).slice(0, 5).forEach(f => dt.items.add(f));
  input.files = dt.files;
  previewFiles({ target: input });
}

function previewFiles(e) {
  const files = Array.from(e.target.files).slice(0, 5);
  const container = document.getElementById('fb-previews');
  if (!container) return;
  if (!files.length) { container.innerHTML = ''; return; }
  container.innerHTML = files.map((f, i) => `
    <div style="position:relative;width:80px;height:80px;border-radius:6px;overflow:hidden;border:1px solid var(--g200)">
      <img src="${URL.createObjectURL(f)}" style="width:100%;height:100%;object-fit:cover" />
      <button onclick="removePreview(${i})" style="position:absolute;top:2px;right:2px;background:rgba(0,0,0,.6);color:#fff;border:none;border-radius:50%;width:18px;height:18px;cursor:pointer;font-size:11px;line-height:18px;text-align:center">×</button>
    </div>`).join('');
}

function removePreview(index) {
  const input = document.getElementById('fb-files');
  const dt = new DataTransfer();
  Array.from(input.files).forEach((f, i) => { if (i !== index) dt.items.add(f); });
  input.files = dt.files;
  previewFiles({ target: input });
}

async function submitFeedback() {
  const title = document.getElementById('fb-title')?.value.trim();
  const category = document.getElementById('fb-category')?.value;
  const description = document.getElementById('fb-description')?.value.trim();
  const files = document.getElementById('fb-files')?.files;

  if (!title) { toast('请填写标题', 'err'); return; }

  const formData = new FormData();
  formData.append('title', title);
  formData.append('category', category);
  formData.append('description', description);
  if (files) Array.from(files).forEach(f => formData.append('screenshots', f));

  try {
    const res = await fetch(API + '/feedback', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + localStorage.getItem('token') },
      body: formData
    });
    const data = await res.json();
    if (res.ok) {
      toast('反馈提交成功，感谢您的建议！', 'ok');
      _fbFormVisible = false;
      renderFeedbackForm();
      loadFeedbackList();
    } else {
      toast(data.error || '提交失败', 'err');
    }
  } catch (err) {
    toast('提交失败: ' + err.message, 'err');
  }
}

function openReplyModal(id) {
  const overlay = document.createElement('div');
  overlay.id = 'modal-fb-reply';
  overlay.className = 'modal-overlay';
  overlay.onclick = () => overlay.remove();
  overlay.innerHTML = `
    <div class="modal" style="width:480px;max-width:90vw;padding:0" onclick="event.stopPropagation()">
      <div style="padding:16px 20px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center">
        <h3 style="margin:0;font-size:15px">回复反馈</h3>
        <button style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--g400)" onclick="document.getElementById('modal-fb-reply').remove()">×</button>
      </div>
      <div style="padding:20px">
        <textarea id="fb-reply-text" rows="5" placeholder="填写处理结果或回复内容"
          style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:6px;font-size:13px;outline:none;resize:vertical;box-sizing:border-box;font-family:inherit"></textarea>
      </div>
      <div style="padding:12px 20px;border-top:1px solid var(--border);display:flex;justify-content:flex-end;gap:10px">
        <button class="btn-ghost" style="font-size:13px" onclick="document.getElementById('modal-fb-reply').remove()">取消</button>
        <button class="btn-primary" style="font-size:13px" onclick="submitReply('${id}')">提交回复</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

async function submitReply(id) {
  const reply = document.getElementById('fb-reply-text')?.value.trim();
  if (!reply) { toast('请填写回复内容', 'err'); return; }

  const res = await put(`/feedback/${id}/reply`, { reply, status: 'resolved' });
  if (res.ok) {
    toast('回复成功', 'ok');
    document.getElementById('modal-fb-reply')?.remove();
    loadFeedbackList();
  } else {
    toast(res.data?.error || '回复失败', 'err');
  }
}