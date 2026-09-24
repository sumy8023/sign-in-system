// 本文件注册二维码展示端和普通用户侧接口：二维码生成、密钥登录、心跳、统计和展示查询。
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { logger, redisClient, db, QR_ACTIVE_TOKEN_PREFIX, QR_TOKEN_LOCAT_PREFIX, QR_REFRESH_COOLDOWN_PREFIX, QR_TOKEN_TTL, QR_REFRESH_COOLDOWN_SECONDS, USER_KEY_TABLE, ADMIN_KEY_TABLE, isForcedLoggedOut, normalizeSessionId, touchUserKeySession, hasUserKeySession, clearUserKeySession, syncUserKeyOnlineFromSessions, markUserKeyOffline, getBusinessNow, setTimedRedisValue, setTimedRedisValueNx, getTimedRedisEntry, getTimedRedisValue, resolveAuth } = require('../config/shared');
const { hashSecret, setAuditKey, setUnknownAuditKey, requestMeta, authMeta, keyMeta, logAudit, logConsoleOnlyAudit } = require('../config/audit');
const { buildStudentQrUrl, normalizeLocat, isUserLocationAllowed, isAdminLocationWildcard, getDateRangeOrRespond, getQrCooldownRemaining, getLocatStatus, getLocatUnavailableMessage, buildSignRecordsFilterLabel, formatTimestamp } = require('../config/utils');

const QR_REUSE_MIN_REMAINING_SECONDS = 10;

async function resolveReusableQrToken(locat, token) {
  if (typeof token !== 'string' || !token) return null;
  const [tokenEntry, locatEntry] = await Promise.all([
    getTimedRedisEntry(token),
    getTimedRedisEntry(`${QR_TOKEN_LOCAT_PREFIX}${token}`)
  ]);
  if (!tokenEntry || !locatEntry || locatEntry.value !== locat) return null;
  const remainingSeconds = Math.min(
    tokenEntry.remainingSeconds,
    locatEntry.remainingSeconds
  );
  if (remainingSeconds < QR_REUSE_MIN_REMAINING_SECONDS) return null;
  return { token, remainingSeconds: Math.max(1, remainingSeconds) };
}

async function buildQrResponse(req, token, remainingSeconds, reused, cooldownRemaining = 0) {
  const qrUrl = buildStudentQrUrl(req, token);
  const qrCode = await QRCode.toDataURL(qrUrl);
  return {
    qrCode,
    token,
    serverTime: getBusinessNow(req, null),
    cooldownRemaining,
    tokenRemainingSeconds: remainingSeconds,
    reused
  };
}

// 注册二维码展示端、登录鉴权、统计和查询相关路由到 Express 应用实例。
function registerUserRoutes(app) {
// 生成二维码接口：按地点生成学生端扫码 URL 和二维码图片，并处理同地点 token 复用与刷新冷却。
app.get('/generate-qr', async (req, res) => {
  try {
    // 生成二维码必须先鉴权，普通展示端和管理员都通过 resolveAuth 统一识别。
    const auth = await resolveAuth(req);
    if (!auth.ok) {
      // 鉴权失败时写审计日志，保留失败原因和请求来源。
      logAudit('二维码生成失败', { ...requestMeta(req), 原因: auth.message }, 'warn');
      // 非法请求格式返回 400，密钥无权限或失效返回 403。
      return res.status(auth.message === '非法请求！' ? 400 : 403).json({ message: auth.message });
    }

    // 获取 URL 查询参数 locat，并统一去空格、规范大小写。
    const locat = normalizeLocat(req.query.locat);
    if (!locat) {
      // 二维码必须属于某个地点，没有地点就无法生成 token 和地点映射。
      logAudit('二维码生成失败', { ...requestMeta(req), ...authMeta(auth), 原因: '缺少地点参数' }, 'warn');
      return res.status(400).json({
        code: 'LOCAT_REQUIRED',
        message: '缺少必要参数:地点'
      });
    }

    // 查询地点状态：enabled 表示可生成二维码，disabled/not_found 都要阻止。
    const locatStatus = await getLocatStatus(locat);
    if (locatStatus === 'not_found') {
      // 地点不存在通常是前端链接参数错误或地点配置被删除。
      logAudit('二维码生成失败', { ...requestMeta(req), ...authMeta(auth), 请求地点: locat, 原因: '地点不存在' }, 'warn');
      return res.status(404).json({
        code: 'LOCAT_NOT_FOUND',
        message: getLocatUnavailableMessage(locatStatus)
      });
    }

    // 地点权限校验：普通密钥支持单地点、多地点和 *，管理员仍按原通配规则处理。
    const locationForbidden = auth.role === 'admin'
      ? (auth.location && !isAdminLocationWildcard(auth) && normalizeLocat(auth.location) !== locat)
      : !isUserLocationAllowed(auth.location, locat);
    if (locationForbidden) {
      logAudit('二维码生成失败', { ...requestMeta(req), ...authMeta(auth), 请求地点: locat, 原因: '地点权限不匹配' }, 'warn');
      return res.status(403).json({ code: 'LOCATION_FORBIDDEN', message: '密钥绑定的地点不匹配，请更换正确的地址' });
    }

    if (locatStatus === 'disabled') {
      // 地点被管理员关闭后，保留配置但禁止继续生成学生扫码二维码。
      logAudit('二维码生成失败', { ...requestMeta(req), ...authMeta(auth), 请求地点: locat, 原因: '地点已关闭' }, 'warn');
      return res.status(404).json({
        code: 'LOCAT_NOT_FOUND',
        message: getLocatUnavailableMessage(locatStatus)
      });
    }

    // activeTokenKey 记录某地点当前优先展示的 token；token 自身是否有效仍由独立 TTL 决定。
    const activeTokenKey = `${QR_ACTIVE_TOKEN_PREFIX}${locat}`;
    const cooldownKey = `${QR_REFRESH_COOLDOWN_PREFIX}${locat}`;
    const forceRefresh = ['1', 'true', 'yes'].includes(String(req.query.forceRefresh || req.query.refresh || '').toLowerCase());

    if (!forceRefresh) {
      // 普通获取二维码时优先复用同地点未过期 token，避免多标签页互相废掉对方正在显示的二维码。
      const activeToken = await getTimedRedisValue(activeTokenKey);
      const reusableActive = await resolveReusableQrToken(locat, activeToken);
      if (reusableActive) {
        const cooldownRemaining = await getQrCooldownRemaining(cooldownKey);
        logAudit('二维码复用', { ...requestMeta(req), 地点: locat, 剩余秒: reusableActive.remainingSeconds });
        return res.json(await buildQrResponse(req, reusableActive.token, reusableActive.remainingSeconds, true, cooldownRemaining));
      }
    }

    // cooldownValue 是冷却窗口内允许复用的 token，cooldownRemaining 是剩余冷却秒数。
    const cooldownRemaining = await getQrCooldownRemaining(cooldownKey);
    if (!forceRefresh && cooldownRemaining > 0) {
      // 冷却期内优先复用已有二维码，避免频繁刷新导致学生扫到的二维码立即失效。
      const cooldownValue = await getTimedRedisValue(cooldownKey);
      const activeToken = await getTimedRedisValue(activeTokenKey);
      const reusableToken =
        await resolveReusableQrToken(locat, cooldownValue) ||
        await resolveReusableQrToken(locat, activeToken);
      if (reusableToken) {
        logAudit('二维码复用', { ...requestMeta(req), 地点: locat, 冷却剩余秒: cooldownRemaining });
        return res.json(await buildQrResponse(req, reusableToken.token, reusableToken.remainingSeconds, true, cooldownRemaining));
      }
    }

    // 没有可复用 token 时才生成唯一 token，并维护“地点 -> 当前优先 token”映射。
    const token = uuidv4();

    // 先写入候选 token，再用 SET NX 抢占刷新冷却，避免 F5/点击并发生成多个二维码
    await setTimedRedisValue(token, 'valid', QR_TOKEN_TTL);
    // token -> 地点的反向映射供学生提交接口校验二维码所属地点。
    await setTimedRedisValue(`${QR_TOKEN_LOCAT_PREFIX}${token}`, locat, QR_TOKEN_TTL);
    // SET NX 成功表示当前请求拿到刷新权；失败表示已有并发请求先创建了冷却窗口。
    const cooldownLocked = await setTimedRedisValueNx(cooldownKey, token, QR_REFRESH_COOLDOWN_SECONDS);

    if (!cooldownLocked) {
      // 并发场景下重新读取冷却 token 和当前 active token，尽量复用先到请求生成的二维码。
      const existingCooldownValue = await getTimedRedisValue(cooldownKey);
      const existingActiveToken = await getTimedRedisValue(activeTokenKey);
      const reusableToken = forceRefresh
        ? await resolveReusableQrToken(locat, existingCooldownValue)
        : await resolveReusableQrToken(locat, existingCooldownValue) ||
          await resolveReusableQrToken(locat, existingActiveToken);
      if (reusableToken) {
        // 当前请求生成的候选 token 没有被采用，立即删除避免留下额外有效二维码。
        await redisClient.del(token);
        await redisClient.del(`${QR_TOKEN_LOCAT_PREFIX}${token}`);
        const remaining = await getQrCooldownRemaining(cooldownKey);
        // 返回并发请求中已经生效的二维码，保持同一地点冷却期内二维码一致。
        logAudit('二维码并发复用', { ...requestMeta(req), 地点: locat, 冷却剩余秒: remaining || QR_REFRESH_COOLDOWN_SECONDS });
        return res.json(await buildQrResponse(req, reusableToken.token, reusableToken.remainingSeconds, true, remaining || QR_REFRESH_COOLDOWN_SECONDS));
      }

      // 没有可复用 token 时，用当前 token 覆盖冷却值，保证后续请求可以复用它。
      await setTimedRedisValue(cooldownKey, token, QR_REFRESH_COOLDOWN_SECONDS);
    }

    // 读取旧 active token，准备把当前 token 设置为该地点优先展示二维码 token。
    const oldToken = await getTimedRedisValue(activeTokenKey);
    await setTimedRedisValue(activeTokenKey, token, QR_TOKEN_TTL);
    if (oldToken && oldToken !== token) {
      // 显式刷新二维码时，让上一张 active 二维码立即失效；普通新开标签页不会走到这里刷新 token。
      if (forceRefresh) {
        await redisClient.del(oldToken);
        await redisClient.del(`${QR_TOKEN_LOCAT_PREFIX}${oldToken}`);
      }
      logAudit('二维码生成', { ...requestMeta(req), 地点: locat, 旧Token: oldToken, 新Token: token });
    } else {
      // 没有旧 token 时说明是首次生成或旧 token 已自然过期。
      logAudit('二维码生成', { ...requestMeta(req), 地点: locat, 旧Token: '', 新Token: token });
    }


    // 再读一次冷却剩余时间，返回给前端展示倒计时。
    const remaining = await getQrCooldownRemaining(cooldownKey);
    res.json(await buildQrResponse(req, token, QR_TOKEN_TTL, false, remaining || QR_REFRESH_COOLDOWN_SECONDS));
  } catch (err) {
    // 捕获 Redis、二维码图片生成或鉴权过程中抛出的异常。
    logger.error(`生成二维码时出错: ${err.message}`);
    res.status(500).send('生成二维码时出错');
  }
});

// 查询当前地点正在展示的二维码 token 状态；只返回 hash 和剩余秒数，供多标签页轻量同步。
app.get('/qr-status', async (req, res) => {
  try {
    const locat = normalizeLocat(req.query.locat);
    if (!locat) {
      return res.status(400).json({ code: 'LOCAT_REQUIRED', message: '缺少必要参数:地点' });
    }

    const activeToken = await getTimedRedisValue(`${QR_ACTIVE_TOKEN_PREFIX}${locat}`);
    const reusableActive = await resolveReusableQrToken(locat, activeToken);
    if (!reusableActive) {
      return res.json({ ok: true, active: false, tokenHash: '', tokenRemainingSeconds: 0 });
    }

    return res.json({
      ok: true,
      active: true,
      tokenHash: hashSecret(reusableActive.token),
      tokenRemainingSeconds: reusableActive.remainingSeconds
    });
  } catch (err) {
    logger.error(`查询二维码状态出错: ${err.message}`);
    return res.status(500).json({ message: '服务器错误' });
  }
});

// 密钥验证接口：校验普通密钥或管理员密钥，并返回角色、绑定地点和登录状态。
app.post('/validate-key', async (req, res) => {
  // key 是用户输入的密钥，locat 是当前页面地点，relogin 用于确认被强制下线后的重新登录。
  const { key, locat, relogin } = req.body;
  const sessionId = normalizeSessionId(req.body && req.body.sessionId);

  if (!key) {
    // 没有 key 无法判断用户身份，直接拒绝并记录请求地点。
    logAudit('密钥登录失败', { ...requestMeta(req), 请求地点: locat, 原因: '缺少key' }, 'warn');
    return res.status(400).json({ message: '缺少必要参数 key' });
  }

  try {
    // 先查普通密钥；普通密钥用于二维码展示端登录。
    const [userRows] = await db.query(
      `SELECT * FROM ${USER_KEY_TABLE} WHERE \`key\` = ?`, [key]
    );

    if (userRows.length > 0) {
      // 命中普通密钥后把密钥信息挂到请求上，后续审计日志可自动识别身份。
      const u = userRows[0];
      setAuditKey(req, 'user', u, key);
      if (u.enabled !== 1) {
        // 禁用密钥不能登录，也不能维持在线状态。
        logAudit('普通密钥登录失败', { ...requestMeta(req), ...keyMeta(key), 绑定地点: u.location, 请求地点: locat, 原因: '密钥禁用' }, 'warn');
        return res.status(403).json({ code: 'KEY_DISABLED', message: '密钥已被禁用' });
      }
      if (isForcedLoggedOut(u) && relogin !== true) {
        // 管理员强制下线后，第一次请求提示前端重新输入；relogin=true 才允许继续登录。
        const businessTime = getBusinessNow(req, res);
        if (!businessTime) return;
        // 被强制下线时清理该密钥的全部页面会话，确保后台状态立即可见。
        await markUserKeyOffline(u.id, businessTime.nowDateTime);
        logAudit('普通密钥登录失败', { ...requestMeta(req), ...keyMeta(key), 绑定地点: u.location, 请求地点: locat, 原因: '被管理员强制下线', 重新登录: relogin === true ? '是' : '否' }, 'warn');
        return res.status(403).json({ code: 'KEY_FORCED_LOGOUT', message: '密钥已被管理员强制下线，请重新输入' });
      }
      // 获取业务时间，用于写 last_login_at、updated_at，并返回 loginAt。
      const businessTime = getBusinessNow(req, res);
      if (!businessTime) return;
      // 如果前端带了 locat，就校验该地点是否存在且可用；未带时兼容旧登录流程。
      const locatStatus = locat ? await getLocatStatus(locat) : 'enabled';
      if (locatStatus === 'not_found') {
        // 前端地点参数不存在时，阻止普通密钥登录到错误地点。
        logAudit('普通密钥登录失败', { ...requestMeta(req), ...keyMeta(key), 绑定地点: u.location, 请求地点: locat, 原因: '地点不存在' }, 'warn');
        return res.status(404).json({ code: 'LOCAT_NOT_FOUND', message: getLocatUnavailableMessage(locatStatus) });
      }
      // 地点校验：普通密钥支持单地点、多地点逗号分隔，以及 * 通配所有启用地点。
      if (locat && !isUserLocationAllowed(u.location, locat)) {
        logAudit('普通密钥登录失败', { ...requestMeta(req), ...keyMeta(key), 绑定地点: u.location, 请求地点: locat, 原因: '地点不匹配' }, 'warn');
        return res.status(403).json({ code: 'LOCATION_MISMATCH', message: '密钥绑定的地点不匹配，请更换正确的地址' });
      }
      if (locatStatus === 'disabled') {
        // 地点关闭后，普通展示端不能继续登录展示该地点二维码。
        logAudit('普通密钥登录失败', { ...requestMeta(req), ...keyMeta(key), 绑定地点: u.location, 请求地点: locat, 原因: '地点已关闭' }, 'warn');
        return res.status(404).json({ code: 'LOCAT_NOT_FOUND', message: getLocatUnavailableMessage(locatStatus) });
      }
      if (sessionId) {
        await touchUserKeySession(u.id, sessionId, u.location, businessTime.nowDateTime);
      }
      // 更新登录状态：登录成功后刷新最近登录时间；online 由页面会话推导。
      await db.query(
        `UPDATE ${USER_KEY_TABLE} SET last_login_at = ?, online = ?, updated_at = ? WHERE \`key\` = ?`,
        [businessTime.nowDateTime, sessionId ? 1 : 0, businessTime.nowDateTime, key]
      );
      // 审计登录成功，密钥值会通过 keyMeta 做脱敏处理。
      logAudit('普通密钥登录成功', { ...requestMeta(req), ...keyMeta(key), 绑定地点: u.location, 请求地点: locat, 重新登录: relogin === true ? '是' : '否' });
      // 返回普通用户角色和绑定地点，前端据此进入展示端页面。
      return res.status(200).json({
        role: 'user',
        location: u.location,
        loginAt: businessTime.nowIso,
        message: '验证成功'
      });
    }

    // 普通密钥未命中时再查管理员密钥；管理员可进入管理配置和记录维护。
    const [adminRows] = await db.query(
      `SELECT * FROM ${ADMIN_KEY_TABLE} WHERE \`key\` = ?`, [key]
    );

    if (adminRows.length > 0) {
      // 命中管理员密钥后设置审计身份为 admin。
      const a = adminRows[0];
      setAuditKey(req, 'admin', a, key);
      if (a.enabled !== 1) {
        // 管理员密钥禁用后不能进入后台。
        logAudit('管理员登录失败', { ...requestMeta(req), ...keyMeta(key), 绑定地点: a.location, 请求地点: locat, 原因: '管理员密钥禁用' }, 'warn');
        return res.status(403).json({ code: 'ADMIN_KEY_DISABLED', message: '管理员密钥已被禁用' });
      }
      // 管理员登录时也校验 URL 地点是否存在，避免进入不存在地点的上下文。
      const locatStatus = locat ? await getLocatStatus(locat) : 'enabled';
      if (locatStatus === 'not_found') {
        logAudit('管理员登录失败', { ...requestMeta(req), ...keyMeta(key), 绑定地点: a.location, 请求地点: locat, 原因: '地点不存在' }, 'warn');
        return res.status(404).json({ code: 'LOCAT_NOT_FOUND', message: getLocatUnavailableMessage(locatStatus) });
      }
      // 地点校验：管理员 location 为 * 时代表不受地点限制
      if (locat && !isAdminLocationWildcard(a.location) && normalizeLocat(a.location) !== normalizeLocat(locat)) {
        // 非通配管理员只能管理自己绑定地点，通配管理员不受地点限制。
        logAudit('管理员登录失败', { ...requestMeta(req), ...keyMeta(key), 绑定地点: a.location, 请求地点: locat, 原因: '地点不匹配' }, 'warn');
        return res.status(403).json({ code: 'LOCATION_MISMATCH', message: '密钥绑定的地点不匹配，请更换正确的地址' });
      }
      // 管理员需要能进入配置页修复已关闭的绑定地点；二维码生成接口仍会禁止关闭地点生成二维码。
      // 更新登录时间，不设置 online，因为在线状态只针对普通展示端密钥。
      const businessTime = getBusinessNow(req, res);
      if (!businessTime) return;
      await db.query(
        `UPDATE ${ADMIN_KEY_TABLE} SET last_login_at = ?, updated_at = ? WHERE \`key\` = ?`,
        [businessTime.nowDateTime, businessTime.nowDateTime, key]
      );
      // 记录管理员登录成功，通配地点会单独标记，方便审计高权限登录。
      logAudit('管理员登录成功', { ...requestMeta(req), ...keyMeta(key), 绑定地点: a.location, 请求地点: locat, 通配地点: isAdminLocationWildcard(a.location) ? '是' : '否' });
      // 返回管理员角色和绑定地点，前端据此展示管理入口。
      return res.status(200).json({
        role: 'admin',
        location: a.location,
        message: '验证成功'
      });
    }

    // 普通密钥和管理员密钥都未命中，标记为未知密钥，避免审计误归属。
    setUnknownAuditKey(req);
    logAudit('密钥登录失败', { ...requestMeta(req), ...keyMeta(key), 请求地点: locat, 原因: 'key不存在' }, 'warn');
    return res.status(404).json({ message: '验证失败!请重新输入' });
  } catch (err) {
    // 捕获数据库查询、业务时间获取等异常。
    logger.error('验证 key 时出错:', err);
    res.status(500).json({ message: '服务器错误' });
  }
});

// 普通用户心跳接口：前端定时调用，用于维持 online=1 并检测密钥禁用或强制下线状态。
app.post('/heartbeat', async (req, res) => {
  // 心跳需要 key 和当前标签页 sessionId，用于精确维护多标签页在线状态。
  const { key } = req.body;
  const sessionId = normalizeSessionId(req.body && req.body.sessionId);
  const locat = normalizeLocat(req.body && req.body.locat);
  if (!key) {
    // 心跳频率高，只写控制台聚合日志，避免日志文件被无效心跳刷屏。
    logConsoleOnlyAudit('普通密钥心跳失败', { ...requestMeta(req), 原因: '缺少key' });
    return res.status(400).json({ message: '缺少 key' });
  }
  if (!sessionId) {
    logConsoleOnlyAudit('普通密钥心跳失败', { ...requestMeta(req), ...keyMeta(key), 原因: '缺少sessionId' });
    return res.status(400).json({ code: 'SESSION_REQUIRED', message: '缺少 sessionId' });
  }

    try {
      // 查询心跳所需字段：启用状态、在线状态和强制下线标记。
      const [rows] = await db.query(
      `SELECT id, enabled, online, location, forced_logout_at, last_login_at FROM ${USER_KEY_TABLE} WHERE \`key\` = ? LIMIT 1`, [key]
    );
    if (rows.length === 0) {
      // key 不存在时标记未知身份，并通知前端退出登录。
      setUnknownAuditKey(req);
      logConsoleOnlyAudit('普通密钥心跳失败', { ...requestMeta(req), ...keyMeta(key), 原因: '密钥不存在' });
      return res.status(404).json({ code: 'KEY_NOT_FOUND', message: '密钥不存在' });
    }
    // 命中普通密钥后设置审计身份，后续日志可关联到密钥。
    const u = rows[0];
    setAuditKey(req, 'user', u, key);
    // 获取业务时间用于刷新 updated_at；如果时间不可用，工具函数会处理响应。
    const businessTime = getBusinessNow(req, res);
    if (!businessTime) return;
    if (u.enabled !== 1) {
      // 密钥已禁用时清理全部会话，避免后台仍显示在线。
      await markUserKeyOffline(u.id, businessTime.nowDateTime);
      logConsoleOnlyAudit('普通密钥心跳失败', { ...requestMeta(req), ...keyMeta(key), 原因: '密钥禁用' });
      return res.status(403).json({ code: 'KEY_DISABLED', message: '密钥已被禁用' });
    }
    if (isForcedLoggedOut(u)) {
      // 管理员强制下线后，心跳返回特定 code，让前端弹出重新登录提示。
      await markUserKeyOffline(u.id, businessTime.nowDateTime);
      logConsoleOnlyAudit('普通密钥心跳失败', { ...requestMeta(req), ...keyMeta(key), 原因: '被管理员强制下线' });
      return res.status(403).json({ code: 'KEY_FORCED_LOGOUT', message: '密钥已被管理员强制下线' });
    }
    if (locat && !isUserLocationAllowed(u.location, locat)) {
      await clearUserKeySession(u.id, sessionId);
      await syncUserKeyOnlineFromSessions(u.id, businessTime.nowDateTime);
      logConsoleOnlyAudit('普通密钥心跳失败', { ...requestMeta(req), ...keyMeta(key), 绑定地点: u.location, 请求地点: locat, 原因: '地点不匹配' });
      return res.status(403).json({ code: 'LOCATION_MISMATCH', message: '密钥绑定的地点不匹配，请更换正确的地址' });
    }
    if (locat) {
      const locatStatus = await getLocatStatus(locat);
      if (locatStatus !== 'enabled') {
        await clearUserKeySession(u.id, sessionId);
        await syncUserKeyOnlineFromSessions(u.id, businessTime.nowDateTime);
        logConsoleOnlyAudit('普通密钥心跳失败', { ...requestMeta(req), ...keyMeta(key), 请求地点: locat, 原因: locatStatus === 'not_found' ? '地点不存在' : '地点已关闭' });
        return res.status(404).json({ code: 'LOCAT_NOT_FOUND', message: getLocatUnavailableMessage(locatStatus) });
      }
    }
    if (!(await hasUserKeySession(u.id, sessionId))) {
      await syncUserKeyOnlineFromSessions(u.id, businessTime.nowDateTime);
      logConsoleOnlyAudit('普通密钥心跳失败', { ...requestMeta(req), ...keyMeta(key), 原因: '会话已失效' });
      return res.status(403).json({ code: 'KEY_SESSION_EXPIRED', message: '密钥会话已失效' });
    }
    // 正常心跳刷新当前标签页会话；密钥 online 由活跃会话数推导。
    await touchUserKeySession(u.id, sessionId, u.location, businessTime.nowDateTime);
    await db.query(
      `UPDATE ${USER_KEY_TABLE} SET online = 1, updated_at = ? WHERE id = ?`,
      [businessTime.nowDateTime, u.id]
    );
    return res.status(200).json({ ok: true });
  } catch (err) {
    // 捕获数据库或业务时间异常，前端可以按服务器错误处理。
    logger.error('heartbeat 出错:', err);
    res.status(500).json({ message: '服务器错误' });
  }
});

// 普通用户离线接口：页面关闭或退出时把普通密钥 online 状态置为 0。
app.post('/offline', async (req, res) => {
  // key 和 sessionId 来自前端当前页面，只下线当前标签页会话。
  const { key } = req.body;
  const sessionId = normalizeSessionId(req.body && req.body.sessionId);
  if (!key) {
    // 离线接口通常由页面卸载触发，参数缺失时直接结束响应即可。
    logAudit('普通密钥离线失败', { ...requestMeta(req), 原因: '缺少key' }, 'warn');
    return res.status(400).end();
  }
  try {
    // 获取业务时间，用于记录离线更新时间。
    const businessTime = getBusinessNow(req, res);
    if (!businessTime) return;
    // 先查询密钥是否存在，用于设置审计身份。
    const [rows] = await db.query(`SELECT id FROM ${USER_KEY_TABLE} WHERE \`key\` = ? LIMIT 1`, [key]);
    if (rows.length > 0) {
      // 存在的 key 标记为普通用户，日志会关联对应密钥。
      setAuditKey(req, 'user', rows[0], key);
      const removedSessions = sessionId
        ? await clearUserKeySession(rows[0].id, sessionId)
        : 0;
      const affectedRows = await syncUserKeyOnlineFromSessions(rows[0].id, businessTime.nowDateTime);
      logAudit('普通密钥离线', {
        ...requestMeta(req),
        ...keyMeta(key),
        会话: sessionId || '-',
        清理会话数: removedSessions,
        影响行数: affectedRows
      });
    } else {
      // 不存在的 key 标记未知，避免误认为合法用户离线。
      setUnknownAuditKey(req);
      logAudit('普通密钥离线', { ...requestMeta(req), ...keyMeta(key), 会话: sessionId || '-', 影响行数: 0 });
    }
  } catch (e) {
    // 离线请求不影响主流程，失败只记录日志，最终仍返回 200 结束前端卸载请求。
    logAudit('普通密钥离线失败', { ...requestMeta(req), ...keyMeta(key), 原因: e.message }, 'warn');
  }
  // 页面卸载场景中前端通常不需要响应体。
  res.status(200).end();
});

// 获取各地点统计接口：返回各启用地点当天未签退人数、姓名列表和空岗提示文案。
app.get('/get-stats', async (req, res) => {
  try {
    // 统计接口同样需要鉴权，避免未授权用户查看各地点在岗名单。
    const auth = await resolveAuth(req);
    if (!auth.ok) {
      // 鉴权失败时记录原因，非法签名返回 400，其余权限问题返回 403。
      logAudit('获取地点统计失败', { ...requestMeta(req), 原因: auth.message }, 'warn');
      return res.status(auth.message === '非法请求！' ? 400 : 403).json({ message: auth.message });
    }


    // 获取当前业务日期和当天起止时间，统计只计算当天未签退记录。
    const businessTime = getBusinessNow(req, res);
    if (!businessTime) return;

    // 动态读取地点配置（locat_en 编码、locat_cn 显示名、info_text 空岗提示）
    const [locRows] = await db.query(
      `SELECT locat_en, locat_cn, info_text FROM locat WHERE locat_en IS NOT NULL AND TRIM(locat_en) <> '' AND enabled = 1`
    );

    // 用 Map 保存地点配置，既保留地点顺序，又方便后面按编码合并统计结果。
    const locatConfigMap = new Map();
    for (const row of locRows) {
      // locat_en 是内部编码，空编码或重复编码直接跳过。
      const code = typeof row.locat_en === 'string' ? row.locat_en.trim() : '';
      if (!code || locatConfigMap.has(code)) continue;
      // locat_cn 为空时使用编码兜底，保证前端始终能显示地点名称。
      const label = typeof row.locat_cn === 'string' && row.locat_cn.trim() ? row.locat_cn.trim() : code;
      // info_text 是该地点无人时展示的提示文案。
      const infoText = typeof row.info_text === 'string' ? row.info_text.trim() : '';
      locatConfigMap.set(code, { label, infoText });
    }

    // locatCodes 用于 SQL IN 查询；result 同时兼容旧的 result[code] 结构和新的 locations 数组。
    const locatCodes = Array.from(locatConfigMap.keys());
    const result = {
      timestamp: businessTime.nowIso,
      locations: []
    };

    if (locatCodes.length === 0) {
      // 没有启用地点时直接返回空列表，避免拼接空 IN SQL。
      logAudit('获取地点统计', { ...requestMeta(req), ...authMeta(auth), 当前日期: businessTime.ymd, 地点数: 0, 未签退人数: 0 });
      return res.json(result);
    }

    // 根据地点数量生成占位符，仍然通过参数传值，避免 SQL 注入。
    const placeholders = locatCodes.map(() => '?').join(', ');
    // 统计每个启用地点当天仍未签退的记录数，并用 GROUP_CONCAT 聚合姓名。
    const [stats] = await db.query(`
      SELECT
        location,
        COUNT(*) AS count,
        GROUP_CONCAT(name) AS names
      FROM sign_in_records
      WHERE
        location IN (${placeholders}) AND
        sign_out_time IS NULL AND
        sign_in_time >= ? AND
        sign_in_time < ?
      GROUP BY location
    `, [...locatCodes, businessTime.todayRange.start, businessTime.todayRange.end]);

    // 把 SQL 统计结果转成 Map，方便没有统计记录的地点补 0。
    const statsMap = new Map();
    stats.forEach((row) => {
      const key = row.location;
      statsMap.set(key, {
        // count 转数字，防止 MySQL 驱动返回字符串。
        count: Number(row.count) || 0,
        // GROUP_CONCAT 返回逗号分隔字符串，前端需要数组。
        names: row.names ? row.names.split(',') : []
      });
    });

    // 按地点配置顺序组装返回值，保证未签到地点也会出现在结果中。
    for (const code of locatCodes) {
      const current = statsMap.get(code) || { count: 0, names: [] };
      const config = locatConfigMap.get(code) || { label: code, infoText: '' };
      const label = config.label || code;
      const infoText = config.infoText || '';
      // 旧版前端可能直接按 result[地点编码] 读取统计，所以继续保留该结构。
      result[code] = {
        count: current.count,
        names: current.names,
        label,
        infoText
      };
      // 新版前端可直接遍历 locations，避免依赖动态对象键。
      result.locations.push({
        key: code,
        label,
        infoText,
        count: current.count,
        names: current.names
      });
    }

    // 汇总所有地点未签退人数，用于审计日志快速查看当天在岗总数。
    const totalOpenCount = result.locations.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
    logAudit('获取地点统计', { ...requestMeta(req), ...authMeta(auth), 当前日期: businessTime.ymd, 地点数: result.locations.length, 未签退人数: totalOpenCount });
    res.json(result);

  } catch (err) {
    // 捕获地点配置查询和统计查询异常。
    logger.error(`获取统计信息时出错: ${err.message}`);
    res.status(500).json({ message: '获取统计信息失败' });
  }
});

// 签到记录分页接口：给前端展示签到详情列表，支持姓名、学号、日期和地点筛选。
app.get('/sign-records', async (req, res) => {
  try {
    // 查询签到详情需要鉴权，普通展示端和管理员都走统一鉴权逻辑。
    const auth = await resolveAuth(req);
    if (!auth.ok) {
      // 鉴权失败时不执行查询，避免泄露签到记录。
      logAudit('查询签到记录失败', { ...requestMeta(req), 原因: auth.message }, 'warn');
      return res.status(auth.message === '非法请求！' ? 400 : 403).json({ message: auth.message });
    }

    // 解析分页参数；无效 page 默认第 1 页。
    const requestedPage = Number.parseInt(req.query.page, 10);
    const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
    // 限制 pageSize 只能取固定值，避免一次请求拉取过多数据。
    const requestedPageSize = Number.parseInt(req.query.pageSize, 10);
    const allowedPageSizes = [80, 150, 200];
    const pageSize = allowedPageSizes.includes(requestedPageSize) ? requestedPageSize : 80;
    // 读取筛选条件，字符串统一 trim，空字符串代表不筛选。
    const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
    const studentId = typeof req.query.studentId === 'string' ? req.query.studentId.trim() : '';
    const date = typeof req.query.date === 'string' ? req.query.date.trim() : '';
    const effectiveLocation = typeof req.query.location === 'string' ? req.query.location.trim() : '';

    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      // 日期必须是 YYYY-MM-DD，避免传入无法转换的时间字符串。
      logAudit('查询签到记录失败', { ...requestMeta(req), ...authMeta(auth), 日期: date, 原因: '日期格式错误' }, 'warn');
      return res.status(400).json({ message: '日期格式错误，应为 YYYY-MM-DD' });
    }

    // whereConditions 保存 SQL 片段，whereParams 保存对应参数，避免拼接用户输入。
    const whereConditions = [];
    const whereParams = [];
    if (name) {
      // 姓名支持模糊查询。
      whereConditions.push('name LIKE ?');
      whereParams.push(`%${name}%`);
    }
    if (studentId) {
      // 学号支持模糊查询，便于输入部分学号检索。
      whereConditions.push('student_id LIKE ?');
      whereParams.push(`%${studentId}%`);
    }
    if (date) {
      // 日期筛选转换成当天 [start, end) 范围，避免直接对日期函数做查询影响索引。
      const dateRange = getDateRangeOrRespond(date, req, res, '查询签到记录失败');
      if (!dateRange) return;
      whereConditions.push('sign_in_time >= ? AND sign_in_time < ?');
      whereParams.push(dateRange.start, dateRange.end);
    }
    if (effectiveLocation) {
      // 地点筛选同时匹配地点编码和地点中文名，方便管理员按显示名称搜索。
      whereConditions.push(`(
          location LIKE ? OR EXISTS (
            SELECT 1
            FROM locat
            WHERE locat_en = sign_in_records.location
              AND locat_cn LIKE ?
          )
        )`);
      whereParams.push(`%${effectiveLocation}%`, `%${effectiveLocation}%`);
    }
    // 没有筛选条件时 whereSql 为空，表示查询全部记录。
    const whereSql = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // 先查询总数，用于计算总页数和修正越界页码。
    const [countRows] = await db.query(
      `SELECT COUNT(*) AS total FROM sign_in_records ${whereSql}`,
      whereParams
    );
    const total = Number(countRows[0]?.total) || 0;
    // totalPages 至少为 1，避免前端分页组件出现 0 页。
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    // 如果请求页码超过总页数，回落到最后一页。
    const safePage = Math.min(page, totalPages);
    const safeOffset = (safePage - 1) * pageSize;

    // 查询当前页记录，按签到时间倒序展示最近记录。
    const [records] = await db.query(
      `SELECT id, name, student_id, action_type, location, sign_in_time, sign_out_time, timeadd
         FROM sign_in_records
        ${whereSql}
        ORDER BY sign_in_time DESC
        LIMIT ? OFFSET ?`,
      [...whereParams, pageSize, safeOffset]
    );

    // 读取地点编码和中文名，返回 locatMap 给前端把编码转换成显示名称。
    const [locatRows] = await db.query(`
      SELECT locat_en, locat_cn
      FROM locat
      WHERE locat_en IS NOT NULL AND TRIM(locat_en) <> ''
    `);
    const locatMap = {};
    locatRows.forEach((row) => {
      // 跳过空地点编码，中文名为空时使用编码兜底。
      const code = typeof row.locat_en === 'string' ? row.locat_en.trim() : '';
      if (!code) return;
      locatMap[code] = typeof row.locat_cn === 'string' && row.locat_cn.trim() ? row.locat_cn.trim() : code;
    });

    // 把数据库字段转换成前端字段名，并统一时间格式。
    const list = records.map((row) => ({
      id: row.id,
      name: row.name || '',
      studentId: row.student_id || '',
      actionType: row.action_type || '',
      location: row.location || '',
      signInTime: row.sign_in_time ? formatTimestamp(row.sign_in_time) : '',
      signOutTime: row.sign_out_time ? formatTimestamp(row.sign_out_time) : '',
      timeadd: row.timeadd === null || row.timeadd === undefined ? '' : Number(row.timeadd)
    }));

    // 审计查询动作，记录分页信息和筛选条件摘要。
    logAudit('查询签到记录', {
      ...requestMeta(req),
      ...authMeta(auth),
      页码: safePage,
      每页数量: pageSize,
      总数: total,
      返回数量: list.length,
      筛选条件: buildSignRecordsFilterLabel({ name, studentId, date, location: effectiveLocation, locatMap })
    });
    // 返回分页元信息、当前页列表和地点映射。
    res.json({
      page: safePage,
      pageSize,
      total,
      totalPages,
      list,
      locatMap
    });
  } catch (err) {
    // 捕获鉴权、计数查询、列表查询或地点映射查询异常。
    logger.error(`获取签到记录列表失败: ${err.message}`);
    res.status(500).json({ message: '获取签到记录列表失败' });
  }
});

// 总时长排行榜接口：按 student_id 汇总 timeadd，分页返回累计服务时长排行。
app.get('/timeadd-ranking', async (req, res) => {
  try {
    // 排行榜包含学生累计时长，也需要先鉴权。
    const auth = await resolveAuth(req);
    if (!auth.ok) {
      // 失败日志带上请求页码，便于识别异常访问。
      logAudit('查询时长排行榜失败', { ...requestMeta(req), 页码: req.query.page || '-', 原因: auth.message }, 'warn');
      return res.status(auth.message === '非法请求！' ? 400 : 403).json({ message: auth.message });
    }

    // 排行榜每页固定 50 条，避免客户端传过大的 pageSize。
    const pageSize = 50;
    const requestedPage = Number.parseInt(req.query.page, 10);
    const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

    // 先统计有有效累计时长的学生数量，用于分页。
    const [countRows] = await db.query(`
      SELECT COUNT(*) AS total
      FROM (
        SELECT ROUND(SUM(COALESCE(timeadd, 0)), 2) AS total_hours
        FROM sign_in_records
        GROUP BY student_id
        HAVING total_hours > 0
      ) ranked
    `);
    const total = Number(countRows[0]?.total) || 0;
    // 总页数至少为 1，避免空数据时分页字段异常。
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    // 请求页码超过总页数时回落到最后一页。
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * pageSize;

    // 按 student_id 汇总服务时长，并统计记录数、完成次数和最后签退时间。
    const [rows] = await db.query(`
      SELECT
        student_id,
        MAX(name) AS name,
        ROUND(SUM(COALESCE(timeadd, 0)), 2) AS total_hours,
        COUNT(*) AS record_count,
        SUM(CASE WHEN sign_out_time IS NOT NULL THEN 1 ELSE 0 END) AS completed_count,
        MAX(sign_out_time) AS last_sign_out_time
      FROM sign_in_records
      GROUP BY student_id
      HAVING total_hours > 0
      ORDER BY total_hours DESC, student_id ASC
      LIMIT ? OFFSET ?
    `, [pageSize, offset]);

    // 转换排行榜返回结构，rank 基于当前页 offset 计算全局名次。
    const list = rows.map((row, index) => {
      const totalHours = Number(row.total_hours) || 0;
      return {
        rank: offset + index + 1,
        studentId: row.student_id,
        name: row.name || '',
        totalHours,
        totalMinutes: Math.max(0, Math.round(totalHours * 60)),
        recordCount: Number(row.record_count) || 0,
        completedCount: Number(row.completed_count) || 0,
        lastSignOutTime: row.last_sign_out_time ? formatTimestamp(row.last_sign_out_time) : null
      };
    });

    // 审计排行榜查询，记录页码、总数和本次返回数量。
    logAudit('查询时长排行榜', { ...requestMeta(req), ...authMeta(auth), 页码: safePage, 每页数量: pageSize, 总数: total, 返回数量: list.length });
    // 生成时间使用统一业务时间，前端可展示数据刷新时间。
    const businessTime = getBusinessNow(req, res);
    if (!businessTime) return;
    res.json({
      generatedAt: businessTime.nowIso,
      page: safePage,
      pageSize,
      total,
      totalPages,
      list
    });
  } catch (err) {
    // 捕获鉴权、汇总查询或时间获取异常。
    logger.error(`获取时长排行榜失败: ${err.message}`);
    res.status(500).json({ message: '获取时长排行榜失败' });
  }
});

}

module.exports = registerUserRoutes;
