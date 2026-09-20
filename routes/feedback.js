const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const db = require('../utils/database');
const { authenticate } = require('../middleware/auth');

router.post('/', authenticate, async (req, res) => {
  try {
    const { title, description, category } = req.body;
    if (!title || !title.trim()) return res.status(400).json({ error: '请填写标题' });

    const id = uuidv4();
    let screenshots = [];

    if (req.files && req.files.screenshots) {
      const files = Array.isArray(req.files.screenshots) ? req.files.screenshots : [req.files.screenshots];
      for (const file of files) {
        const ext = path.extname(file.name) || '.png';
        const filename = `${uuidv4()}${ext}`;
        const savePath = path.join(__dirname, '../public/uploads/feedback', filename);
        await file.mv(savePath);
        screenshots.push(`/uploads/feedback/${filename}`);
      }
    }

    await db.run(
      `INSERT INTO platform_feedback (id, user_id, title, description, category, screenshots, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', NOW())`,
      [id, req.user.id, title.trim(), description || '', category || 'suggestion', JSON.stringify(screenshots)]
    );

    res.json({ ok: true, id });
  } catch (err) {
    res.status(500).json({ error: '提交失败: ' + err.message });
  }
});

router.get('/', authenticate, async (req, res) => {
  try {
    const isAdmin = req.user.role === 'admin';
    const sql = isAdmin
      ? `SELECT f.*, u.real_name, u.name as username FROM platform_feedback f LEFT JOIN users u ON f.user_id = u.id ORDER BY f.created_at DESC`
      : `SELECT * FROM platform_feedback WHERE user_id = ? ORDER BY created_at DESC`;
    const rows = isAdmin ? await db.all(sql) : await db.all(sql, [req.user.id]);
    res.json({ feedbacks: rows });
  } catch (err) {
    res.status(500).json({ error: '查询失败: ' + err.message });
  }
});

router.put('/:id/reply', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可回复' });
  const { reply, status } = req.body;
  if (!reply || !reply.trim()) return res.status(400).json({ error: '请填写回复内容' });

  await db.run(
    `UPDATE platform_feedback SET admin_reply = ?, status = ? WHERE id = ?`,
    [reply.trim(), status || 'resolved', req.params.id]
  );
  res.json({ ok: true });
});

module.exports = router;
