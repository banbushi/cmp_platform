// ═══════════════════════════════════════════════════════════════
// HTTP 工具函数
// ═══════════════════════════════════════════════════════════════

async function get(path) {
  try {
    const res = await fetch(API + path, {
      headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: { error: err.message } };
  }
}

async function post(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('token')}`
    },
    body: JSON.stringify(body)
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

async function del(path) {
  const res = await fetch(API + path, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${localStorage.getItem('token')}` }
  });
  let data = {};
  try {
    data = await res.json();
  } catch (_) {}
  return { ok: res.ok, status: res.status, data };
}

async function patch(path, body) {
  const res = await fetch(API + path, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('token')}`
    },
    body: JSON.stringify(body)
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}

async function put(path, body) {
  const res = await fetch(API + path, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('token')}`
    },
    body: JSON.stringify(body)
  });
  return { ok: res.ok, status: res.status, data: await res.json() };
}
