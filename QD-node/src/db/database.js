// 本文件负责初始化 Redis 客户端和 MySQL 连接池，并导出给各接口模块使用。
const redis = require('redis');
const mysql = require('mysql2/promise'); 
const { logger } = require('../config/log');

// Redis 连接只从环境变量读取；本地默认值不包含认证信息。
// 生产环境请通过 REDIS_URL 注入，例如 redis://:密码@主机:6379。
const redisClient = redis.createClient({
  url: process.env.REDIS_URL || 'redis://127.0.0.1:6379'
});

// Redis 错误回调函数：连接或命令异常时写入错误日志。
redisClient.on('error', (err) => logger.error('Redis 连接错误:', err));

// Redis 启动连接函数：由 server.js 在服务启动阶段显式调用，连接成功后再开放 HTTP 服务。
async function connectRedis() {
  // 已连接时直接返回，避免重复 connect 抛错。
  if (redisClient.isOpen) return;
  // Redis 是 nonce、二维码 token 和刷新冷却的核心依赖，连接失败应阻止服务启动。
  await redisClient.connect();
  logger.info('Redis 连接成功.');
}

// MySQL 连接只从环境变量读取；默认值仅用于本地示例环境。
const db = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'qiandao_demo',
  port: Number(process.env.DB_PORT) || 3306,
  dateStrings: true,
});

/// 检查数据库连接
db.getConnection()
  // 数据库连接成功回调函数：确认连接池可用后释放连接。
  .then(connection => {
    logger.info('成功连接到数据库');
    connection.release();
  })
  // 数据库连接失败回调函数：记录启动阶段的数据库连接错误。
  .catch(err => {
    logger.error('连接数据库失败:', err);
  });

module.exports = {
  redisClient,
  db,
  connectRedis
};
