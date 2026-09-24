// 本文件存放后端共享核心逻辑：鉴权、业务时间包装、Redis token、数据库连接、常量和共享路由任务。
const crypto = require('crypto');
const { logger } = require('./log');
const { redisClient, db } = require('../db/database');
const timeProvider = require('./time');
const { hashSecret, setAuditKey, setUnknownAuditKey, requestMeta, authMeta, keyMeta, logAudit } = require('./audit');
// 服务监听端口由 server.js 统一设置；
let serverPort = null;

// 设置服务监听端口：server.js 启动时调用，供二维码地址兜底等共享逻辑读取。
function setServerPort(port) {
  // 只接受正整数端口；异常值保存为 null，让调用方自行决定是否带端口兜底。
  const parsed = Number(port);
  serverPort = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

// 获取 server.js 设置的服务监听端口。
function getServerPort() {
  // 返回 null 表示 server.js 尚未设置或端口值非法。
  return serverPort;
}

// ---------- 鉴权：支持 HMAC(nonce+sign) 或 明文 key（兼容旧版） ----------
// nonce 存入 Redis 的 key 前缀，避免和二维码 token 等其他 Redis 数据混淆。
const NONCE_PREFIX = 'auth:nonce:';
// nonce 有效期，前端拿到后需要在 120 秒内完成签名请求。
const NONCE_TTL = 120; // 秒
// 当前地点正在使用的二维码 token 映射 key 前缀。
const QR_ACTIVE_TOKEN_PREFIX = 'qr:active-token:';
// 二维码 token 到地点编码的映射 key 前缀。
const QR_TOKEN_LOCAT_PREFIX = 'qr:token-locat:';
// 二维码刷新冷却 key 前缀，用于防止短时间重复生成多个二维码。
const QR_REFRESH_COOLDOWN_PREFIX = 'qr:refresh-cooldown:';
// 二维码 token 业务有效期。
const QR_TOKEN_TTL = 300; // 秒
// 二维码刷新冷却秒数。
const QR_REFRESH_COOLDOWN_SECONDS = 15;
// Redis 物理 TTL 会比业务 TTL 多保留一段时间，便于业务层自行判断过期并清理。
const REDIS_CLEANUP_GRACE_SECONDS = 60;
// 数据库表名常量统一加反引号，避免 key 等字段或表名和 SQL 关键字冲突。
const USER_KEY_TABLE = '`user_key`';
const ADMIN_KEY_TABLE = '`admin_key`';
const LOCAT_TABLE = '`locat`';
const USER_KEY_SESSION_TABLE = '`user_key_session`';
const SESSION_ID_MAX_LENGTH = 128;
const USER_KEY_SESSION_ACTIVE_SECONDS = 90;
const USER_KEY_SESSION_RETENTION_SECONDS = 24 * 60 * 60;

// 判断普通密钥是否被管理员强制下线且尚未重新登录。
function isForcedLoggedOut(row) {
  // 没有强制下线时间时，说明该密钥没有被管理员踢下线。
  if (!row || !row.forced_logout_at) return false;
  // 数据库时间可能是字符串或 Date，这里统一格式后再比较。
  const forcedAt = timeProvider.formatStoredTimestamp(row.forced_logout_at);
  const loginAt = row.last_login_at ? timeProvider.formatStoredTimestamp(row.last_login_at) : '';
  // 强制下线时间存在，并且用户没有之后重新登录，则认为仍处于强制下线状态。
  return Boolean(forcedAt) && (!loginAt || forcedAt > loginAt);
}

function normalizeSessionId(value) {
  if (typeof value !== 'string') return '';
  const sessionId = value.trim();
  if (!sessionId || sessionId.length > SESSION_ID_MAX_LENGTH) return '';
  return sessionId;
}

async function ensureOnlineSessionTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS ${USER_KEY_SESSION_TABLE} (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_key_id BIGINT NOT NULL,
      session_id VARCHAR(128) NOT NULL,
      location VARCHAR(255) DEFAULT '',
      created_at DATETIME NOT NULL,
      last_seen_at DATETIME NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_user_key_session (user_key_id, session_id),
      KEY idx_user_key_last_seen (user_key_id, last_seen_at),
      KEY idx_last_seen (last_seen_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);
}

async function touchUserKeySession(userKeyId, sessionId, location, timestamp) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const parsedUserKeyId = Number(userKeyId);
  if (!Number.isFinite(parsedUserKeyId) || parsedUserKeyId <= 0 || !normalizedSessionId) {
    return false;
  }
  await db.query(
    `INSERT INTO ${USER_KEY_SESSION_TABLE} (user_key_id, session_id, location, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE location = VALUES(location), last_seen_at = VALUES(last_seen_at)`,
    [parsedUserKeyId, normalizedSessionId, location || '', timestamp, timestamp]
  );
  return true;
}

async function hasUserKeySession(userKeyId, sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const parsedUserKeyId = Number(userKeyId);
  if (!Number.isFinite(parsedUserKeyId) || parsedUserKeyId <= 0 || !normalizedSessionId) {
    return false;
  }
  const [rows] = await db.query(
    `SELECT id FROM ${USER_KEY_SESSION_TABLE} WHERE user_key_id = ? AND session_id = ? LIMIT 1`,
    [parsedUserKeyId, normalizedSessionId]
  );
  return rows.length > 0;
}

async function clearUserKeySessionsById(userKeyId) {
  const parsedUserKeyId = Number(userKeyId);
  if (!Number.isFinite(parsedUserKeyId) || parsedUserKeyId <= 0) return 0;
  const [result] = await db.query(`DELETE FROM ${USER_KEY_SESSION_TABLE} WHERE user_key_id = ?`, [parsedUserKeyId]);
  return result.affectedRows || 0;
}

async function clearUserKeySession(userKeyId, sessionId) {
  const normalizedSessionId = normalizeSessionId(sessionId);
  const parsedUserKeyId = Number(userKeyId);
  if (!Number.isFinite(parsedUserKeyId) || parsedUserKeyId <= 0 || !normalizedSessionId) {
    return 0;
  }
  const [result] = await db.query(
    `DELETE FROM ${USER_KEY_SESSION_TABLE} WHERE user_key_id = ? AND session_id = ?`,
    [parsedUserKeyId, normalizedSessionId]
  );
  return result.affectedRows || 0;
}

async function syncUserKeyOnlineFromSessions(userKeyId, timestamp) {
  const parsedUserKeyId = Number(userKeyId);
  if (!Number.isFinite(parsedUserKeyId) || parsedUserKeyId <= 0) return 0;
  const cutoff = timeProvider.dateTimeStringFromOffset(-USER_KEY_SESSION_ACTIVE_SECONDS * 1000);
  const [rows] = await db.query(
    `SELECT COUNT(*) AS activeCount FROM ${USER_KEY_SESSION_TABLE} WHERE user_key_id = ? AND last_seen_at >= ?`,
    [parsedUserKeyId, cutoff]
  );
  const online = Number(rows[0]?.activeCount || 0) > 0 ? 1 : 0;
  const [result] = await db.query(
    `UPDATE ${USER_KEY_TABLE} SET online = ?, updated_at = ? WHERE id = ?`,
    [online, timestamp, parsedUserKeyId]
  );
  return result.affectedRows || 0;
}

async function markUserKeyOffline(userKeyId, timestamp) {
  const parsedUserKeyId = Number(userKeyId);
  if (!Number.isFinite(parsedUserKeyId) || parsedUserKeyId <= 0) return 0;
  await clearUserKeySessionsById(parsedUserKeyId);
  const [result] = await db.query(
    `UPDATE ${USER_KEY_TABLE} SET online = 0, updated_at = ? WHERE id = ?`,
    [timestamp, parsedUserKeyId]
  );
  return result.affectedRows || 0;
}

// 获取当前业务时间；如果网络时间不可用，则按接口响应 503。
function getBusinessNow(req, res) {
  try {
    // 所有业务接口统一使用 NTP 校准后的业务时间，避免依赖本机系统时间漂移。
    return timeProvider.getBusinessTime();
  } catch (err) {
    if (res) {
      // 如果调用方传了 res，说明这是接口处理中，需要直接给前端返回明确错误。
      logAudit('网络时间不可用', { ...requestMeta(req), 原因: err.message }, 'warn');
      res.status(503).json({ message: '网络时间同步异常，请稍后再试', timeStatus: err.status || timeProvider.getStatus() });
    }
    // 没有 res 或已经响应时返回 null，让调用方自行中断后续逻辑。
    return null;
  }
}

// 构造带业务过期时间的 Redis JSON 值，避免只依赖 Redis 自身 TTL。
function buildTimedRedisValue(value, ttlSeconds) {
  // expiresAtMs 使用 timeProvider.nowMs()，确保过期判断和业务网络时间一致。
  return JSON.stringify({
    value,
    expiresAtMs: Math.floor(timeProvider.nowMs() + ttlSeconds * 1000)
  });
}

// 写入带过期时间的 Redis 值，并额外保留清理宽限时间。
async function setTimedRedisValue(key, value, ttlSeconds) {
  // Redis TTL 多加宽限时间；真正是否有效由 JSON 里的 expiresAtMs 判断。
  await redisClient.setEx(
    key,
    ttlSeconds + REDIS_CLEANUP_GRACE_SECONDS,
    buildTimedRedisValue(value, ttlSeconds)
  );
}

// 仅当 Redis key 不存在时写入带过期时间的值，用于并发抢占锁。
async function setTimedRedisValueNx(key, value, ttlSeconds) {
  // NX 用于“谁先写入谁成功”的场景，例如二维码刷新冷却锁。
  return redisClient.set(key, buildTimedRedisValue(value, ttlSeconds), {
    EX: ttlSeconds + REDIS_CLEANUP_GRACE_SECONDS,
    NX: true
  });
}

// 读取 Redis 中带业务过期时间的值，过期或格式异常时自动删除。
async function getTimedRedisEntry(key) {
  // Redis 中不存在时直接返回 null。
  const raw = await redisClient.get(key);
  if (!raw) return null;
  let parsed;
  try {
    // 业务写入的是 JSON，里面包含 value 和 expiresAtMs。
    parsed = JSON.parse(raw);
  } catch (err) {
    // 非 JSON 说明数据异常，删除后按无效处理。
    await redisClient.del(key);
    return null;
  }
  if (!parsed || typeof parsed.expiresAtMs !== 'number') {
    // 缺少过期时间的旧数据或脏数据不能继续使用。
    await redisClient.del(key);
    return null;
  }
  // 使用 NTP 校准时间计算剩余业务有效期。
  const remainingMs = parsed.expiresAtMs - timeProvider.nowMs();
  if (remainingMs <= 0) {
    // 业务时间已过期，即使 Redis 物理 TTL 还没到，也立即删除。
    await redisClient.del(key);
    return null;
  }
  // 返回值同时带剩余秒数，供二维码冷却倒计时等场景使用。
  return {
    value: parsed.value,
    expiresAtMs: parsed.expiresAtMs,
    remainingSeconds: Math.max(0, Math.ceil(remainingMs / 1000))
  };
}

// 读取 Redis 业务值本身，不返回过期时间等元信息。
async function getTimedRedisValue(key) {
  // 基于 getTimedRedisEntry 做统一过期/脏数据处理，然后只取 value。
  const entry = await getTimedRedisEntry(key);
  return entry ? entry.value : null;
}

// 注册共享基础路由到 Express 应用实例。
function registerToolRoutes(app) {
// 发放 nonce 接口：给前端生成一次性随机数，用于 HMAC 签名鉴权。
app.get('/auth/nonce', async (req, res) => {
  try {
    // 前端可带 x-key-hash，让后端在不知道明文 key 的情况下标记审计日志来源。
    const nonceKeyHash = typeof req.headers['x-key-hash'] === 'string' ? req.headers['x-key-hash'].trim() : '';
    if (nonceKeyHash) {
      // 查询所有普通密钥并计算短哈希，用于匹配前端传来的 key hash。
      const [rows] = await db.query(
        `SELECT id, \`key\` FROM ${USER_KEY_TABLE}`
      );
      const matched = rows.find((row) => hashSecret(row.key) === nonceKeyHash);
      if (matched) {
        // 匹配成功时把普通密钥标签挂到 req，后续请求日志能展示“普通密钥#id”。
        setAuditKey(req, 'user', matched);
      } else {
        // 有 hash 但找不到对应密钥，也记录为未识别密钥，便于排查。
        setUnknownAuditKey(req);
      }
    }
    // 生成 32 字节随机 nonce，转成 hex 后发给前端参与 HMAC 签名。
    const nonce = crypto.randomBytes(32).toString('hex');
    // 发放 nonce 也依赖业务时间，NTP 不可用时不继续发放，避免鉴权时间基准异常。
    const businessTime = getBusinessNow(req, res);
    if (!businessTime) return;
    // nonce 写入 Redis，resolveAuth 使用后会删除，达到一次性使用效果。
    await setTimedRedisValue(NONCE_PREFIX + nonce, '1', NONCE_TTL);
    res.json({ nonce });
  } catch (err) {
    // nonce 发放失败属于服务端异常，记录错误并返回统一 500。
    logger.error('发放 nonce 失败:', err);
    res.status(500).json({ message: '服务器错误' });
  }
});

// 获取网络时间接口：返回当前 NTP 同步后的业务时间和当天时间范围。
app.get('/network-time', async (req, res) => {
  // 网络时间接口需要先鉴权，防止外部随意探测服务状态。
  const auth = await resolveAuth(req);
  if (!auth.ok) {
    // 鉴权失败时写审计日志，并按非法请求/无权限返回对应状态码。
    logAudit('网络时间获取失败', { ...requestMeta(req), 原因: auth.message }, 'warn');
    return res.status(auth.message === '非法请求！' ? 400 : 403).json({ message: auth.message });
  }
  // 获取 NTP 校准后的业务时间；失败时 getBusinessNow 已负责响应 503。
  const businessTime = getBusinessNow(req, res);
  if (!businessTime) return;
  // 成功获取时记录审计日志，包含调用来源和当前业务时间。
  logAudit('获取网络时间', { ...requestMeta(req), ...authMeta(auth), 当前时间: businessTime.nowDateTime });
  // 返回前端需要的当前时间、当天范围和 NTP 同步状态。
  res.json({
    now: businessTime.nowDateTime,
    iso: businessTime.nowIso,
    date: businessTime.ymd,
    todayRange: businessTime.todayRange,
    source: 'NTP',
    status: timeProvider.getStatus()
  });
});
}

// 普通用户在线状态清理任务：每 1 分钟按活跃会话推导 online，并清理长期无效会话。
function startOnlineCleanupTask() {
  // 用定时器周期性修正在线状态，避免用户关闭页面但离线接口没发出的残留在线。
  setInterval(async () => {
    try {
      // 以 NTP 校准时间为准，短期未心跳只影响在线显示，不直接使登录会话失效。
      const activeCutoff = timeProvider.dateTimeStringFromOffset(-USER_KEY_SESSION_ACTIVE_SECONDS * 1000);
      const retentionCutoff = timeProvider.dateTimeStringFromOffset(-USER_KEY_SESSION_RETENTION_SECONDS * 1000);
      const now = timeProvider.nowDateTimeString();
      await db.query(`DELETE FROM ${USER_KEY_SESSION_TABLE} WHERE last_seen_at < ?`, [retentionCutoff]);
      await db.query(`
        DELETE s FROM ${USER_KEY_SESSION_TABLE} s
        LEFT JOIN ${USER_KEY_TABLE} uk ON uk.id = s.user_key_id
        WHERE uk.id IS NULL
      `);
      // online 不再由单个标签页直接控制，而是由当前仍活跃的会话数推导。
      await db.query(
        `UPDATE ${USER_KEY_TABLE} uk
         LEFT JOIN (
           SELECT user_key_id, COUNT(*) AS activeCount
           FROM ${USER_KEY_SESSION_TABLE}
           WHERE last_seen_at >= ?
           GROUP BY user_key_id
         ) s ON s.user_key_id = uk.id
         SET
           uk.updated_at = CASE
             WHEN uk.online <> CASE WHEN COALESCE(s.activeCount, 0) > 0 THEN 1 ELSE 0 END THEN ?
             ELSE uk.updated_at
           END,
           uk.online = CASE WHEN COALESCE(s.activeCount, 0) > 0 THEN 1 ELSE 0 END
         WHERE uk.online <> CASE WHEN COALESCE(s.activeCount, 0) > 0 THEN 1 ELSE 0 END`,
        [activeCutoff, now]
      );
    } catch (e) {
      // 定时任务失败不影响进程继续运行，只记录错误供排查。
      logger.error('定时清理 online 状态失败:', e);
    }
  }, 60 * 1000);
}

// 导出时长排行工作表工具：给 Excel 附加按 student_id 汇总的时长排行 sheet。
async function appendTimeaddRankingWorksheet(workbook, whereClause = '', whereParams = []) {
  // 新增第二个工作表，用来放汇总后的志愿时长排行。
  const rankingSheet = workbook.addWorksheet('时长排行');
  // 定义表头、字段 key 和列宽，key 会对应 addRow 里的对象字段。
  rankingSheet.columns = [
    { header: '排名', key: 'rank', width: 10 },
    { header: '姓名', key: 'name', width: 20 },
    { header: '学号', key: 'student_id', width: 20 },
    { header: '总时长(小时)', key: 'total_hours', width: 15 },
    { header: '总时长(分钟)', key: 'total_minutes', width: 15 },
    { header: '已完成次数', key: 'completed_count', width: 15 },
    { header: '总记录数', key: 'record_count', width: 12 }
  ];
  // 总时长小时保留两位小数，Excel 打开时也按数字格式展示。
  rankingSheet.getColumn(4).numFmt = '0.00';

  // whereClause/whereParams 来自导出接口，用于按日期或日期范围过滤排行数据。
  const rankingSql = `
    SELECT
      student_id,
      MAX(name) AS name,
      ROUND(SUM(COALESCE(timeadd, 0)), 2) AS total_hours,
      COUNT(*) AS record_count,
      SUM(CASE WHEN sign_out_time IS NOT NULL THEN 1 ELSE 0 END) AS completed_count
    FROM sign_in_records
    ${whereClause}
    GROUP BY student_id
    ORDER BY total_hours DESC, student_id ASC
  `;
  // 查询每个 student_id 的累计时长、记录数和已完成次数。
  const [rankingRows] = await db.query(rankingSql, whereParams);

  if (rankingRows.length === 0) {
    // 没有排行数据时仍创建工作表，并写入一行“暂无数据”，避免空 sheet 让用户误解。
    rankingSheet.addRow({
      rank: '-',
      name: '暂无数据',
      student_id: '',
      total_hours: 0,
      total_minutes: 0,
      completed_count: 0,
      record_count: 0
    });
    return;
  }

  // 按 SQL 排序结果逐行写入排行，排名从 1 开始。
  rankingRows.forEach((row, index) => {
    // 数据库返回可能是字符串，这里转成数字后再计算分钟数。
    const totalHours = Number(row.total_hours) || 0;
    rankingSheet.addRow({
      rank: index + 1,
      name: row.name || '',
      student_id: row.student_id,
      total_hours: totalHours,
      total_minutes: Math.max(0, Math.round(totalHours * 60)),
      completed_count: Number(row.completed_count) || 0,
      record_count: Number(row.record_count) || 0
    });
  });
}

// 获取并校验鉴权：优先 nonce+sign（HMAC，仅查 user_key），否则回退到 header.key（先查 user_key，再查 admin_key），返回 { ok, key, location, role: 'user'|'admin' }。
async function resolveAuth(req) {
  // HMAC 鉴权使用这两个请求头：nonce 是一次性随机数，sign 是 HMAC 签名。
  const nonce = req.headers['x-auth-nonce'];
  const sign = req.headers['x-auth-sign'];
  const sessionId = normalizeSessionId(req.headers['x-session-id']);
  // 明文 key 是兼容旧版前端或后台接口的兜底方式。
  const plainKey = req.headers.key;

  if (nonce && sign) {
    try {
      // nonce 必须存在且未过期；读取不到说明已使用或已过期。
      const exists = await getTimedRedisValue(NONCE_PREFIX + nonce);
      if (exists === null) {
        logAudit('鉴权失败', { ...requestMeta(req), 认证方式: 'HMAC', 原因: 'nonce已使用或已过期' }, 'warn');
        return { ok: false, message: 'nonce 已使用或已过期' };
      }
      // HMAC 模式只查询启用的普通密钥，由后端逐个计算签名比对。
      const [keyRows] = await db.query(
        `SELECT id, \`key\`, location, forced_logout_at, last_login_at FROM ${USER_KEY_TABLE} WHERE enabled = 1`
      );
      for (const row of keyRows) {
        // 用数据库中的真实 key 对 nonce 做 HMAC，和前端 sign 完全一致才通过。
        const expected = crypto.createHmac('sha256', row.key).update(nonce).digest('hex');
        if (expected === sign) {
          // 找到匹配密钥后写入审计标签，并删除 nonce 保证一次性。
          setAuditKey(req, 'user', row);
          await redisClient.del(NONCE_PREFIX + nonce);
          if (isForcedLoggedOut(row)) {
            // 被强制下线的普通密钥不能继续通过鉴权，同时清理全部在线会话。
            const businessTime = getBusinessNow(req, null);
            const updatedAt = businessTime ? businessTime.nowDateTime : timeProvider.formatStoredTimestamp(row.forced_logout_at);
            await markUserKeyOffline(row.id, updatedAt);
            logAudit('鉴权失败', { ...requestMeta(req), 认证方式: 'HMAC', 原因: '普通密钥被强制下线', ...keyMeta(row.key), 绑定地点: row.location }, 'warn');
            return { ok: false, message: 'KEY_FORCED_LOGOUT' };
          }
          if (sessionId && !(await hasUserKeySession(row.id, sessionId))) {
            logAudit('鉴权失败', { ...requestMeta(req), 认证方式: 'HMAC', 原因: '普通密钥会话已失效', ...keyMeta(row.key), 绑定地点: row.location }, 'warn');
            return { ok: false, message: 'KEY_SESSION_EXPIRED' };
          }
          // HMAC 鉴权成功，返回普通用户身份和绑定地点。
          return { ok: true, key: row.key, location: row.location, role: 'user' };
        }
      }
      // 遍历所有启用普通密钥都没有匹配，说明签名无效。
      logAudit('鉴权失败', { ...requestMeta(req), 认证方式: 'HMAC', 原因: '签名无效' }, 'warn');
      return { ok: false, message: '无效的 key' };
    } catch (e) {
      // HMAC 校验过程异常时不暴露内部细节，只返回鉴权失败。
      logger.error('resolveAuth HMAC 校验出错:', e);
      return { ok: false, message: '鉴权失败' };
    }
  }

  if (plainKey) {
    // 先查普通密钥
    const [userRows] = await db.query(
      `SELECT * FROM ${USER_KEY_TABLE} WHERE \`key\` = ?`, [plainKey]
    );
    if (userRows.length > 0) {
      // 命中普通密钥后先设置审计标签，后续失败日志也能知道是哪把密钥。
      const u = userRows[0];
      setAuditKey(req, 'user', u, plainKey);
      if (u.enabled !== 1) {
        // 普通密钥被禁用时拒绝访问。
        logAudit('鉴权失败', { ...requestMeta(req), 认证方式: '明文key', 原因: '普通密钥禁用', ...keyMeta(plainKey), 绑定地点: u.location }, 'warn');
        return { ok: false, message: 'KEY_DISABLED' };
      }
      if (isForcedLoggedOut(u)) {
        // 普通密钥被管理员强制下线后，需要重新登录才能恢复。
        const businessTime = getBusinessNow(req, null);
        const updatedAt = businessTime ? businessTime.nowDateTime : timeProvider.formatStoredTimestamp(u.forced_logout_at);
        await markUserKeyOffline(u.id, updatedAt);
        logAudit('鉴权失败', { ...requestMeta(req), 认证方式: '明文key', 原因: '普通密钥被强制下线', ...keyMeta(plainKey), 绑定地点: u.location }, 'warn');
        return { ok: false, message: 'KEY_FORCED_LOGOUT' };
      }
      // 普通密钥明文鉴权成功。
      return { ok: true, key: plainKey, location: u.location, role: 'user' };
    }
    // 再查管理员密钥
    const [adminRows] = await db.query(
      `SELECT * FROM ${ADMIN_KEY_TABLE} WHERE \`key\` = ?`, [plainKey]
    );
    if (adminRows.length > 0) {
      // 管理员密钥命中后同样设置审计标签。
      const a = adminRows[0];
      setAuditKey(req, 'admin', a, plainKey);
      if (a.enabled !== 1) {
        // 管理员密钥被禁用时拒绝访问管理接口。
        logAudit('鉴权失败', { ...requestMeta(req), 认证方式: '明文key', 原因: '管理员密钥禁用', ...keyMeta(plainKey), 绑定地点: a.location }, 'warn');
        return { ok: false, message: 'ADMIN_KEY_DISABLED' };
      }
      // 管理员明文鉴权成功。
      return { ok: true, key: plainKey, location: a.location, role: 'admin' };
    }
    // 带了 key 但普通表和管理员表都查不到，标记为未识别密钥。
    setUnknownAuditKey(req);
    logAudit('鉴权失败', { ...requestMeta(req), 认证方式: '明文key', 原因: 'key不存在', ...keyMeta(plainKey) }, 'warn');
    return { ok: false, message: '无效的 key' };
  }

  // 既没有 HMAC 头，也没有明文 key，认为请求缺少认证信息。
  logAudit('鉴权失败', { ...requestMeta(req), 认证方式: '无凭据', 原因: '缺少认证信息' }, 'warn');
  return { ok: false, message: '非法请求！' };
}

// 校验当前请求是否为管理员请求；失败时直接响应 403。
async function resolveAdminAuth(req, res) {
  // 先复用统一鉴权逻辑，支持 HMAC 和明文 key。
  const auth = await resolveAuth(req);
  if (!auth.ok) {
    // 鉴权失败时直接响应，调用方拿到 null 后中断。
    logAudit('管理员鉴权失败', { ...requestMeta(req), 原因: auth.message }, 'warn');
    res.status(403).json({ message: auth.message });
    return null;
  }
  if (auth.role !== 'admin') {
    // 鉴权成功但不是管理员，也不能访问管理员接口。
    logAudit('管理员鉴权失败', { ...requestMeta(req), ...authMeta(auth), 原因: '非管理员访问管理员接口' }, 'warn');
    res.status(403).json({ message: '仅管理员可操作' });
    return null;
  }
  // 管理员鉴权通过，返回 auth 给业务接口继续使用。
  return auth;
}

module.exports = {
  NONCE_PREFIX,
  NONCE_TTL,
  QR_ACTIVE_TOKEN_PREFIX,
  QR_TOKEN_LOCAT_PREFIX,
  QR_REFRESH_COOLDOWN_PREFIX,
  QR_TOKEN_TTL,
  QR_REFRESH_COOLDOWN_SECONDS,
  REDIS_CLEANUP_GRACE_SECONDS,
  USER_KEY_TABLE,
  ADMIN_KEY_TABLE,
  LOCAT_TABLE,
  USER_KEY_SESSION_TABLE,
  logger,
  redisClient,
  db,
  timeProvider,
  setServerPort,
  getServerPort,
  isForcedLoggedOut,
  normalizeSessionId,
  ensureOnlineSessionTable,
  touchUserKeySession,
  hasUserKeySession,
  clearUserKeySessionsById,
  clearUserKeySession,
  syncUserKeyOnlineFromSessions,
  markUserKeyOffline,
  getBusinessNow,
  buildTimedRedisValue,
  setTimedRedisValue,
  setTimedRedisValueNx,
  getTimedRedisEntry,
  getTimedRedisValue,
  registerToolRoutes,
  startOnlineCleanupTask,
  appendTimeaddRankingWorksheet,
  resolveAuth,
  resolveAdminAuth
};
