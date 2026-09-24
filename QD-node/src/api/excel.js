// 本文件注册 Excel 导出接口：按日期或日期范围导出签到详情和时长排行。
const exceljs = require('exceljs');
const { logger, db, resolveAuth, appendTimeaddRankingWorksheet } = require('../config/shared');
const { requestMeta, authMeta, logAudit } = require('../config/audit');
const { getDateRangeOrRespond, formatTimestamp } = require('../config/utils');

// 注册 Excel 导出相关路由到 Express 应用实例。
function registerExcelRoutes(app) {
// 导出 Excel 接口：按指定日期或全部数据导出签到详情和时长排行。
app.get('/export-excel', async (req, res) => {
  try {
    // 先统一走展示端/管理员鉴权，保证导出接口不能被匿名访问。
    const auth = await resolveAuth(req);
    if (!auth.ok) {
      // 鉴权失败时记录请求来源和失败原因，方便排查非法导出请求。
      logAudit('导出Excel失败', { ...requestMeta(req), 日期: req.query.date || '全部', 原因: auth.message }, 'warn');
      // HMAC/请求格式错误返回 400，密钥权限类问题返回 403。
      return res.status(auth.message === '非法请求！' || auth.message === '请求非法！' ? 400 : 403).json({ message: auth.message });
    }

    // 读取可选 date 参数；不传 date 时导出全部签到数据。
    const { date } = req.query;
    // conditions/params 分开维护，保证 SQL 使用占位符，避免把用户输入拼进 SQL。
    const conditions = [];
    const params = [];

    if (date) {
      // 校验并转换单日日期范围：start 为当天 00:00:00，end 为次日 00:00:00。
      const dateRange = getDateRangeOrRespond(date, req, res, '导出Excel失败');
      if (!dateRange) return;
      // 只导出当天签到时间落在 [start, end) 区间内的记录。
      conditions.push('sign_in_time >= ? AND sign_in_time < ?');
      params.push(dateRange.start, dateRange.end);
    }

    // 没有筛选条件时 whereSql 为空，表示导出全量记录。
    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    // 排行榜工作表需要使用同一套时间过滤条件，保证两个 sheet 的数据口径一致。
    const rankingWhereClause = whereSql;
    const rankingParams = [...params];

    // 签到详情只查询导出需要的字段，字段顺序和后面的 Excel 表头一致。
    const query = `SELECT name, student_id, action_type, location, sign_in_time, sign_out_time, timeadd FROM sign_in_records ${whereSql}`;

    // 查询数据库获取待导出的签到详情。
    const [records] = await db.query(query, params);

    if (records.length === 0) {
      // 没有数据时不生成空文件，直接告诉前端当前条件没有可导出记录。
      logAudit('导出Excel失败', { ...requestMeta(req), ...authMeta(auth), 日期: date || '全部', 原因: '无符合条件数据' }, 'warn');
      return res.status(404).json({
        message: '未找到符合条件的数据'
      });
    }

    // 创建 Excel 工作簿，并把第一张表固定命名为“签到详情”。
    const workbook = new exceljs.Workbook();
    const worksheet = workbook.addWorksheet('签到详情');

    // 设置 Excel 表头、字段 key 和列宽；key 必须对应 records 里的字段名。
    worksheet.columns = [
      { header: '姓名', key: 'name', width: 20 },
      { header: '学号', key: 'student_id', width: 20 },
      { header: '当前状态', key: 'action_type', width: 20 },
      { header: '签到地点', key: 'location', width: 25 },
      { header: '签到时间', key: 'sign_in_time', width: 25 },
      { header: '签退时间', key: 'sign_out_time', width: 25 },
      { header: '时长', key: 'timeadd', width: 15 },
    ];

    records.forEach((record) => {
      // 数据库时间可能是 Date 或字符串，这里统一转成前端/Excel 可读的格式。
      record.sign_in_time = record.sign_in_time ? formatTimestamp(record.sign_in_time) : '';
      record.sign_out_time = record.sign_out_time ? formatTimestamp(record.sign_out_time) : '';
      // 每条签到记录追加为 Excel 的一行。
      worksheet.addRow(record);
    });

    // 第二工作表：时长排行（全部导出按全量，按日期导出按日期过滤）
    await appendTimeaddRankingWorksheet(workbook, rankingWhereClause, rankingParams);


    // 按导出范围生成文件名，单日导出带日期，全量导出使用 all。
    const filename = date ? `sign_in_records_${date}.xlsx` : `sign_in_records_all.xlsx`;
    // 审计导出动作，记录导出人、日期范围、记录数和文件名。
    logAudit('导出Excel', { ...requestMeta(req), ...authMeta(auth), 日期: date || '全部', 记录数: records.length, 文件名: filename });

    // 设置下载响应头，让浏览器按 xlsx 文件下载而不是当成普通文本展示。
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

    // 直接把工作簿写入 HTTP 响应流，写完后结束响应。
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    // 捕获数据库查询、Excel 生成和响应写入中的异常，避免接口无响应。
    logger.error('导出 Excel 失败:', err);
    res.status(500).json({
      message: '导出 Excel 失败'
    });
  }
});

// 按日期范围导出接口：导出开始日期到结束日期之间的签到详情和时长排行。
app.get('/export-excel-range', async (req, res) => {
  try {
    // 范围导出同样先鉴权，避免未登录用户批量导出数据。
    const auth = await resolveAuth(req);
    if (!auth.ok) {
      // 鉴权失败时记录开始日期、结束日期和失败原因。
      logAudit('范围导出Excel失败', { ...requestMeta(req), 开始日期: req.query.start || '-', 结束日期: req.query.end || '-', 原因: auth.message }, 'warn');
      return res.status(auth.message === '非法请求！' ? 400 : 403).json({ message: auth.message });
    }
    // start/end 都是 YYYY-MM-DD 字符串，表示闭区间的自然日范围。
    const { start, end } = req.query;
    if (!start || !end) {
      // 范围导出必须同时提供开始和结束日期，否则无法确定查询边界。
      logAudit('范围导出Excel失败', { ...requestMeta(req), ...authMeta(auth), 开始日期: start || '-', 结束日期: end || '-', 原因: '缺少时间范围参数' }, 'warn');
      return res.status(400).json({
        message: '缺少时间范围参数'
      });
    }

    // 分别校验开始日和结束日，并转换成数据库可比较的时间边界。
    const startRange = getDateRangeOrRespond(start, req, res, '范围导出Excel失败');
    if (!startRange) return;
    const endRange = getDateRangeOrRespond(end, req, res, '范围导出Excel失败');
    if (!endRange) return;
    // 字符串格式固定为 YYYY-MM-DD 时可以直接比较大小，避免开始日期晚于结束日期。
    if (start > end) {
      logAudit('范围导出Excel失败', { ...requestMeta(req), ...authMeta(auth), 开始日期: start, 结束日期: end, 原因: '开始日期晚于结束日期' }, 'warn');
      return res.status(400).json({ message: '开始日期不能晚于结束日期' });
    }

    // 范围查询使用 [startRange.start, endRange.end)，包含结束日期当天整天。
    const rangeConditions = ['sign_in_time >= ? AND sign_in_time < ?'];
    const rangeParams = [startRange.start, endRange.end];
    const rangeWhereSql = `WHERE ${rangeConditions.join(' AND ')}`;

    // 查询范围内的签到详情，字段顺序和 Excel 表头保持一致。
    const [records] = await db.query(
      `SELECT name, student_id, action_type, location, sign_in_time, sign_out_time, timeadd FROM sign_in_records ${rangeWhereSql}`,
      rangeParams
    );

    if (records.length === 0) {
      // 范围内没有记录时不返回空 Excel，直接给前端明确提示。
      logAudit('范围导出Excel失败', { ...requestMeta(req), ...authMeta(auth), 开始日期: start, 结束日期: end, 原因: '指定时间范围内无数据' }, 'warn');
      return res.status(404).json({
        message: '在指定时间范围内无数据'
      });
    }

    // 时间格式化：把数据库时间统一转成可阅读文本，空签退时间保留为空字符串。
    records.forEach(record => {
      record.sign_in_time = record.sign_in_time ? formatTimestamp(record.sign_in_time) : '';
      record.sign_out_time = record.sign_out_time ? formatTimestamp(record.sign_out_time) : '';
    });

    // 创建 Excel 工作簿，并添加签到详情工作表。
    const workbook = new exceljs.Workbook();
    const worksheet = workbook.addWorksheet('签到详情');

    // 设置 Excel 表头、字段映射和列宽；字段 key 对应 records 中的属性名。
    worksheet.columns = [{
        header: '姓名',
        key: 'name',
        width: 20
      },
      {
        header: '学号',
        key: 'student_id',
        width: 20
      },
      {
        header: '当前状态',
        key: 'action_type',
        width: 20
      },
      {
        header: '签到地点',
        key: 'location',
        width: 25
      },
      {
        header: '签到时间',
        key: 'sign_in_time',
        width: 25
      },
      {
        header: '签退时间',
        key: 'sign_out_time',
        width: 25
      },
      {
        header: '时长',
        key: 'timeadd',
        width: 15
      },
    ];

    // 添加数据行：records 已经完成时间格式化，可以直接写入工作表。
    records.forEach(record => worksheet.addRow(record));

    // 第二工作表：时长排行（按导出日期范围过滤）
    await appendTimeaddRankingWorksheet(workbook, rangeWhereSql, rangeParams);

    // 文件名包含开始和结束日期，方便管理员下载后区分导出范围。
    const filename = `sign_in_range_${start}_to_${end}.xlsx`;
    // 审计范围导出动作，保留导出条件、记录数和文件名。
    logAudit('范围导出Excel', { ...requestMeta(req), ...authMeta(auth), 开始日期: start, 结束日期: end, 记录数: records.length, 文件名: filename });

    // 设置 xlsx 下载响应头。
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);

    // 将 Excel 工作簿写入响应流并结束请求。
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    // 捕获范围导出中的数据库、Excel 生成或响应写入错误。
    logger.error('导出 Excel（范围）失败:', err);
    res.status(500).json({
      message: '导出失败'
    });
  }
});
}

module.exports = registerExcelRoutes;
