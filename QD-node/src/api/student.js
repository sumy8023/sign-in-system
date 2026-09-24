// 本文件注册学生扫码提交端接口：提交签到/签退，以及根据学号查询当前应签到还是签退。
const { logger, db, QR_TOKEN_LOCAT_PREFIX, getTimedRedisValue, getBusinessNow } = require('../config/shared');
const { requestMeta, queryLastActionMeta, logAudit } = require('../config/audit');
const { normalizeAudio, formatTimestamp } = require('../config/utils');

// 注册学生扫码提交端相关路由到 Express 应用实例。
function registerStudentRoutes(app) {
// 提交签到/签退接口：学生扫码后提交姓名、学号和操作类型，写入或更新签到记录。
app.post('/submit-info', async (req, res) => {
  // name/studentId 来自学生填写，token 来自二维码，actionType 决定执行签到还是签退。
  const { name, studentId, token, actionType } = req.body;
  if (!name || !studentId || !token || !actionType) {
    // 任一核心参数缺失都不能继续写库，避免生成不完整的签到记录。
    logAudit('签到提交失败', { ...requestMeta(req), 姓名: name, 学号: studentId, 动作: actionType, 原因: '参数缺失' }, 'warn');
    return res.status(400).json({
      message: '提交失败参数错误'
    });
  }

  try {
    // 查询 token 是否有效；token 由二维码生成接口写入 Redis，过期后扫码提交会被拒绝。
    const tokenStatus = await getTimedRedisValue(token);
    if (!tokenStatus) {
      // token 不存在通常表示二维码过期、被刷新替换，或请求伪造。
      logAudit('签到提交失败', { ...requestMeta(req), 姓名: name, 学号: studentId, 动作: actionType, 原因: '二维码token无效' }, 'warn');
      return res.status(400).json({
        message: '二维码已失效或无效'
      });
    }

    // 根据 token 反查二维码所属地点，防止前端自己传 location 绕过地点限制。
    const locat = await getTimedRedisValue(`${QR_TOKEN_LOCAT_PREFIX}${token}`);
    if (!locat) {
      // token 有效但地点映射不存在，说明二维码数据不完整或 Redis 键已过期。
      logAudit('签到提交失败', { ...requestMeta(req), 姓名: name, 学号: studentId, 动作: actionType, 原因: '二维码地点映射无效' }, 'warn');
      return res.status(400).json({
        message: '二维码位置信息无效或已失效'
      });
    }
    // 查询地点配置：只允许对已启用地点签到/签退，同时取出人数上限和音频开关。
    const [currentLocRows] = await db.query(
      'SELECT locat_cn, max_people, audio FROM locat WHERE locat_en = ? AND enabled = 1 LIMIT 1',
      [locat]
    );
    if (currentLocRows.length === 0) {
      // 地点不存在或被管理员关闭时，学生端不能继续提交。
      logAudit('签到提交失败', { ...requestMeta(req), 姓名: name, 学号: studentId, 动作: actionType, 地点: locat, 原因: '地点不存在或已关闭' }, 'warn');
      return res.status(404).json({
        code: 'LOCAT_NOT_FOUND',
        message: '地点不存在或已关闭'
      });
    }

    // 获取当前业务时间；内部优先使用 NTP 时间，失败时接口会按工具函数逻辑处理。
    const businessTime = getBusinessNow(req, res);
    if (!businessTime) return;
    // todayRange 用于限制“当天”记录，nowDateTime 用于写入签到/签退时间。
    const { todayRange, nowDateTime } = businessTime;

    if (actionType === '签到') {
      // 签到前先查询该学生当天是否已有未签退记录（不区分地点）。
      const checkSql = `SELECT location
                        FROM sign_in_records 
                        WHERE student_id = ? 
                          AND sign_in_time >= ?
                          AND sign_in_time < ?
                          AND sign_out_time IS NULL 
                        ORDER BY sign_in_time DESC
                        LIMIT 1`;
      const [records] = await db.execute(checkSql, [studentId, todayRange.start, todayRange.end]);

      if (records.length > 0) {
        // 已有未签退记录时，一个学生当天同一时间只能处于一个地点在岗。
        const activeLocation = records[0].location;
        if (activeLocation === locat) {
          // 当前二维码地点和未签退地点一致，属于重复签到。
          logAudit('签到提交失败', { ...requestMeta(req), 姓名: name, 学号: studentId, 动作: actionType, 地点: locat, 原因: '同地点重复签到未签退' }, 'warn');
          return res.status(400).json({
            message: '已在该地点签到，未签退'
          });
        }
        // 当前学生在其他地点未签退，查询中文地点名用于返回更友好的提示。
        const [locatRows] = await db.query(
          'SELECT locat_cn FROM locat WHERE locat_en = ? LIMIT 1',
          [activeLocation]
        );
        // 找不到中文名时回退显示地点编码，保证提示中始终有地点信息。
        const activeLocationCn = locatRows.length > 0 && locatRows[0].locat_cn
          ? locatRows[0].locat_cn
          : activeLocation;
        logAudit('签到提交失败', { ...requestMeta(req), 姓名: name, 学号: studentId, 动作: actionType, 请求地点: locat, 已签到地点: activeLocation, 已签到地点中文: activeLocationCn, 原因: '其他地点未签退' }, 'warn');
        return res.status(400).json({
          message: `已在其他地点签到未签退（${activeLocationCn}），请先签退`
        });
      }

      // 地点人数上限校验：max_people = 0（或为空）表示不限制
      const maxPeopleRaw = currentLocRows[0].max_people;
      // 数据库存储可能是数字或字符串，这里统一转成 Number 再判断。
      const maxPeople = Number(maxPeopleRaw);
      if (Number.isFinite(maxPeople) && maxPeople > 0) {
        // 统计当前地点当天仍未签退的人数，也就是当前在岗人数。
        const [countRows] = await db.query(
          `SELECT COUNT(*) AS current_count
             FROM sign_in_records
            WHERE location = ?
              AND sign_in_time >= ?
              AND sign_in_time < ?
              AND sign_out_time IS NULL`,
          [locat, todayRange.start, todayRange.end]
        );
        const currentCount = Number(countRows[0]?.current_count) || 0;
        if (currentCount >= maxPeople) {
          // 当前人数达到上限时拒绝新签到，避免超过管理员配置容量。
          logAudit('签到提交失败', { ...requestMeta(req), 姓名: name, 学号: studentId, 动作: actionType, 地点: locat, 当前人数: currentCount, 人数上限: maxPeople, 原因: '地点人数已满' }, 'warn');
          return res.status(400).json({
            message: `该地点今日在岗人数已达上限（${maxPeople} 人）`
          });
        }
      }

      // 插入新的签到记录（如果之前在该地点已签退 或 是新地点）
      const insertSql = `INSERT INTO sign_in_records 
                         (name, student_id, token, action_type, location, sign_in_time, sign_out_time) 
                         VALUES (?, ?, ?, ?, ?, ?, NULL)`;
      // 签到记录写入 sign_in_time，sign_out_time 保持 NULL 表示仍在岗。
      const [insertResult] = await db.execute(insertSql, [name, studentId, token, actionType, locat, nowDateTime]);
      // 记录成功签到审计，包含记录 ID 便于后续追踪。
      logAudit('签到成功', { ...requestMeta(req), 姓名: name, 学号: studentId, 动作: actionType, 地点: locat, 地点中文: currentLocRows[0].locat_cn || locat, 记录ID: insertResult.insertId });

      // 返回 audioEnabled，前端据此决定是否播放操作成功音效。
      return res.status(200).json({
        message: '操作成功',
        audioEnabled: normalizeAudio(currentLocRows[0].audio, 1) === 1
      });
    }

    if (actionType === '签退') {
      // 签退只更新当天同一地点的未签退记录，并将 action_type 设为“已完成”。
      const updateSql = `UPDATE sign_in_records 
                         SET sign_out_time = ?, action_type = '已完成' 
                         WHERE student_id = ? 
                           AND location = ? 
                           AND sign_in_time >= ?
                           AND sign_in_time < ?
                           AND sign_out_time IS NULL 
                         ORDER BY sign_in_time 
                         LIMIT 1`;
      // 只更新最早一条未签退记录，避免异常重复数据时一次修改多条记录。
      const [result] = await db.execute(updateSql, [nowDateTime, studentId, locat, todayRange.start, todayRange.end]);

      // 如果没有更新到记录，需要判断是没有签到，还是在其他地点签到未签退。
      if (result.affectedRows === 0) {
        // 查询该学生当天是否存在其他地点的未签退记录。
        const [activeRows] = await db.query(
          `SELECT location
             FROM sign_in_records
            WHERE student_id = ?
              AND sign_in_time >= ?
              AND sign_in_time < ?
              AND sign_out_time IS NULL
            ORDER BY sign_in_time DESC
            LIMIT 1`,
          [studentId, todayRange.start, todayRange.end]
        );

        if (activeRows.length > 0) {
          // 找到了其他地点的未签退记录，要求学生回到签到地点对应二维码签退。
          const activeLocation = activeRows[0].location;
          const [locatRows] = await db.query(
            'SELECT locat_cn FROM locat WHERE locat_en = ? LIMIT 1',
            [activeLocation]
          );
          // 中文名不存在时回退到地点编码，避免错误提示为空。
          const activeLocationCn = locatRows.length > 0 && locatRows[0].locat_cn
            ? locatRows[0].locat_cn
            : activeLocation;
          logAudit('签退失败', { ...requestMeta(req), 姓名: name, 学号: studentId, 动作: actionType, 请求地点: locat, 当前签到地点: activeLocation, 当前签到地点中文: activeLocationCn, 原因: '需到签到地点签退' }, 'warn');
          return res.status(400).json({
            message: `你当前在“${activeLocationCn}”签到中，请到该地点二维码完成签退`
          });
        }

        // 当天没有任何未签退记录，说明学生还未签到或已经签退完成。
        logAudit('签退失败', { ...requestMeta(req), 姓名: name, 学号: studentId, 动作: actionType, 地点: locat, 原因: '无可签退记录' }, 'warn');
        return res.status(400).json({
          message: '当前没有可签退的签到记录，请先签到后再签退'
        });
      }
      // 签退成功时记录影响行数，正常情况下应该为 1。
      logAudit('签退成功', { ...requestMeta(req), 姓名: name, 学号: studentId, 动作: actionType, 地点: locat, 地点中文: currentLocRows[0].locat_cn || locat, 影响行数: result.affectedRows });
    }
    if (actionType !== '签到' && actionType !== '签退') {
      // 非法动作不会写入额外数据，但会被记录，便于发现前端或恶意请求问题。
      logAudit('签到提交未知动作', { ...requestMeta(req), 姓名: name, 学号: studentId, 动作: actionType, 地点: locat }, 'warn');
    }
    // 签退成功或未知动作走到这里，统一返回操作结果和音频开关。
    res.status(200).json({
      message: '操作成功',
      audioEnabled: normalizeAudio(currentLocRows[0].audio, 1) === 1
    });
  } catch (err) {
    // 捕获 Redis、数据库或时间服务异常，统一返回服务器错误。
    logger.error('数据库操作失败:', err);
    res.status(500).json({
      message: '服务器错误'
    });
  }
});

// 签到签退状态定位接口：根据学生学号和二维码 token 判断该学生当天在当前地点的最后状态。
app.post('/query-last-action', async (req, res) => {
  // location 是旧调用方式；token 是当前推荐方式，可以由后端反查地点。
  const { studentId, location, token } = req.body;

  if (!studentId || (!location && !token)) {
    // 必须有学号，并且必须能通过 location 或 token 确定查询地点。
    logAudit('查询最后签到状态失败', {
      ...queryLastActionMeta(req, token),
      学号: studentId || '-',
      地点: location || '-',
      原因: '缺少studentId或token/location参数'
    }, 'warn');
    return res.status(400).json({
      message: '缺少 studentId 或 token/location 参数'
    });
  }

  try {
    // 默认使用请求体中的 location；如果传了 token，后续会用 token 对应地点覆盖。
    let resolvedLocation = location;
    if (token) {
      // token 不存在时说明二维码已过期或被刷新，不能继续查询该二维码状态。
      const tokenStatus = await getTimedRedisValue(token);
      if (!tokenStatus) {
        logAudit('查询最后签到状态失败', { ...queryLastActionMeta(req, token), 学号: studentId, 原因: '二维码已失效或无效' }, 'warn');
        return res.status(400).json({
          message: '二维码已失效或无效'
        });
      }
      // 通过 token 反查地点，保证查询地点和二维码实际地点一致。
      const tokenLocat = await getTimedRedisValue(`${QR_TOKEN_LOCAT_PREFIX}${token}`);
      if (!tokenLocat) {
        logAudit('查询最后签到状态失败', { ...queryLastActionMeta(req, token), 学号: studentId, 原因: '二维码位置信息无效或已失效' }, 'warn');
        return res.status(400).json({
          message: '二维码位置信息无效或已失效'
        });
      }
      // token 优先级高于前端传入的 location，避免前端伪造地点。
      resolvedLocation = tokenLocat;
    }

    if (!resolvedLocation) {
      // 理论兜底：没有解析到地点时不能判断该学生在当前二维码下应签到还是签退。
      logAudit('查询最后签到状态失败', { ...queryLastActionMeta(req, token), 学号: studentId, 原因: '缺少有效地点参数' }, 'warn');
      return res.status(400).json({
        message: '缺少有效地点参数'
      });
    }

    // 获取当天时间范围，查询只看业务日期当天的数据。
    const businessTime = getBusinessNow(req, res);
    if (!businessTime) return;
    // 查询该学生在特定地点当天最新一条签到记录，用于判断按钮默认状态。
    const querySql = `
      SELECT action_type, location, sign_in_time, sign_out_time 
      FROM sign_in_records 
      WHERE student_id = ? AND location = ?
        AND sign_in_time >= ?
        AND sign_in_time < ?
      ORDER BY sign_in_time DESC 
      LIMIT 1`;

    const [rows] = await db.query(querySql, [studentId, resolvedLocation, businessTime.todayRange.start, businessTime.todayRange.end]);

    if (rows.length === 0) {
      // 当天没有记录时，前端应展示“签到”入口。
      logAudit('查询最后签到状态', { ...queryLastActionMeta(req, token), 学号: studentId, 地点: resolvedLocation, 结果: '无当天记录' });
      return res.json({
        actionType: null,
        location: null,
        signInTime: null,
        signOutTime: null
      });
    }

    // 有签退时间代表流程已完成；没有签退时间代表当前处于已签到待签退状态。
    const lastActionType = rows[0].sign_out_time ? (rows[0].action_type || '已完成') : '签到';
    // 审计查询结果，时间统一格式化，便于直接阅读日志。
    logAudit('查询最后签到状态', {
      ...queryLastActionMeta(req, token),
      学号: studentId,
      地点: rows[0].location,
      结果: lastActionType,
      签到时间: rows[0].sign_in_time ? formatTimestamp(rows[0].sign_in_time) : null,
      签退时间: rows[0].sign_out_time ? formatTimestamp(rows[0].sign_out_time) : null
    });
    // 返回当前状态和最近一次签到/签退时间，供学生端自动切换按钮文案。
    return res.json({
      actionType: lastActionType,
      location: rows[0].location,
      signInTime: rows[0].sign_in_time ? formatTimestamp(rows[0].sign_in_time) : null,
      signOutTime: rows[0].sign_out_time ? formatTimestamp(rows[0].sign_out_time) : null
    });
  } catch (err) {
    // 捕获 Redis 查询、数据库查询和时间解析异常。
    logger.error('查询当天最后一条记录失败:', err);
    return res.status(500).json({
      message: '服务器内部错误'
    });
  }
});

}

module.exports = registerStudentRoutes;
