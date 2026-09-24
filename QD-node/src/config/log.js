// 本文件负责配置后端日志：按日期写入日志文件、输出控制台日志，并记录接口请求摘要。
const winston = require('winston');
const fs = require('fs');
const path = require('path');
const { Writable } = require('stream');
const timeProvider = require('./time');

// 这些接口调用频率高，只在控制台做周期汇总，不写入每日日志文件，避免日志文件快速膨胀。
const CONSOLE_ONLY_PATHS = new Set(['/auth/nonce', '/heartbeat', '/get-stats']);
// 这些接口轮询频率高且无排障价值，完全跳过请求摘要日志。
const SILENT_REQUEST_LOG_PATHS = new Set(['/qr-status']);
// 这些接口本身不依赖密钥或密钥在请求体里不适合通用日志读取，请求摘要里不输出“请求密钥”字段。
const KEYLESS_REQUEST_LOG_PATHS = new Set(['/query-last-action']);
// 控制台汇总缓存：key 是完整日志内容，value 保存累计次数和定时器。
const consoleSummary = new Map();
// 高频控制台日志的合并输出窗口，30 秒内相同消息只输出一次并带次数。
const CONSOLE_SUMMARY_INTERVAL_MS = 30 * 1000;
// 每日日志文件目录，最终会写到项目根目录的 log/<分类>/YYYY-MM-DD.log。
const LOG_DIR = path.join(__dirname, '..', '..', 'log');
// 日志分类列表；新增分类只需要在这里补充。
const LOG_CATEGORIES = ['request', 'audit', 'admin', 'error', 'system'];
// 每个分类单独维护当前日期和文件流，避免所有日志揉到同一个文件。
const activeCategoryStreams = new Map();

// 获取当前日志日期字符串，用作每日日志文件名。
function getLogDate() {
  // 优先使用 NTP 校准后的 UTC+8 业务日期；服务刚启动尚未同步时会抛错，下面回退本地日期。
  try {
    return timeProvider.getUtc8Ymd();
  } catch (err) {
    return getLocalLogDate();
  }
}

// 获取当前日志时间字符串，用于日志每行的时间戳。
function getLogTimestamp() {
  // 优先使用 NTP 校准后的 UTC+8 业务时间；NTP 不可用时临时回退服务器本地时间。
  try {
    return timeProvider.nowDateTimeString();
  } catch (err) {
    return getLocalLogDateTime();
  }
}

// 仅在 NTP 尚未同步或不可用时，获取服务器本地日期作为日志文件名兜底。
function getLocalLogDate() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 获取服务器本地日期时间字符串，作为 NTP 尚未同步时的日志时间戳兜底。
function getLocalLogDateTime() {
  const now = new Date();
  const date = getLocalLogDate();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');
  return `${date} ${hours}:${minutes}:${seconds}`;
}

// 获取指定分类当天日志文件写入流；跨天时自动切换到新的日志文件。
function getDailyLogStream(category) {
  const safeCategory = LOG_CATEGORIES.includes(category) ? category : 'system';
  const logDate = getLogDate();
  const current = activeCategoryStreams.get(safeCategory);
  // 日期没变时复用原来的文件流，减少文件句柄创建。
  if (current && current.stream && current.date === logDate) return current.stream;
  // 日期变化时关闭旧文件流，后续日志写入新日期文件。
  if (current && current.stream) current.stream.end();
  // 确保 log 目录存在，recursive 可以兼容首次启动没有目录的情况。
  const categoryDir = path.join(LOG_DIR, safeCategory);
  fs.mkdirSync(categoryDir, { recursive: true });
  // 记录当前日期，并用追加模式打开当天日志文件。
  const stream = fs.createWriteStream(path.join(categoryDir, `${logDate}.log`), { flags: 'a' });
  activeCategoryStreams.set(safeCategory, { date: logDate, stream });
  return stream;
}

// 按分类创建日志流写入函数：把 Winston 日志消息写入对应分类和日期文件。
function createDailyLogStream(category) {
  return new Writable({
    write(message, encoding, callback) {
      getDailyLogStream(category).write(message, encoding, callback);
    }
  });
}

function createCategoryLogger(category, includeConsole = true) {
  const transports = [
    new winston.transports.Stream({
      stream: createDailyLogStream(category)
    })
  ];
  if (includeConsole) transports.push(new winston.transports.Console());
  return winston.createLogger({
    // 默认只记录 info 及以上级别，warn/error 会自动包含。
    level: 'info',
    // 统一日志格式：时间戳 + 日志级别 + 消息内容。
    format: winston.format.printf(({ level, message }) => `[${getLogTimestamp()}] ${level.toUpperCase()}: ${message}`),
    transports,
  });
}

const categoryLoggers = LOG_CATEGORIES.reduce((acc, category) => {
  acc[category] = createCategoryLogger(category);
  return acc;
}, {});
// warn/error 镜像到 error 分类时只写文件，避免控制台重复输出。
const errorMirrorLogger = createCategoryLogger('error', false);

// 按分类写日志；warn/error 额外进入 error 分类，方便集中排障。
function writeLog(category, level, message) {
  const safeCategory = LOG_CATEGORIES.includes(category) ? category : 'system';
  const safeLevel = typeof categoryLoggers[safeCategory][level] === 'function' ? level : 'info';
  categoryLoggers[safeCategory][safeLevel](message);
  if ((safeLevel === 'warn' || safeLevel === 'error') && safeCategory !== 'error') {
    errorMirrorLogger[safeLevel](message);
  }
}

function requestLog(message, level = 'info') {
  writeLog('request', level, message);
}

function auditLog(message, level = 'info') {
  writeLog('audit', level, message);
}

function adminLog(message, level = 'info') {
  writeLog('admin', level, message);
}

function systemLog(message, level = 'info') {
  writeLog('system', level, message);
}

function errorLog(message) {
  writeLog('error', 'error', message);
}

// 兼容旧代码里的 logger.info/warn/error；默认归入 system，warn/error 同步进入 error 分类。
const logger = {
  // 默认只记录 info 及以上级别，warn/error 会自动包含。
  info: (...args) => systemLog(formatLogArgs(args), 'info'),
  warn: (...args) => systemLog(formatLogArgs(args), 'warn'),
  error: (...args) => systemLog(formatLogArgs(args), 'error')
};

function formatLogArgs(args) {
  return args.map((item) => {
    if (item instanceof Error) return item.stack || item.message;
    if (typeof item === 'string') return item;
    try {
      return JSON.stringify(item);
    } catch (err) {
      return String(item);
    }
  }).join(' ');
}

// 从请求对象上读取已经识别出的密钥标签。
function getRequestKeyLabel(req) {
  // auditKeyLabel 通常由 audit.js 的 setAuditKey/setUnknownAuditKey 提前写入。
  return req.auditKeyLabel || '-';
}

// 汇总高频控制台日志，按固定时间窗口合并重复消息。
// 控制台汇总输出函数：合并高频重复消息，减少控制台刷屏。
function emitConsoleOnlyRequest(message) {
  // 取出当前消息的汇总对象；没有时从 0 次和空定时器开始。
  const current = consoleSummary.get(message) || { count: 0, timer: null };
  // 相同消息每出现一次只累加计数，不立即刷控制台。
  current.count += 1;
  if (!current.timer) {
    // 首次出现时启动一个窗口定时器，到期后输出一次总次数。
    current.timer = setTimeout(() => {
      const latest = consoleSummary.get(message);
      if (!latest) return;
      console.log(`${message} [次数:${latest.count}]`);
      // 输出后删除缓存，下一个窗口重新统计。
      consoleSummary.delete(message);
    }, CONSOLE_SUMMARY_INTERVAL_MS);
    // unref 让这个定时器不阻止 Node 进程自然退出。
    if (typeof current.timer.unref === 'function') current.timer.unref();
  }
  // 把更新后的计数和定时器写回 Map。
  consoleSummary.set(message, current);
}

// 对外暴露的控制台汇总日志入口。
function consoleOnlyLog(message) {
  // 统一走汇总逻辑，调用方不用关心节流和计数细节。
  emitConsoleOnlyRequest(message);
}

// 注册请求日志中间件函数：在响应完成后记录请求路径、来源和密钥标签。
function setupRequestLogger(app) {
  // Express 请求日志中间件函数：收集当前请求信息并等待响应完成。
  app.use((req, res, next) => {
    // 路径到中文业务名称的映射，用于让日志比裸 URL 更易读。
    const pathAliases = {
      '/get-stats': '获取人数状态',
      '/generate-qr': '生成二维码',
      '/qr-status': '二维码状态同步',
      '/submit-info': '提交签到/签退',
      '/export-excel': '导出excel',
      '/export-excel-range': '按日期导出excel',
      '/timeadd-ranking': '时长排行',
      '/validate-key': '秘钥验证',
      '/auth/nonce': '发放nonce',
      '/query-last-action': '签到退状态定位',
      '/heartbeat': '普通密钥心跳',
      '/offline': '普通密钥离线',
      '/sign-records': '签到详情',
      '/admin/locats': '管理员配置页面',
      '/admin/user-keys': '管理员配置页面',
    };
    // 来源地址属于个人数据；公开代码默认只记录通用占位符。
    const rawClientIp = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').trim();
    const clientIp = rawClientIp ? '[redacted]' : '-';
    // 先精确匹配路径；未命中时尝试匹配 /admin/user-keys/:id 这类子路径。
    const matchedAlias = pathAliases[req.path] ||
      Object.keys(pathAliases)
        .filter((path) => path !== '/' && req.path.startsWith(path + '/'))
        .map((path) => pathAliases[path])[0];
    // 有业务名称时追加 [类型:xxx]，没有匹配时不额外输出。
    const alias = matchedAlias ? `[类型:${matchedAlias}]` : '';
    // 响应完成回调函数：根据路径决定写入日志文件或控制台汇总。
    res.on('finish', () => {
      if (SILENT_REQUEST_LOG_PATHS.has(req.path)) return;
      // 部分接口跳过密钥字段，避免日志误导或重复暴露无意义信息。
      const keyPart = KEYLESS_REQUEST_LOG_PATHS.has(req.path) ? '' : `[请求密钥:${getRequestKeyLabel(req)}] `;
      // 请求摘要只记录来源、路径、密钥标签和业务类型，不记录请求体。
      const message = `${keyPart}[来自:${clientIp}] [路径:${req.path}]${alias}`;
      if (CONSOLE_ONLY_PATHS.has(req.path)) {
        // 高频接口进入控制台汇总，减少文件日志和控制台刷屏。
        emitConsoleOnlyRequest(message);
        return;
      }
      // 普通接口写入 request 分类日志，避免和业务审计、系统错误混在一起。
      requestLog(message);
    });
    // 放行给后续业务路由。
    next();
  });
}

module.exports = {
  logger,
  setupRequestLogger,
  consoleOnlyLog,
  writeLog,
  requestLog,
  auditLog,
  adminLog,
  systemLog,
  errorLog
};
