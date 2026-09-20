'use strict';
const express = require('express');
const db = require('../utils/database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

/** GET /api/apply-config — 读取申请项可见性配置（任何登录用户可读，申请页需要） */
router.get('/', authenticate, async (req, res) => {
  const row = await db.get('SELECT config FROM apply_visibility_config WHERE id = 1');
  let config = {};
  try { config = JSON.parse(row?.config || '{}'); } catch { config = {}; }
  res.json({ config });
});

/** PUT /api/apply-config — 保存配置（仅管理员） */
router.put('/', authenticate, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '只有管理员可以修改申请项配置' });
  const { config } = req.body || {};
  if (config === undefined || config === null || typeof config !== 'object') {
    return res.status(400).json({ error: '缺少 config 或格式错误' });
  }
  await db.run(
    'UPDATE apply_visibility_config SET config = ?, updated_at = NOW() WHERE id = 1',
    [JSON.stringify(config)]
  );
  res.json({ ok: true });
});

module.exports = router;
