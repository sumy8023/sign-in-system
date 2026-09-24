// 本文件注册管理员接口：地点配置、普通密钥管理，以及管理员对签到记录的修改和删除。
const { logger, db, USER_KEY_TABLE, ADMIN_KEY_TABLE, LOCAT_TABLE, clearUserKeySessionsById, getBusinessNow, resolveAuth, resolveAdminAuth } = require('../config/shared');
const { requestMeta, authMeta, keyMeta, keyActionMeta, signRecordActionMeta, maskSecret, logAudit } = require('../config/audit');
const { normalizeLocat, normalizeEnabled, normalizeAudio, normalizeLocationBinding, validateUserLocationBinding, replaceLocationBindingValue, enabledLabel } = require('../config/utils');

// SQL 侧判断普通密钥逗号分隔地点绑定是否显式包含某个地点；* 不需要随地点重命名或删除同步。
const USER_LOCATION_BOUND_SQL = `(TRIM(location) <> '*' AND FIND_IN_SET(?, REPLACE(location, ' ', '')) > 0)`;

function isReservedLocatCode(locatEn) {
  return locatEn === '*' || locatEn.includes(',');
}

// 注册所有管理员相关路由到 Express 应用实例。
function registerAdminRoutes(app) {
// 管理员地点列表接口：返回所有地点配置，包括编码、名称、人数上限、提示文案、启用状态和音频状态。
app.get('/admin/locats', async (req, res) => {
  try {
    // 管理员接口统一先校验管理员身份，失败时 resolveAdminAuth 会直接写响应。
    const auth = await resolveAdminAuth(req, res);
    if (!auth) return;
    // 查询全部地点配置，按 id 升序返回，方便后台表格保持稳定顺序。
    const [rows] = await db.query(
      `SELECT id, locat_en, locat_cn, max_people, info_text, enabled, audio FROM ${LOCAT_TABLE} ORDER BY id ASC`
    );
    // 记录管理员查看动作和返回数量，便于审计后台配置访问。
    logAudit('管理员查看地点配置', { ...requestMeta(req), ...authMeta(auth), 返回数量: rows.length });
    res.json({ list: rows });
  } catch (err) {
    // 捕获鉴权以外的数据库查询异常。
    logger.error('获取地点配置失败:', err);
    res.status(500).json({ message: '获取地点配置失败' });
  }
});

// 管理员新增地点接口：新增一个签到地点配置，并校验编码、名称和人数上限。
app.post('/admin/locats', async (req, res) => {
  try {
    // 新增地点属于后台配置操作，必须是管理员密钥。
    const auth = await resolveAdminAuth(req, res);
    if (!auth) return;
    // locat_en 是内部编码，统一规范化；locat_cn 是前端展示名称。
    const locatEn = normalizeLocat(req.body.locat_en);
    const locatCn = typeof req.body.locat_cn === 'string' ? req.body.locat_cn.trim() : '';
    // max_people 先转成字符串判断是否填写，再转数字校验是否为非负整数。
    const maxPeopleText = req.body.max_people === undefined || req.body.max_people === null ? '' : String(req.body.max_people).trim();
    const maxPeople = Number(maxPeopleText);
    // enabled/audio 都规范成 0/1，默认新增为启用并开启音频。
    const enabled = normalizeEnabled(req.body.enabled, 1);
    const audio = normalizeAudio(req.body.audio, 1);
    // info_text 为空时使用默认提示，避免前端拿到空值不好展示。
    const infoText = typeof req.body.info_text === 'string' ? req.body.info_text.trim() : '暂无记录';
    if (!locatEn) {
      // 地点编码不能为空，否则无法作为二维码和密钥绑定的稳定标识。
      logAudit('管理员新增地点失败', { ...requestMeta(req), ...authMeta(auth), 原因: '英文编码为空' }, 'warn');
      return res.status(400).json({ message: '英文编码不能为空' });
    }
    if (isReservedLocatCode(locatEn)) {
      // * 和英文逗号用于普通密钥多地点绑定语法，不能作为地点编码。
      logAudit('管理员新增地点失败', { ...requestMeta(req), ...authMeta(auth), 新增地点: locatEn, 原因: '英文编码包含保留字符' }, 'warn');
      return res.status(400).json({ message: '英文编码不能使用 * 或英文逗号' });
    }
    if (!locatCn) {
      // 中文名用于后台和展示端显示，必须填写。
      logAudit('管理员新增地点失败', { ...requestMeta(req), ...authMeta(auth), 新增地点: locatEn, 原因: '中文编码为空' }, 'warn');
      return res.status(400).json({ message: '中文编码不能为空' });
    }
    if (!maxPeopleText) {
      // 人数上限必须明确填写，0 表示不限制。
      logAudit('管理员新增地点失败', { ...requestMeta(req), ...authMeta(auth), 新增地点: locatEn, 地点中文: locatCn, 原因: '人数上限为空' }, 'warn');
      return res.status(400).json({ message: '人数上限不能为空' });
    }
    if (!Number.isInteger(maxPeople) || maxPeople < 0) {
      // 只允许非负整数，避免小数或负数导致人数判断异常。
      logAudit('管理员新增地点失败', { ...requestMeta(req), ...authMeta(auth), 新增地点: locatEn, 地点中文: locatCn, 人数上限: maxPeopleText, 原因: '人数上限非法' }, 'warn');
      return res.status(400).json({ message: '人数上限必须是非负整数' });
    }

    // 新增前检查英文编码唯一性，TRIM 后比较避免尾部空格造成重复地点。
    const [exists] = await db.query(`SELECT id FROM ${LOCAT_TABLE} WHERE TRIM(locat_en) = ? LIMIT 1`, [locatEn]);
    if (exists.length > 0) {
      // 编码已存在返回 409，提示前端这是资源冲突而不是格式错误。
      logAudit('管理员新增地点失败', { ...requestMeta(req), ...authMeta(auth), 新增地点: locatEn, 地点中文: locatCn, 原因: '英文编码已存在' }, 'warn');
      return res.status(409).json({ message: '英文编码已存在' });
    }

    // 写入地点配置，使用参数占位符保存所有管理员输入。
    const [result] = await db.query(
      `INSERT INTO ${LOCAT_TABLE} (locat_en, locat_cn, max_people, info_text, enabled, audio) VALUES (?, ?, ?, ?, ?, ?)`,
      [locatEn, locatCn, maxPeople, infoText || '暂无记录', enabled, audio]
    );
    // 审计新增地点，记录新 id、编码、中文名、人数上限和音频开关。
    logAudit('管理员新增地点', { ...requestMeta(req), ...authMeta(auth), 地点ID: result.insertId, 新增地点: locatEn, 地点中文: locatCn, 人数上限: maxPeople, 音频: enabledLabel(audio) });
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    // 捕获数据库插入异常。
    logger.error('新增地点配置失败:', err);
    res.status(500).json({ message: '新增地点配置失败' });
  }
});

// 管理员修改地点接口：更新地点配置，地点编码变化时同步更新绑定到该地点的密钥。
app.put('/admin/locats/:id', async (req, res) => {
  try {
    // 修改地点必须先确认管理员身份。
    const auth = await resolveAdminAuth(req, res);
    if (!auth) return;
    // 路由参数 id 必须是正整数，对应 locat 表主键。
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      logAudit('管理员修改地点失败', { ...requestMeta(req), ...authMeta(auth), 地点ID: req.params.id, 原因: '地点ID非法' }, 'warn');
      return res.status(400).json({ message: '无效的地点 ID' });
    }

    // 解析并规范化新的地点配置字段。
    const locatEn = normalizeLocat(req.body.locat_en);
    const locatCn = typeof req.body.locat_cn === 'string' ? req.body.locat_cn.trim() : '';
    const maxPeopleText = req.body.max_people === undefined || req.body.max_people === null ? '' : String(req.body.max_people).trim();
    const maxPeople = Number(maxPeopleText);
    const enabled = normalizeEnabled(req.body.enabled, 1);
    const infoText = typeof req.body.info_text === 'string' ? req.body.info_text.trim() : '暂无记录';
    if (!locatEn) {
      // 修改后编码不能为空，否则已有二维码和密钥绑定无法定位地点。
      logAudit('管理员修改地点失败', { ...requestMeta(req), ...authMeta(auth), 地点ID: id, 原因: '英文编码为空' }, 'warn');
      return res.status(400).json({ message: '英文编码不能为空' });
    }
    if (isReservedLocatCode(locatEn)) {
      logAudit('管理员修改地点失败', { ...requestMeta(req), ...authMeta(auth), 地点ID: id, 修改地点: locatEn, 原因: '英文编码包含保留字符' }, 'warn');
      return res.status(400).json({ message: '英文编码不能使用 * 或英文逗号' });
    }
    if (!locatCn) {
      // 中文名不能为空，后台列表和展示端都依赖它显示地点。
      logAudit('管理员修改地点失败', { ...requestMeta(req), ...authMeta(auth), 地点ID: id, 修改地点: locatEn, 原因: '中文编码为空' }, 'warn');
      return res.status(400).json({ message: '中文编码不能为空' });
    }
    if (!maxPeopleText) {
      // 要求显式填写人数上限；0 表示不限人数。
      logAudit('管理员修改地点失败', { ...requestMeta(req), ...authMeta(auth), 地点ID: id, 修改地点: locatEn, 地点中文: locatCn, 原因: '人数上限为空' }, 'warn');
      return res.status(400).json({ message: '人数上限不能为空' });
    }
    if (!Number.isInteger(maxPeople) || maxPeople < 0) {
      // 非负整数校验与新增地点保持一致。
      logAudit('管理员修改地点失败', { ...requestMeta(req), ...authMeta(auth), 地点ID: id, 修改地点: locatEn, 地点中文: locatCn, 人数上限: maxPeopleText, 原因: '人数上限非法' }, 'warn');
      return res.status(400).json({ message: '人数上限必须是非负整数' });
    }

    // 读取当前地点配置，用于确认存在、比较变更前后状态，并在编码变化时同步密钥。
    const [currentRows] = await db.query(`SELECT id, locat_en, locat_cn, max_people, info_text, enabled, audio FROM ${LOCAT_TABLE} WHERE id = ? LIMIT 1`, [id]);
    if (currentRows.length === 0) {
      // id 不存在时返回 404，避免把 update 当成新增。
      logAudit('管理员修改地点失败', { ...requestMeta(req), ...authMeta(auth), 地点ID: id, 原因: '地点不存在' }, 'warn');
      return res.status(404).json({ message: '地点不存在' });
    }
    // 旧编码用于后续同步普通密钥和管理员密钥的绑定地点。
    const oldLocatEn = normalizeLocat(currentRows[0].locat_en);

    // 检查新编码是否与其他地点冲突，排除当前 id。
    const [exists] = await db.query(`SELECT id FROM ${LOCAT_TABLE} WHERE TRIM(locat_en) = ? AND id <> ? LIMIT 1`, [locatEn, id]);
    if (exists.length > 0) {
      logAudit('管理员修改地点失败', { ...requestMeta(req), ...authMeta(auth), 地点ID: id, 原地点: oldLocatEn, 新地点: locatEn, 原因: '英文编码已存在' }, 'warn');
      return res.status(409).json({ message: '英文编码已存在' });
    }

    // audio 没传时沿用原值，避免旧前端只提交部分字段时误关闭音频。
    const audio = normalizeAudio(req.body.audio, normalizeAudio(currentRows[0].audio, 1));

    // 更新地点主表配置。
    await db.query(
      `UPDATE ${LOCAT_TABLE} SET locat_en = ?, locat_cn = ?, max_people = ?, info_text = ?, enabled = ?, audio = ? WHERE id = ?`,
      [locatEn, locatCn, maxPeople, infoText || '暂无记录', enabled, audio, id]
    );
    // 记录地点编码变化时同步影响的密钥数量。
    let userBindAffected = 0;
    let adminBindAffected = 0;
    if (oldLocatEn && oldLocatEn !== locatEn) {
      // 地点编码改变后，所有绑定旧编码的密钥都要同步到新编码；普通密钥可能绑定多个地点。
      const businessTime = getBusinessNow(req, res);
      if (!businessTime) return;
      const [userKeyRows] = await db.query(
        `SELECT id, location FROM ${USER_KEY_TABLE} WHERE ${USER_LOCATION_BOUND_SQL}`,
        [oldLocatEn]
      );
      for (const row of userKeyRows) {
        const nextLocation = replaceLocationBindingValue(row.location, oldLocatEn, locatEn);
        if (nextLocation && nextLocation !== normalizeLocationBinding(row.location)) {
          await db.query(`UPDATE ${USER_KEY_TABLE} SET location = ?, updated_at = ? WHERE id = ?`, [nextLocation, businessTime.nowDateTime, row.id]);
          userBindAffected += 1;
        }
      }
      const [adminBindResult] = await db.query(`UPDATE ${ADMIN_KEY_TABLE} SET location = ?, updated_at = ? WHERE location = ?`, [locatEn, businessTime.nowDateTime, oldLocatEn]);
      // affectedRows 用于审计同步范围。
      adminBindAffected = adminBindResult.affectedRows || 0;
    }
    // 旧状态用于审计是普通修改、启用还是关闭地点。
    const oldEnabled = Number(currentRows[0].enabled) === 1 ? 1 : 0;
    const oldAudio = normalizeAudio(currentRows[0].audio, 1);
    const locatOperation = oldEnabled !== enabled
      ? (enabled === 1 ? '启用地点' : '关闭地点')
      : '修改地点配置';
    // 记录修改前后关键字段，方便追溯配置变化。
    logAudit('管理员修改地点', {
      ...requestMeta(req),
      ...authMeta(auth),
      操作: locatOperation,
      地点ID: id,
      原地点: oldLocatEn,
      新地点: locatEn,
      原地点中文: currentRows[0].locat_cn || '-',
      新地点中文: locatCn,
      人数上限: maxPeople,
      状态变化: oldEnabled === enabled ? enabledLabel(enabled) : `${enabledLabel(oldEnabled)} -> ${enabledLabel(enabled)}`,
      音频变化: oldAudio === audio ? enabledLabel(audio) : `${enabledLabel(oldAudio)} -> ${enabledLabel(audio)}`,
      普通密钥地点同步数: userBindAffected,
      管理员密钥地点同步数: adminBindAffected
    });
    res.json({ ok: true });
  } catch (err) {
    // 捕获查询、更新和同步密钥绑定时的异常。
    logger.error('修改地点配置失败:', err);
    res.status(500).json({ message: '修改地点配置失败' });
  }
});

// 管理员删除地点接口：删除未被任何普通密钥或管理员密钥绑定的地点配置。
app.delete('/admin/locats/:id', async (req, res) => {
  try {
    // 删除地点必须先确认管理员身份。
    const auth = await resolveAdminAuth(req, res);
    if (!auth) return;
    // id 必须是 locat 表的正整数主键。
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      logAudit('管理员删除地点失败', { ...requestMeta(req), ...authMeta(auth), 地点ID: req.params.id, 原因: '地点ID非法' }, 'warn');
      return res.status(400).json({ message: '无效的地点 ID' });
    }

    // 删除前读取地点当前信息，用于确认存在和记录审计日志。
    const [currentRows] = await db.query(`SELECT id, locat_en, locat_cn, max_people, info_text, enabled FROM ${LOCAT_TABLE} WHERE id = ? LIMIT 1`, [id]);
    if (currentRows.length === 0) {
      logAudit('管理员删除地点失败', { ...requestMeta(req), ...authMeta(auth), 地点ID: id, 原因: '地点不存在' }, 'warn');
      return res.status(404).json({ message: '地点不存在' });
    }
    // 使用规范化后的地点编码检查密钥绑定。
    const locatEn = normalizeLocat(currentRows[0].locat_en);
    // 删除地点前检查普通密钥和管理员密钥是否仍绑定该地点；普通密钥的 * 会绑定所有地点。
    const [boundRows] = await db.query(
      `SELECT
        (SELECT COUNT(*) FROM ${USER_KEY_TABLE} WHERE ${USER_LOCATION_BOUND_SQL}) AS userCount,
        (SELECT COUNT(*) FROM ${ADMIN_KEY_TABLE} WHERE location = ?) AS adminCount`,
      [locatEn, locatEn]
    );
    // 两类密钥任意一种仍绑定时都不能删除，防止产生悬空绑定。
    const boundCount = Number(boundRows[0].userCount || 0) + Number(boundRows[0].adminCount || 0);
    if (boundCount > 0) {
      logAudit('管理员删除地点失败', { ...requestMeta(req), ...authMeta(auth), 地点ID: id, 删除地点: locatEn, 绑定普通密钥数: boundRows[0].userCount || 0, 绑定管理员密钥数: boundRows[0].adminCount || 0, 原因: '仍有密钥绑定' }, 'warn');
      return res.status(409).json({ message: '该地点仍有密钥绑定，不能删除' });
    }

    // 没有密钥绑定时才真正删除地点配置。
    await db.query(`DELETE FROM ${LOCAT_TABLE} WHERE id = ?`, [id]);
    logAudit('管理员删除地点', { ...requestMeta(req), ...authMeta(auth), 地点ID: id, 删除地点: locatEn, 地点中文: currentRows[0].locat_cn || '-', 人数上限: currentRows[0].max_people });
    res.json({ ok: true });
  } catch (err) {
    // 捕获查询绑定数量或删除地点时的异常。
    logger.error('删除地点配置失败:', err);
    res.status(500).json({ message: '删除地点配置失败' });
  }
});

// 管理员普通密钥列表接口：返回普通密钥、在线状态、绑定地点和最近登录信息。
app.get('/admin/user-keys', async (req, res) => {
  try {
    // 读取普通密钥列表必须是管理员。
    const auth = await resolveAdminAuth(req, res);
    if (!auth) return;
    // 普通密钥可绑定多个地点或 *；单地点仍返回 location_cn 兼容旧前端。
    const [rows] = await db.query(`
      SELECT
        uk.id,
        uk.\`key\`,
        uk.enabled,
        uk.online,
        uk.location,
        uk.forced_logout_at,
        uk.last_login_at,
        uk.updated_at,
        l.locat_cn AS location_cn
      FROM ${USER_KEY_TABLE} uk
      LEFT JOIN ${LOCAT_TABLE} l ON TRIM(l.locat_en) = TRIM(uk.location)
      ORDER BY uk.id ASC
    `);
    // 审计管理员查看普通密钥列表的动作，不直接记录明文密钥。
    logAudit('管理员查看普通密钥列表', { ...requestMeta(req), ...authMeta(auth), 返回数量: rows.length });
    res.json({ list: rows });
  } catch (err) {
    // 捕获密钥列表查询异常。
    logger.error('获取普通密钥列表失败:', err);
    res.status(500).json({ message: '获取普通密钥列表失败' });
  }
});

// 管理员新增普通密钥接口：创建普通展示端密钥并绑定到启用地点。
app.post('/admin/user-keys', async (req, res) => {
  try {
    // 新增普通密钥必须先通过管理员鉴权。
    const auth = await resolveAdminAuth(req, res);
    if (!auth) return;
    // key 是展示端登录密钥，location 是绑定地点，enabled 是启用状态。
    const key = typeof req.body.key === 'string' ? req.body.key.trim() : '';
    const location = normalizeLocationBinding(req.body.location);
    const enabled = normalizeEnabled(req.body.enabled, 1);
    if (!key) {
      // 密钥为空无法登录，直接拒绝。
      logAudit('管理员新增普通密钥失败', { ...requestMeta(req), ...authMeta(auth), 绑定地点: location, 原因: '密钥为空' }, 'warn');
      return res.status(400).json({ message: '密钥不能为空' });
    }
    if (!location) {
      // 普通密钥必须绑定具体地点，后续生成二维码会按地点做权限校验。
      logAudit('管理员新增普通密钥失败', { ...requestMeta(req), ...authMeta(auth), ...keyMeta(key), 原因: '绑定地点为空' }, 'warn');
      return res.status(400).json({ message: '绑定地点不能为空' });
    }
    const locationCheck = await validateUserLocationBinding(location);
    if (!locationCheck.ok) {
      // 只能绑定 * 或已存在且启用的地点，避免创建后无法使用。
      logAudit('管理员新增普通密钥失败', { ...requestMeta(req), ...authMeta(auth), ...keyMeta(key), 绑定地点: location, 原因: '绑定地点不存在或已关闭' }, 'warn');
      return res.status(400).json({ message: locationCheck.message || '绑定地点不存在' });
    }

    // 检查普通密钥表内是否已有相同 key，避免登录时无法区分。
    const [exists] = await db.query(`SELECT id FROM ${USER_KEY_TABLE} WHERE \`key\` = ? LIMIT 1`, [key]);
    if (exists.length > 0) {
      logAudit('管理员新增普通密钥失败', { ...requestMeta(req), ...authMeta(auth), ...keyMeta(key), 绑定地点: location, 已存在ID: exists[0].id, 原因: '密钥已存在' }, 'warn');
      return res.status(409).json({ message: '密钥已存在' });
    }

    // 获取业务时间用于 updated_at，新密钥默认 online=0。
    const businessTime = getBusinessNow(req, res);
    if (!businessTime) return;
    const [result] = await db.query(
      `INSERT INTO ${USER_KEY_TABLE} (\`key\`, enabled, online, location, updated_at) VALUES (?, ?, 0, ?, ?)`,
      [key, enabled, location, businessTime.nowDateTime]
    );
    // 审计新增密钥，密钥值只记录脱敏后的内容。
    logAudit('管理员新增普通密钥', {
      ...requestMeta(req),
      ...authMeta(auth),
      密钥ID: result.insertId,
      新增密钥: maskSecret(key),
      绑定地点: location
    });
    res.json({ ok: true, id: result.insertId });
  } catch (err) {
    // 捕获地点校验、唯一性检查或插入异常。
    logger.error('新增普通密钥失败:', err);
    res.status(500).json({ message: '新增普通密钥失败' });
  }
});

// 管理员修改普通密钥接口：更新普通密钥值、启用状态和绑定地点，禁用时同步下线。
app.put('/admin/user-keys/:id', async (req, res) => {
  try {
    // 修改普通密钥必须先确认管理员身份。
    const auth = await resolveAdminAuth(req, res);
    if (!auth) return;
    // id 是普通密钥表主键，必须为正整数。
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      logAudit('管理员修改普通密钥失败', { ...requestMeta(req), ...authMeta(auth), 密钥ID: req.params.id, 原因: '密钥ID非法' }, 'warn');
      return res.status(400).json({ message: '无效的密钥 ID' });
    }

    // 解析新的密钥值、绑定地点和启用状态。
    const key = typeof req.body.key === 'string' ? req.body.key.trim() : '';
    const location = normalizeLocationBinding(req.body.location);
    const enabled = normalizeEnabled(req.body.enabled, 1);
    if (!key) {
      // 更新后的密钥不能为空。
      logAudit('管理员修改普通密钥失败', { ...requestMeta(req), ...authMeta(auth), 密钥ID: id, 绑定地点: location, 原因: '密钥为空' }, 'warn');
      return res.status(400).json({ message: '密钥不能为空' });
    }
    if (!location) {
      // 普通密钥必须绑定地点。
      logAudit('管理员修改普通密钥失败', { ...requestMeta(req), ...authMeta(auth), 密钥ID: id, ...keyMeta(key), 原因: '绑定地点为空' }, 'warn');
      return res.status(400).json({ message: '绑定地点不能为空' });
    }
    const locationCheck = await validateUserLocationBinding(location);
    if (!locationCheck.ok) {
      // 绑定地点必须是 * 或存在且启用，避免密钥更新后无法生成二维码。
      logAudit('管理员修改普通密钥失败', { ...requestMeta(req), ...authMeta(auth), 密钥ID: id, ...keyMeta(key), 绑定地点: location, 原因: '绑定地点不存在或已关闭' }, 'warn');
      return res.status(400).json({ message: locationCheck.message || '绑定地点不存在' });
    }

    // 读取当前密钥，用于确认存在、审计旧值和判断禁用下线。
    const [currentRows] = await db.query(`SELECT id, \`key\`, enabled, online, location, forced_logout_at, last_login_at FROM ${USER_KEY_TABLE} WHERE id = ? LIMIT 1`, [id]);
    if (currentRows.length === 0) {
      logAudit('管理员修改普通密钥失败', { ...requestMeta(req), ...authMeta(auth), 密钥ID: id, ...keyMeta(key), 绑定地点: location, 原因: '密钥不存在' }, 'warn');
      return res.status(404).json({ message: '密钥不存在' });
    }

    // 检查新 key 是否被其他普通密钥占用，排除当前记录。
    const [exists] = await db.query(`SELECT id FROM ${USER_KEY_TABLE} WHERE \`key\` = ? AND id <> ? LIMIT 1`, [key, id]);
    if (exists.length > 0) {
      logAudit('管理员修改普通密钥失败', { ...requestMeta(req), ...authMeta(auth), 密钥ID: id, ...keyMeta(key), 绑定地点: location, 已存在ID: exists[0].id, 原因: '密钥已存在' }, 'warn');
      return res.status(409).json({ message: '密钥已存在' });
    }

    // 获取业务时间用于 updated_at。
    const businessTime = getBusinessNow(req, res);
    if (!businessTime) return;
    // 更新密钥值、启用状态和绑定地点。
    const [result] = await db.query(
      `UPDATE ${USER_KEY_TABLE} SET \`key\` = ?, enabled = ?, location = ?, updated_at = ? WHERE id = ?`,
      [key, enabled, location, businessTime.nowDateTime, id]
    );
    if (result.affectedRows === 0) {
      // 极端情况下 UPDATE 未命中，记录无变化日志供排查。
      logAudit('管理员修改普通密钥无变化', { ...requestMeta(req), ...authMeta(auth), 密钥ID: id, ...keyActionMeta(currentRows[0], '修改密钥', '原绑定地点') });
    }
    // 如果密钥、绑定地点或启用状态变更，需要清理旧页面会话，前端心跳会重新校验。
    let offlineAffected = 0;
    let clearedSessions = 0;
    const keyChanged = currentRows[0].key !== key;
    const locationChanged = normalizeLocat(currentRows[0].location) !== location;
    if (enabled !== 1 || keyChanged || locationChanged) {
      clearedSessions = await clearUserKeySessionsById(id);
      const [offlineResult] = await db.query(`UPDATE ${USER_KEY_TABLE} SET online = 0, updated_at = ? WHERE id = ?`, [businessTime.nowDateTime, id]);
      offlineAffected = offlineResult.affectedRows || 0;
    }
    // 审计修改前后的密钥和绑定地点，密钥值脱敏记录。
    logAudit('管理员修改普通密钥', {
      ...requestMeta(req),
      ...authMeta(auth),
      密钥ID: id,
      原密钥: maskSecret(currentRows[0].key),
      新密钥: maskSecret(key),
      原绑定地点: currentRows[0].location || '-',
      新绑定地点: location,
      清理会话数: clearedSessions,
      禁用下线数: offlineAffected
    });
    res.json({ ok: true });
  } catch (err) {
    // 捕获查询、唯一性校验、更新或禁用下线异常。
    logger.error('修改普通密钥失败:', err);
    res.status(500).json({ message: '修改普通密钥失败' });
  }
});

// 管理员删除普通密钥接口：删除指定普通展示端密钥。
app.delete('/admin/user-keys/:id', async (req, res) => {
  try {
    // 删除普通密钥必须先确认管理员身份。
    const auth = await resolveAdminAuth(req, res);
    if (!auth) return;
    // id 必须是普通密钥表的正整数主键。
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      logAudit('管理员删除普通密钥失败', { ...requestMeta(req), ...authMeta(auth), 密钥ID: req.params.id, 原因: '密钥ID非法' }, 'warn');
      return res.status(400).json({ message: '无效的密钥 ID' });
    }
    // 删除前读取当前密钥信息，用于确认存在和记录删除审计。
    const [currentRows] = await db.query(`SELECT id, \`key\`, enabled, online, location, forced_logout_at, last_login_at FROM ${USER_KEY_TABLE} WHERE id = ? LIMIT 1`, [id]);
    if (currentRows.length === 0) {
      logAudit('管理员删除普通密钥失败', { ...requestMeta(req), ...authMeta(auth), 密钥ID: id, 原因: '密钥不存在' }, 'warn');
      return res.status(404).json({ message: '密钥不存在' });
    }
    // 执行删除前先清理会话表，避免外键缺失或残留在线会话。
    const clearedSessions = await clearUserKeySessionsById(id);
    // 执行删除；只按 id 删除，避免误删其他密钥。
    const [result] = await db.query(`DELETE FROM ${USER_KEY_TABLE} WHERE id = ?`, [id]);
    if (result.affectedRows === 0) {
      // 查询到但删除未命中，记录异常状态。
      logAudit('管理员删除普通密钥失败', { ...requestMeta(req), ...authMeta(auth), 密钥ID: id, ...keyActionMeta(currentRows[0], '删除密钥', '删除密钥地点'), 原因: '删除未命中' }, 'warn');
      return res.status(404).json({ message: '密钥不存在' });
    }
    // 审计删除动作，记录被删除密钥的脱敏信息和绑定地点。
    logAudit('管理员删除普通密钥', { ...requestMeta(req), ...authMeta(auth), 密钥ID: id, ...keyActionMeta(currentRows[0], '删除密钥', '删除密钥地点'), 清理会话数: clearedSessions });
    res.json({ ok: true });
  } catch (err) {
    // 捕获查询或删除异常。
    logger.error('删除普通密钥失败:', err);
    res.status(500).json({ message: '删除普通密钥失败' });
  }
});

// 管理员强制下线普通密钥接口：把指定普通密钥置为离线并记录 forced_logout_at。
app.post('/admin/user-keys/:id/force-logout', async (req, res) => {
  try {
    // 强制下线是管理员操作，先校验管理员身份。
    const auth = await resolveAdminAuth(req, res);
    if (!auth) return;
    // id 必须是普通密钥表主键。
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      logAudit('管理员强制下线普通密钥失败', { ...requestMeta(req), ...authMeta(auth), 密钥ID: req.params.id, 原因: '密钥ID非法' }, 'warn');
      return res.status(400).json({ message: '无效的密钥 ID' });
    }
    // 下线前读取密钥信息，用于确认存在和记录审计。
    const [currentRows] = await db.query(`SELECT id, \`key\`, enabled, online, location, forced_logout_at, last_login_at FROM ${USER_KEY_TABLE} WHERE id = ? LIMIT 1`, [id]);
    if (currentRows.length === 0) {
      logAudit('管理员强制下线普通密钥失败', { ...requestMeta(req), ...authMeta(auth), 密钥ID: id, 原因: '密钥不存在' }, 'warn');
      return res.status(404).json({ message: '密钥不存在' });
    }
    // forced_logout_at 用业务时间写入，前端心跳/登录会据此识别被强制下线。
    const businessTime = getBusinessNow(req, res);
    if (!businessTime) return;
    const [result] = await db.query(
      `UPDATE ${USER_KEY_TABLE} SET online = 0, forced_logout_at = ?, updated_at = ? WHERE id = ?`,
      [businessTime.nowDateTime, businessTime.nowDateTime, id]
    );
    const clearedSessions = await clearUserKeySessionsById(id);
    if (result.affectedRows === 0) {
      // 极端并发下未命中更新时记录无变化日志。
      logAudit('管理员强制下线普通密钥无变化', { ...requestMeta(req), ...authMeta(auth), 密钥ID: id, ...keyActionMeta(currentRows[0], '被强制下线密钥', '被强制下线地点') });
    }
    // 审计强制下线动作，前端下一次心跳会收到 KEY_FORCED_LOGOUT。
    logAudit('管理员强制下线普通密钥', { ...requestMeta(req), ...authMeta(auth), 密钥ID: id, ...keyActionMeta(currentRows[0], '被强制下线密钥', '被强制下线地点'), 清理会话数: clearedSessions });
    res.json({ ok: true });
  } catch (err) {
    // 捕获查询或更新下线状态异常。
    logger.error('强制下线失败:', err);
    res.status(500).json({ message: '强制下线失败' });
  }
});

// 管理员修改签到记录接口：允许管理员编辑签到详情中的姓名、学号、状态、地点和时间字段。
app.put('/sign-records/:id', async (req, res) => {
  try {
    // 这里使用通用鉴权拿到角色，再额外限制必须是 admin。
    const auth = await resolveAuth(req);
    if (!auth.ok) {
      // 鉴权失败时不继续解析请求体，直接返回权限错误。
      logAudit('管理员修改签到记录失败', { ...requestMeta(req), 记录ID: req.params.id, 原因: auth.message }, 'warn');
      return res.status(403).json({ message: auth.message });
    }
    if (auth.role !== 'admin') {
      // 普通展示端密钥不能修改签到记录。
      logAudit('管理员修改签到记录失败', { ...requestMeta(req), ...authMeta(auth), 记录ID: req.params.id, 原因: '非管理员操作' }, 'warn');
      return res.status(403).json({ message: '仅管理员可操作' });
    }

    // 记录 id 必须是 sign_in_records 表的正整数主键。
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      logAudit('管理员修改签到记录失败', { ...requestMeta(req), ...authMeta(auth), 记录ID: req.params.id, 原因: '记录ID非法' }, 'warn');
      return res.status(400).json({ message: '无效的记录 ID' });
    }

    // 只允许管理员修改这些字段；未传的字段保持原值。
    const { name, studentId, actionType, location, signInTime, signOutTime } = req.body;

    // sets 保存 UPDATE 字段片段，params 保存对应参数，changedFields 记录审计用字段名。
    const sets = [];
    const params = [];
    const changedFields = [];
    // 每个字段只有在请求体中显式出现时才参与更新，避免把未传字段写成空。
    if (name !== undefined)        { sets.push('name = ?');          params.push(name); changedFields.push('name'); }
    if (studentId !== undefined)   { sets.push('student_id = ?');    params.push(studentId); changedFields.push('studentId'); }
    if (actionType !== undefined)  { sets.push('action_type = ?');   params.push(actionType); changedFields.push('actionType'); }
    if (location !== undefined)    { sets.push('location = ?');      params.push(location); changedFields.push('location'); }
    // 时间字段允许传空字符串，空字符串会写成 NULL。
    if (signInTime !== undefined)  { sets.push('sign_in_time = ?');  params.push(signInTime || null); changedFields.push('signInTime'); }
    if (signOutTime !== undefined) { sets.push('sign_out_time = ?'); params.push(signOutTime || null); changedFields.push('signOutTime'); }

    if (sets.length === 0) {
      // 没有任何可更新字段时，不执行无意义 UPDATE。
      logAudit('管理员修改签到记录失败', { ...requestMeta(req), ...authMeta(auth), 记录ID: id, 原因: '无可更新字段' }, 'warn');
      return res.status(400).json({ message: '无可更新字段' });
    }

    // 更新前读取原记录，用于确认存在并记录修改前后的差异。
    const [currentRows] = await db.query(
      'SELECT id, name, student_id, action_type, location, sign_in_time, sign_out_time, timeadd FROM sign_in_records WHERE id = ? LIMIT 1',
      [id]
    );
    if (currentRows.length === 0) {
      // 记录不存在时返回 404，避免 UPDATE 空跑。
      logAudit('管理员修改签到记录失败', { ...requestMeta(req), ...authMeta(auth), 记录ID: id, 更新字段: changedFields, 原因: '记录不存在' }, 'warn');
      return res.status(404).json({ message: '记录不存在' });
    }

    // 最后追加 WHERE id 参数，前面的 params 对应 SET 字段。
    params.push(id);
    // 动态 UPDATE 只包含本次传入的字段，所有值仍通过占位符传入。
    const [result] = await db.query(`UPDATE sign_in_records SET ${sets.join(', ')} WHERE id = ?`, params);
    if (result.affectedRows === 0) {
      // 理论上存在记录就会 affectedRows=1；这里记录异常或无变化情况。
      logAudit('管理员修改签到记录无变化', { ...requestMeta(req), ...authMeta(auth), 记录ID: id, 更新字段: changedFields, ...signRecordActionMeta(currentRows[0], '记录') });
    }

    // 基于原记录构造更新后的记录快照，专门用于审计日志对比。
    const updatedRecord = { ...currentRows[0] };
    if (name !== undefined) updatedRecord.name = name;
    if (studentId !== undefined) updatedRecord.student_id = studentId;
    if (actionType !== undefined) updatedRecord.action_type = actionType;
    if (location !== undefined) updatedRecord.location = location;
    if (signInTime !== undefined) updatedRecord.sign_in_time = signInTime || null;
    if (signOutTime !== undefined) updatedRecord.sign_out_time = signOutTime || null;
    // 审计记录原值和新值，方便追溯管理员手动修正。
    logAudit('管理员修改签到记录', {
      ...requestMeta(req),
      ...authMeta(auth),
      记录ID: id,
      更新字段: changedFields,
      ...signRecordActionMeta(currentRows[0], '原记录'),
      ...signRecordActionMeta(updatedRecord, '新记录')
    });

    res.json({ ok: true });
  } catch (err) {
    // 捕获鉴权、查询或更新签到记录异常。
    logger.error(`修改签到记录失败: ${err.message}`);
    res.status(500).json({ message: '修改失败' });
  }
});

// 管理员删除签到记录接口：允许管理员删除指定签到记录。
app.delete('/sign-records/:id', async (req, res) => {
  try {
    // 删除签到记录先走通用鉴权，再检查角色必须为 admin。
    const auth = await resolveAuth(req);
    if (!auth.ok) {
      // 鉴权失败时记录请求记录 ID 和失败原因。
      logAudit('管理员删除签到记录失败', { ...requestMeta(req), 记录ID: req.params.id, 原因: auth.message }, 'warn');
      return res.status(403).json({ message: auth.message });
    }
    if (auth.role !== 'admin') {
      // 普通密钥只能查看，不能删除签到记录。
      logAudit('管理员删除签到记录失败', { ...requestMeta(req), ...authMeta(auth), 记录ID: req.params.id, 原因: '非管理员操作' }, 'warn');
      return res.status(403).json({ message: '仅管理员可操作' });
    }

    // 路由 id 必须是正整数。
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      logAudit('管理员删除签到记录失败', { ...requestMeta(req), ...authMeta(auth), 记录ID: req.params.id, 原因: '记录ID非法' }, 'warn');
      return res.status(400).json({ message: '无效的记录 ID' });
    }

    // 删除前先读取完整记录，既确认存在，也保留删除审计所需信息。
    const [currentRows] = await db.query(
      'SELECT id, name, student_id, action_type, location, sign_in_time, sign_out_time, timeadd FROM sign_in_records WHERE id = ? LIMIT 1',
      [id]
    );
    if (currentRows.length === 0) {
      // 记录不存在时不执行 DELETE。
      logAudit('管理员删除签到记录失败', { ...requestMeta(req), ...authMeta(auth), 记录ID: id, 原因: '记录不存在' }, 'warn');
      return res.status(404).json({ message: '记录不存在' });
    }
    // 按主键删除单条签到记录。
    const [result] = await db.query('DELETE FROM sign_in_records WHERE id = ?', [id]);
    if (result.affectedRows === 0) {
      // 查询到但删除未命中，通常是并发删除，记录为失败。
      logAudit('管理员删除签到记录失败', { ...requestMeta(req), ...authMeta(auth), 记录ID: id, ...signRecordActionMeta(currentRows[0], '删除记录'), 原因: '删除未命中' }, 'warn');
      return res.status(404).json({ message: '记录不存在' });
    }
    // 审计删除动作，记录被删记录的关键字段。
    logAudit('管理员删除签到记录', { ...requestMeta(req), ...authMeta(auth), 记录ID: id, ...signRecordActionMeta(currentRows[0], '删除记录') });

    res.json({ ok: true });
  } catch (err) {
    // 捕获鉴权、查询或删除异常。
    logger.error(`删除签到记录失败: ${err.message}`);
    res.status(500).json({ message: '删除失败' });
  }
});

}

module.exports = registerAdminRoutes;
