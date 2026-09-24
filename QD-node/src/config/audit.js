// 本文件存放审计日志和密钥日志辅助函数：清洗日志字段、掩码密钥、识别请求来源并统一写审计日志。
const crypto = require('crypto');
const { logger, consoleOnlyLog, auditLog, adminLog } = require('./log');

// 日志只保留排障所需的业务状态，不写入姓名、学号、token、会话和来源地址等个人或凭据数据。
const REDACTED_LOG_VALUE = '[redacted]';

// 清洗审计日志字段值，避免换行、方括号和超长内容影响日志阅读。
function safeLogValue(value) {
  // 空值统一展示为 -，减少日志里 undefined/null 的噪音。
  if (value === undefined || value === null || value === '') return '-';
  // 对象类字段转成 JSON，字符串直接使用。
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  // 去除换行和方括号，避免破坏审计日志的 [key:value] 结构。
  return String(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/[\[\]]/g, '')
    .slice(0, 240);
}

// 将个人标识和短期凭据统一替换为通用占位符，避免日志被复制到公开仓库后形成数据泄露。
function redactLogValue(value) {
  return value === undefined || value === null || value === '' ? '-' : REDACTED_LOG_VALUE;
}

// 对密钥进行掩码展示，避免日志中暴露完整密钥。
function maskSecret(value) {
  // 先去掉首尾空格，空密钥不展示具体内容。
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '-';
  // 短密钥只展示首尾各 1 位。
  if (text.length <= 8) return `${text.slice(0, 1)}***${text.slice(-1)}`;
  // 长密钥展示前 4 后 4，便于排查又不泄漏完整值。
  return `${text.slice(0, 4)}***${text.slice(-4)}`;
}

// 生成密钥的短哈希，用于前端 nonce 请求时标识密钥但不暴露原文。
function hashSecret(value) {
  // 空密钥不参与哈希，直接返回占位符。
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '-';
  // 只取 sha256 前 12 位作为短标识，足够用于日志/匹配，避免暴露完整 hash。
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12);
}

// 从请求头或 socket 中提取客户端 IP。
function getClientIp(req) {
  // 来源地址属于个人数据；只返回是否存在来源，不保留原始地址。
  const raw = String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').trim();
  return raw ? REDACTED_LOG_VALUE : '-';
}

// 从请求的常见位置读取密钥，用于鉴权和审计日志。
function getRequestKey(req) {
  // 优先使用审计识别出的 auditKey，再兼容 header、body、query 中的 key。
  return req.auditKey ||
    req.headers.key ||
    req.headers['x-api-key'] ||
    req.body?.key ||
    req.query?.key ||
    '';
}

// 把已识别的密钥信息挂到请求对象上，供请求日志和审计日志使用。
function setAuditKey(req, role, rowOrId, key) {
  // rowOrId 可以是数据库行，也可以直接是 id，这里统一提取 id。
  const id = typeof rowOrId === 'object' ? rowOrId?.id : rowOrId;
  // 根据角色生成日志里的密钥类型名称。
  const label = role === 'admin' ? '管理员密钥' : '普通密钥';
  // 如果有明文 key，则挂到 req.auditKey，供 requestMeta 判断是否带了密钥。
  if (key || rowOrId?.key) req.auditKey = key || rowOrId.key;
  // auditKeyLabel 是日志里最终展示的安全标签，不包含明文密钥。
  req.auditKeyLabel = id ? `${label}#${id}` : label;
}

// 标记当前请求使用了未识别密钥。
function setUnknownAuditKey(req) {
  // 统一写入未识别密钥标签，方便请求日志和审计日志保持一致。
  req.auditKeyLabel = '未识别密钥';
}

// 构造审计日志中的通用请求元信息。
function requestMeta(req) {
  // 请求密钥优先使用已识别标签；有 key 但未识别时标为“未识别密钥”；完全没有 key 时为 -。
  return {
    请求密钥: req.auditKeyLabel || (getRequestKey(req) ? '未识别密钥' : '-'),
    来源: getClientIp(req)
  };
}

// 构造审计日志中的鉴权结果元信息。
function authMeta(auth) {
  // 没有 auth 时返回空对象，便于调用处安全展开。
  if (!auth) return {};
  return {
    地点: auth.location || '-'
  };
}

// 构造审计日志中的密钥掩码字段。
function keyMeta(key, prefix = 'Key') {
  // prefix 可让调用方生成“Key掩码”“原Key掩码”等不同字段名。
  return {
    [`${prefix}掩码`]: maskSecret(key)
  };
}

// 构造查询学生最后签到状态接口专用的日志元信息。
function queryLastActionMeta(req, token) {
  // 该接口通常由学生端调用，不走通用密钥日志，所以单独记录来源和 token。
  return {
    来源: getClientIp(req),
    请求token: redactLogValue(token)
  };
}

// 构造管理员操作密钥时使用的密钥和地点日志字段。
function keyActionMeta(row, keyLabel, locationLabel) {
  // 管理员新增/修改/删除密钥时，统一输出掩码密钥和绑定地点。
  return {
    [keyLabel]: maskSecret(row?.key),
    [locationLabel]: row?.location || '-'
  };
}

// 构造管理员操作签到记录时使用的姓名、学号和地点日志字段。
function signRecordActionMeta(row, prefix = '记录') {
  // prefix 用于区分原记录、新记录、删除记录等场景。
  return {
    [`${prefix}姓名`]: redactLogValue(row?.name),
    [`${prefix}学号`]: redactLogValue(row?.student_id || row?.studentId),
    [`${prefix}地点`]: row?.location || '-'
  };
}

// 对调用方传入的审计字段做最后一道敏感信息过滤，兼容旧代码中的中文字段名。
function sanitizeAuditValue(key, value) {
  const field = String(key || '');
  if (/(姓名|学号|student_?id|studentId|token|Token|会话|session|来源|来自|客户端IP)/i.test(field)) {
    return redactLogValue(value);
  }
  return value;
}

// 写入审计日志，自动拼接事件名和字段信息。
function logAudit(event, fields = {}, level = 'info') {
  // 过滤 undefined，保留 null/空字符串由 safeLogValue 统一转成 -。
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` [${key}:${safeLogValue(sanitizeAuditValue(key, value))}]`)
    .join('');
  // 审计日志统一以 [审计:事件名] 开头，便于后续检索。
  const message = `[审计:${event}]${suffix}`;
  const writer = typeof event === 'string' && event.startsWith('管理员') ? adminLog : auditLog;
  // 按调用方指定级别写入，例如 warn 用于失败或风险事件；非法级别由底层兜底。
  writer(message, level);
}

// 写入只在控制台汇总输出的审计日志，避免高频接口刷日志文件。
function logConsoleOnlyAudit(event, fields = {}) {
  // 构造方式和 logAudit 一致，但最终走 consoleOnlyLog 做汇总输出。
  const suffix = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ` [${key}:${safeLogValue(sanitizeAuditValue(key, value))}]`)
    .join('');
  consoleOnlyLog(`[审计:${event}]${suffix}`);
}

module.exports = { safeLogValue, redactLogValue, maskSecret, hashSecret, getClientIp, getRequestKey, setAuditKey, setUnknownAuditKey, requestMeta, authMeta, keyMeta, queryLastActionMeta, keyActionMeta, signRecordActionMeta, logAudit, logConsoleOnlyAudit };
