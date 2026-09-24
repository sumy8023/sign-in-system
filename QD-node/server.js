// 本文件是后端服务入口：初始化 Express、中间件、学生端静态页面和各业务路由模块。
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const { logger, setupRequestLogger } = require('./src/config/log');
const timeProvider = require('./src/config/time');
const { setServerPort, registerToolRoutes, startOnlineCleanupTask, ensureOnlineSessionTable } = require('./src/config/shared');
const { connectRedis } = require('./src/db/database');
const registerUserRoutes = require('./src/api/user');
const registerStudentRoutes = require('./src/api/student');
const registerAdminRoutes = require('./src/api/admin');
const registerExcelRoutes = require('./src/api/excel');

// 服务基础配置：PORT 控制监听端口，STUDENT_WEB_DIR 控制学生端静态页面目录。
const PORT = Number(process.env.PORT) || 4800;
const STUDENT_WEB_DIR = process.env.STUDENT_WEB_DIR || path.join(process.cwd(), 'student');
const app = express();
setServerPort(PORT);

// 全局中间件：开启跨域、JSON 请求体解析和请求日志。
app.use(cors()); // 配置跨域
app.use(express.json()); // 支持 JSON 请求体
setupRequestLogger(app);

// 学生端入口：把 /student 统一跳转到 /student/，避免静态页面相对路径异常。
app.get(['/student', '/student/'], (req, res, next) => {
  if (req.path !== '/student') return next();
  const queryIndex = req.originalUrl.indexOf('?');
  const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
  res.redirect(302, `/student/${query}`);
});

// 学生端静态资源接口：对外提供扫码后打开的学生提交页面。
app.use('/student', express.static(STUDENT_WEB_DIR));

// 启动后端服务：先确认核心依赖可用，再注册路由和监听端口。
async function startServer() {
  try {
    // Redis 是 nonce、二维码 token 和冷却状态的核心依赖，连接成功后再开放接口。
    await connectRedis();
    await ensureOnlineSessionTable();

    // 时间服务：启动 NTP 时间提供器，业务时间和日志时间会优先使用它。
    timeProvider.logger = logger;
    timeProvider.start();

    // 路由注册：先注册工具类接口，再注册各业务接口。
    registerToolRoutes(app);
    registerUserRoutes(app);
    registerStudentRoutes(app);
    registerAdminRoutes(app);
    registerExcelRoutes(app);

    // 后台任务：定期清理超时未心跳的普通用户在线状态。
    startOnlineCleanupTask();

    // HTTP 服务启动回调函数：监听端口成功后记录服务地址。
    http.createServer(app).listen(PORT, () => {
      logger.info(`HTTP 服务器已启动！地址：http://localhost:${PORT}`);
    });
  } catch (err) {
    // 启动阶段失败时不继续开放 HTTP 服务，避免接口在依赖缺失时半可用。
    logger.error('服务启动失败:', err);
    process.exitCode = 1;
  }
}

startServer();
