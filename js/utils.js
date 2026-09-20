// ═══════════════════════════════════════════════════════════════
// 通用工具函数
// ═══════════════════════════════════════════════════════════════

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function toast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast show ' + type;
  setTimeout(() => t.classList.remove('show'), 3000);
}

function platformBadge(p) {
  const name = PNAMES[p] || p;
  return `<span class="platform-badge platform-${p}">${esc(name)}</span>`;
}

function checkPassword(pw) {
  if (!pw || pw.length < 8) return '密码至少8位';
  if (!/[A-Z]/.test(pw)) return '密码须包含大写字母';
  if (!/[a-z]/.test(pw)) return '密码须包含小写字母';
  if (!/[0-9]/.test(pw)) return '密码须包含数字';
  return null;
}

// ── 平台显示辅助 ──
const PCOLORS = { aws: '#FF9900', aliyun: '#FF6A00', baidu: '#2932E1' };
const PSHORT  = { aws: 'AWS', aliyun: '阿里云', baidu: '百度云' };

function _platPill(platform) {
  return `<span class="platform-pill" style="background:${PCOLORS[platform] || '#6B7280'}">${PSHORT[platform] || platform}</span>`;
}

function _syncTime(t) {
  return t ? `<span style="color:var(--g400);font-size:12px;white-space:nowrap">${new Date(t).toLocaleString('zh-CN')}</span>` : '-';
}

// ── 通用分页 HTML 生成器 ──
// goFn/setSizeFn 为函数名字符串，prefixArgs 为逗号前置参数（如 "'sg'"），可选
function _buildPagination(total, currentPage, pageSize, goFn, setSizeFn, prefixArgs) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  let pages = [];
  const p = currentPage;
  const pre = prefixArgs ? prefixArgs + ', ' : '';
  if (totalPages <= 7) {
    pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  } else if (p <= 4) {
    pages = [1, 2, 3, 4, 5, '…', totalPages];
  } else if (p >= totalPages - 3) {
    pages = [1, '…', totalPages-4, totalPages-3, totalPages-2, totalPages-1, totalPages];
  } else {
    pages = [1, '…', p-1, p, p+1, '…', totalPages];
  }
  const pageBtns = pages.map(n =>
    n === '…'
      ? `<span class="pg-btn" style="cursor:default;border:none">…</span>`
      : `<button class="pg-btn ${n === p ? 'active' : ''}" onclick="${goFn}(${pre}${n})">${n}</button>`
  ).join('');
  const sizeOpts = [10, 20, 50, 100].map(s =>
    `<option value="${s}" ${s === pageSize ? 'selected' : ''}>${s} 条/页</option>`
  ).join('');
  return `<div class="pagination">
    <span class="pagination-info">共 ${total} 条，第 ${p} / ${totalPages} 页</span>
    <div class="pagination-btns">
      <button class="pg-btn" onclick="${goFn}(${pre}${p-1})" ${p <= 1 ? 'disabled' : ''}>‹ 上一页</button>
      ${pageBtns}
      <button class="pg-btn" onclick="${goFn}(${pre}${p+1})" ${p >= totalPages ? 'disabled' : ''}>下一页 ›</button>
      <select class="pg-size-select" onchange="${setSizeFn}(${pre}+this.value)">${sizeOpts}</select>
    </div>
  </div>`;
}
