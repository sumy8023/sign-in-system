// 本文件存放通用工具函数：格式化、标准化、日期范围、地点状态和二维码地址处理。
const { db, timeProvider, LOCAT_TABLE, getServerPort, getTimedRedisEntry, getTimedRedisValue } = require('./shared');
const { requestMeta, logAudit } = require('./audit');

// 生成学生端二维码跳转 URL，把 token 拼到学生页面地址后面。
function buildStudentQrUrl(req, token) {
  // 如果部署时配置了公开学生端地址，就优先使用该地址，适合反向代理或公网域名场景。
  const configuredBase = (process.env.STUDENT_WEB_PUBLIC_URL || '').trim();
  // 没有配置公开地址时，从当前请求推断协议和 host，并固定拼到 /student/。
  const baseUrl = configuredBase
    ? configuredBase.replace(/\/?$/, '/')
    : `${getRequestOrigin(req)}/student/`;
  // token 作为 URL 查询参数传给学生端页面，encodeURIComponent 防止特殊字符破坏 URL。
  return `${baseUrl}?token=${encodeURIComponent(token)}`;
}

// 根据请求头推断当前服务的外部访问源，用于生成完整学生端地址。
function getRequestOrigin(req) {
  // 反向代理部署时，外部协议可能在 x-forwarded-proto 中。
  const forwardedProto = getForwardedHeaderValue(req.headers['x-forwarded-proto']);
  // 反向代理部署时，外部域名可能在 x-forwarded-host 中。
  const forwardedHost = getForwardedHeaderValue(req.headers['x-forwarded-host']);
  // 优先代理协议，其次 Express req.protocol，最后兜底 http。
  const protocol = forwardedProto || req.protocol || 'http';
  // 优先代理 host，其次请求 host，最后兜底到 server.js 设置的监听端口。
  const serverPort = getServerPort();
  const host = forwardedHost || req.get('host') || `127.0.0.1${serverPort ? `:${serverPort}` : ''}`;
  // 返回标准 origin，不包含路径。
  return `${protocol}://${host}`;
}

// 读取代理转发头中的第一个有效值，兼容多级代理逗号分隔格式。
function getForwardedHeaderValue(value) {
  // x-forwarded-* 可能是 "https,http" 这种多级代理值，第一段通常是客户端原始值。
  return typeof value === 'string' ? value.split(',')[0].trim() : '';
}

// 标准化地点编码，确保后续比较使用去空格后的字符串。
function normalizeLocat(value) {
  // 非字符串直接视为空地点，避免 undefined/null 参与 SQL 或比较。
  return typeof value === 'string' ? value.trim() : '';
}

// 解析普通密钥的地点绑定：支持单地点、多地点逗号分隔，以及 * 通配所有地点。
function parseLocationBinding(value) {
  const raw = normalizeLocat(value);
  if (!raw) return { wildcard: false, locations: [], normalized: '' };
  const parts = raw.split(',').map((item) => normalizeLocat(item)).filter(Boolean);
  if (parts.includes('*')) return { wildcard: true, locations: [], normalized: '*' };
  const seen = new Set();
  const locations = [];
  for (const part of parts) {
    if (seen.has(part)) continue;
    seen.add(part);
    locations.push(part);
  }
  return {
    wildcard: false,
    locations,
    normalized: locations.join(',')
  };
}

// 把普通密钥地点绑定规范成数据库保存格式，去掉空格和重复地点。
function normalizeLocationBinding(value) {
  return parseLocationBinding(value).normalized;
}

// 判断普通密钥地点绑定是否为 * 通配。
function isUserLocationWildcard(locationBinding) {
  return parseLocationBinding(locationBinding).wildcard;
}

// 判断普通密钥地点绑定是否允许访问指定地点。
function isUserLocationAllowed(locationBinding, locat) {
  const target = normalizeLocat(locat);
  if (!target) return false;
  const parsed = parseLocationBinding(locationBinding);
  return parsed.wildcard || parsed.locations.includes(target);
}

// 判断管理员地点是否为通配符 *，通配符代表可操作所有地点。
function isAdminLocationWildcard(authOrLocation) {
  // 调用方有时只传 location 字符串，这里直接判断字符串是否为 *。
  if (typeof authOrLocation === 'string') return normalizeLocat(authOrLocation) === '*';
  // 传 auth 对象时，必须是 admin 角色且 location 为 * 才算通配权限。
  return Boolean(
    authOrLocation &&
    authOrLocation.role === 'admin' &&
    normalizeLocat(authOrLocation.location) === '*'
  );
}

// 把前端传入的启用状态统一转换为数据库使用的 1 或 0。
function normalizeEnabled(value, fallback = 1) {
  // undefined 表示前端没传该字段，保留调用方给定的默认值。
  if (value === undefined) return fallback;
  // 兼容布尔值、数字和字符串；其他值统一视为关闭。
  return value === true || value === 1 || value === '1' ? 1 : 0;
}

// 把 YYYY-MM-DD 日期转换为 UTC+8 当天范围；格式错误时直接响应 400。
function getDateRangeOrRespond(date, req, res, auditName) {
  try {
    // 统一使用 timeProvider 的 UTC+8 日期范围，保证查询条件一致。
    return timeProvider.getUtc8DateRange(date);
  } catch (err) {
    // 日期格式错误时记录审计日志，并直接返回 400 给前端。
    logAudit(auditName || '日期范围解析失败', { ...requestMeta(req), 日期: date || '-', 原因: err.message }, 'warn');
    res.status(400).json({ message: err.message });
    // 返回 null 让调用方中断后续 SQL 查询。
    return null;
  }
}

// 把地点音频开关统一转换为 1 或 0，空值使用默认值。
function normalizeAudio(value, fallback = 1) {
  // 空字符串/null 常见于表单未填写，按默认值处理。
  if (value === undefined || value === null || value === '') return fallback;
  // 音频开关本质也是启用状态，复用 normalizeEnabled。
  return normalizeEnabled(value, fallback);
}

// 检查地点编码是否存在且处于启用状态。
async function locatExists(locat) {
  // 只承认 enabled=1 的地点，关闭地点不能再绑定给普通密钥。
  const [rows] = await db.query(
    `SELECT locat_en FROM ${LOCAT_TABLE} WHERE locat_en IS NOT NULL AND TRIM(locat_en) = ? AND enabled = 1 LIMIT 1`,
    [locat]
  );
  // 查询到至少一行说明地点存在且可用。
  return rows.length > 0;
}

// 校验普通密钥地点绑定；* 直接允许，多地点则要求每个地点都存在且启用。
async function validateUserLocationBinding(locationBinding) {
  const parsed = parseLocationBinding(locationBinding);
  if (!parsed.normalized) {
    return { ok: false, message: '绑定地点不能为空', normalized: '', missing: [] };
  }
  if (parsed.wildcard) {
    return { ok: true, wildcard: true, locations: [], normalized: '*' };
  }
  const placeholders = parsed.locations.map(() => '?').join(', ');
  const [rows] = await db.query(
    `SELECT TRIM(locat_en) AS locat_en
       FROM ${LOCAT_TABLE}
      WHERE locat_en IS NOT NULL
        AND TRIM(locat_en) IN (${placeholders})
        AND enabled = 1`,
    parsed.locations
  );
  const existing = new Set(rows.map((row) => normalizeLocat(row.locat_en)).filter(Boolean));
  const missing = parsed.locations.filter((locat) => !existing.has(locat));
  if (missing.length > 0) {
    return {
      ok: false,
      message: missing.length === 1 ? '绑定地点不存在' : `绑定地点不存在: ${missing.join(',')}`,
      normalized: parsed.normalized,
      missing
    };
  }
  return { ok: true, wildcard: false, locations: parsed.locations, normalized: parsed.normalized };
}

// 地点编码被修改时，同步普通密钥逗号分隔绑定中的对应项；* 不需要变更。
function replaceLocationBindingValue(locationBinding, oldLocat, newLocat) {
  const parsed = parseLocationBinding(locationBinding);
  const from = normalizeLocat(oldLocat);
  const to = normalizeLocat(newLocat);
  if (!parsed.normalized || parsed.wildcard || !from || !to) return parsed.normalized;
  const seen = new Set();
  const nextLocations = [];
  for (const locat of parsed.locations) {
    const next = locat === from ? to : locat;
    if (seen.has(next)) continue;
    seen.add(next);
    nextLocations.push(next);
  }
  return nextLocations.join(',');
}

// 查询地点状态，返回 enabled、disabled 或 not_found。
async function getLocatStatus(locat) {
  // 查地点是否存在，并读取 enabled 状态；不要求 enabled=1，才能区分关闭和不存在。
  const [rows] = await db.query(
    `SELECT enabled FROM ${LOCAT_TABLE} WHERE locat_en IS NOT NULL AND TRIM(locat_en) = ? LIMIT 1`,
    [locat]
  );
  // 没有记录就是地点不存在。
  if (rows.length === 0) return 'not_found';
  // enabled=1 为可用，否则视为已关闭。
  return Number(rows[0].enabled) === 1 ? 'enabled' : 'disabled';
}

// 根据地点不可用状态生成给前端展示的提示文案。
function getLocatUnavailableMessage(status) {
  // not_found 和 disabled 都不允许继续操作，但给用户的提示不同。
  return status === 'not_found'
    ? '该地址不存在，请联系管理员'
    : '该地点已关闭，请联系管理员';
}

// 获取指定二维码刷新冷却 key 的剩余秒数。
async function getQrCooldownRemaining(cooldownKey) {
  // getTimedRedisEntry 会自动处理过期和脏数据，这里只取剩余秒数。
  const entry = await getTimedRedisEntry(cooldownKey);
  return entry ? entry.remainingSeconds : 0;
}

// 从多个候选 token 中找出仍然有效的二维码 token。
async function getValidQrToken(...tokens) {
  // 按传入顺序检查 token，通常先检查冷却 token 再检查当前活跃 token。
  for (const token of tokens) {
    // 跳过空值或非字符串，避免无意义 Redis 查询。
    if (typeof token !== 'string' || !token) continue;
    // token 在 Redis 中仍有业务值，说明还有效。
    if (await getTimedRedisValue(token)) return token;
  }
  // 所有候选都无效时返回空字符串，方便调用方做 if 判断。
  return '';
}

// 把签到记录列表的筛选条件转换成审计日志中的可读文本。
function buildSignRecordsFilterLabel({ name, studentId, date, location, locatMap = {} }) {
  // 按实际传入的筛选条件逐项拼接。
  const filters = [];
  if (name) filters.push(`姓名=${name}`);
  if (studentId) filters.push(`学号=${studentId}`);
  if (date) filters.push(`日期=${date}`);
  // 地点优先显示中文名；没有映射时显示原始地点值。
  if (location) filters.push(`地点=${locatMap[location] || location}`);
  // 没有任何筛选条件时返回“无”，让审计日志更明确。
  return filters.length > 0 ? filters.join('，') : '无';
}

// 把启用状态数字转换为中文展示文案。
function enabledLabel(value) {
  // 数据库中 enabled/audio 使用 1 表示启用，其他值统一展示关闭。
  return Number(value) === 1 ? '启用' : '关闭';
}

// 格式化数据库时间戳为系统统一使用的 UTC+8 时间字符串。
function formatTimestamp(timestamp) {
  // 具体兼容 Date/字符串/可解析时间的逻辑由 timeProvider 统一处理。
  return timeProvider.formatStoredTimestamp(timestamp);
}

// 导出所有工具函数，业务模块按需从这里引用，避免把格式化/标准化逻辑散落到各接口。
module.exports = { buildStudentQrUrl, getRequestOrigin, getForwardedHeaderValue, normalizeLocat, parseLocationBinding, normalizeLocationBinding, isUserLocationWildcard, isUserLocationAllowed, isAdminLocationWildcard, normalizeEnabled, getDateRangeOrRespond, normalizeAudio, locatExists, validateUserLocationBinding, replaceLocationBindingValue, getLocatStatus, getLocatUnavailableMessage, getQrCooldownRemaining, getValidQrToken, buildSignRecordsFilterLabel, enabledLabel, formatTimestamp };
