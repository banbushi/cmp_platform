const mysql = require('mysql2/promise');

const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error('  ✗ 缺少数据库环境变量:', missing.join(', '));
  process.exit(1);
}

const pool = mysql.createPool({
  host:               process.env.DB_HOST,
  port:               parseInt(process.env.DB_PORT || '3306', 10),
  user:               process.env.DB_USER,
  password:           process.env.DB_PASSWORD,
  database:           process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
  charset:            'utf8mb4',
  dateStrings:        true,
  connectTimeout:     10000,
  enableKeepAlive:    true,
  keepAliveInitialDelay: 10000,
});

(async () => {
  try {
    const conn = await pool.getConnection();
    conn.release();
    console.log('  ✓ MySQL 数据库连接成功');
  } catch (err) {
    console.error('  ✗ MySQL 连接失败:', err.message);
    process.exit(1);
  }
})();

module.exports = {
  async get(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows[0] || null;
  },
  async all(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows;
  },
  async run(sql, params = []) {
    const [result] = await pool.query(sql, params);
    return result;
  }
};
