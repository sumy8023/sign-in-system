// 本文件负责从 NTP 网络时间服务器同步时间，并提供 UTC+8 业务日期和时间格式化工具。
const dgram = require('dgram');
const { performance } = require('perf_hooks');

// NTP 时间戳从 1900-01-01 开始，Unix 时间戳从 1970-01-01 开始，两者相差的秒数。
const NTP_TO_UNIX_EPOCH_SECONDS = 2208988800;
// 标准 NTP UDP 端口。
const NTP_PORT = 123;
// 默认每 5 分钟同步一次网络时间。
const DEFAULT_SYNC_INTERVAL_MS = 5 * 60 * 1000;
// 超过 30 分钟没有成功同步时，认为当前网络时间不可用。
const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000;
// 单个 NTP 服务器请求超时时间。
const DEFAULT_TIMEOUT_MS = 2500;
// 默认 NTP 服务器列表；需要调整网络时间源时优先改这里，也可以用 NTP_SERVERS 环境变量覆盖。
const DEFAULT_NTP_SERVERS = ['ntp.aliyun.com', 'ntp.tencent.com', 'cn.pool.ntp.org', 'ntp.ntsc.ac.cn', 'time.ntis.gov.cn'];
// UTC+8 偏移毫秒数，用于生成中国时区业务日期和时间。
const UTC8_OFFSET_MS = 8 * 60 * 60 * 1000;

class TimeProvider {
  // 初始化时间同步配置、NTP 服务器列表和同步状态。
  constructor(options = {}) {
    // 支持从 options 或环境变量指定 NTP 服务器；未配置时使用顶部 DEFAULT_NTP_SERVERS。
    this.servers = normalizeServers(options.servers || process.env.NTP_SERVERS);
    // 同步间隔、过期窗口、超时时间都支持 options 和环境变量覆盖。
    this.syncIntervalMs = Number(options.syncIntervalMs) || Number(process.env.NTP_SYNC_INTERVAL_MS) || DEFAULT_SYNC_INTERVAL_MS;
    this.staleAfterMs = Number(options.staleAfterMs) || Number(process.env.NTP_STALE_AFTER_MS) || DEFAULT_STALE_AFTER_MS;
    this.timeoutMs = Number(options.timeoutMs) || Number(process.env.NTP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    // logger 默认使用 console，server.js 启动时会替换成项目 logger。
    this.logger = options.logger || console;
    // lastSync 保存最近一次成功同步的网络时间基准。
    this.lastSync = null;
    // syncTimer 保存定时同步任务，stop 时会清理。
    this.syncTimer = null;
    // syncing 保存正在进行的同步 Promise，避免并发重复同步。
    this.syncing = null;
  }

  // 启动网络时间同步，并按固定间隔持续刷新本地时间基准。
  start() {
    // 启动后立即同步一次，失败只记录日志，不阻止服务进程启动。
    this.sync().catch((err) => {
      this.logError(`网络时间首次同步失败: ${err.message}`);
    });
    // 后续按固定间隔持续同步，保证长时间运行时不会漂移太久。
    this.syncTimer = setInterval(() => {
      this.sync().catch((err) => {
        this.logError(`网络时间定时同步失败: ${err.message}`);
      });
    }, this.syncIntervalMs);
    // unref 避免定时器阻止 Node 进程退出，方便测试或进程关闭。
    if (typeof this.syncTimer.unref === 'function') this.syncTimer.unref();
  }

  // 停止定时同步任务，主要用于测试或进程退出前清理。
  stop() {
    // 有定时器时先清理，防止继续触发同步。
    if (this.syncTimer) clearInterval(this.syncTimer);
    // 置空状态，表示当前没有后台同步任务。
    this.syncTimer = null;
  }

  // 触发一次同步；如果已经有同步在进行，则复用同一个 Promise。
  async sync() {
    // 正在同步时直接复用，避免多个接口同时触发多轮 NTP 请求。
    if (this.syncing) return this.syncing;
    // 保存 Promise，并在完成后清空 syncing。
    this.syncing = this.syncFromServers()
      .finally(() => {
        this.syncing = null;
      });
    return this.syncing;
  }

  // 并发请求多个 NTP 服务器，取中位数样本作为当前网络时间基准。
  async syncFromServers() {
    // 同时请求所有配置的 NTP 服务器，部分失败不会影响其他服务器结果。
    const results = await Promise.allSettled(
      this.servers.map((server) => requestNetworkTime(server, this.timeoutMs))
    );
    // 只保留成功且时间值有效的样本。
    const samples = results
      .filter((item) => item.status === 'fulfilled')
      .map((item) => item.value)
      .filter((sample) => Number.isFinite(sample.networkTimeAtPerfMs));

    if (samples.length === 0) {
      // 全部失败时提取前几个错误原因，方便日志排查网络或服务器问题。
      const reasons = results
        .filter((item) => item.status === 'rejected')
        .map((item) => item.reason && item.reason.message ? item.reason.message : String(item.reason))
        .slice(0, 3)
        .join('; ');
      throw new Error(reasons || '无可用 NTP 响应');
    }

    // 多个样本按网络时间排序，取中位数降低个别服务器异常值影响。
    samples.sort((a, b) => a.networkTimeAtPerfMs - b.networkTimeAtPerfMs);
    const median = samples[Math.floor(samples.length / 2)];
    // 保存网络时间基准和 performance.now() 基准，后续用单调时钟推算当前网络时间。
    this.lastSync = {
      networkTimeMs: median.networkTimeAtPerfMs,
      perfMs: median.perfMs,
      syncedAtPerfMs: performance.now(),
      server: median.server,
      roundTripMs: median.roundTripMs
    };
    // 记录成功同步的服务器和 RTT，方便观察网络质量。
    this.logInfo(`网络时间同步成功: ${median.server}, 延迟=${Math.round(median.roundTripMs)}ms`);
    return this.lastSync;
  }

  // 判断是否至少成功同步过一次网络时间。
  isReady() {
    // lastSync 为空表示从未成功同步。
    return Boolean(this.lastSync);
  }

  // 判断最近一次同步结果是否仍在可用时间窗口内。
  isUsable() {
    // 从未同步时一定不可用。
    if (!this.lastSync) return false;
    // 以最后一次成功同步时间为起点，超过 staleAfterMs 就认为时间过期。
    return performance.now() - this.lastSync.syncedAtPerfMs <= this.staleAfterMs;
  }

  // 返回当前网络时间同步状态，供接口诊断和错误响应使用。
  getStatus() {
    // 返回当前同步状态给 /network-time 和 503 错误响应使用。
    return {
      ready: this.isReady(),
      usable: this.isUsable(),
      server: this.lastSync ? this.lastSync.server : null,
      roundTripMs: this.lastSync ? this.lastSync.roundTripMs : null,
      ageMs: this.lastSync ? Math.max(0, performance.now() - this.lastSync.syncedAtPerfMs) : null,
      staleAfterMs: this.staleAfterMs
    };
  }

  // 获取当前网络校准后的毫秒时间；不可用时抛出 TIME_NOT_READY。
  nowMs() {
    if (!this.isUsable()) {
      // 区分“从未同步”和“同步过但已过期”，便于前端或日志判断问题。
      const status = this.getStatus();
      const message = status.ready ? '网络时间已过期' : '网络时间尚未同步';
      const err = new Error(message);
      // 附带错误码和状态对象，调用方可以直接返回给前端。
      err.code = 'TIME_NOT_READY';
      err.status = status;
      throw err;
    }
    // 用上次网络时间基准加上 performance.now() 的差值，避免依赖系统时间跳变。
    return this.lastSync.networkTimeMs + (performance.now() - this.lastSync.perfMs);
  }

  // 返回当前网络校准时间的 ISO 字符串。
  nowIso() {
    // ISO 字符串仍然是 UTC 表示，适合前端做标准时间解析。
    return new Date(this.nowMs()).toISOString();
  }

  // 返回当前网络校准时间的 UTC+8 日期时间字符串。
  nowDateTimeString() {
    // 业务页面主要展示 UTC+8 的本地日期时间。
    return formatUtc8DateTime(this.nowMs());
  }

  // 返回业务接口常用的当前时间、日期和当天范围。
  getBusinessTime() {
    // 只调用一次 nowMs，保证同一次接口里 now、date、range 来源一致。
    const nowMs = this.nowMs();
    // ymd 是 UTC+8 业务日期，不是 UTC 日期。
    const ymd = formatUtc8Ymd(nowMs);
    return {
      nowDateTime: formatUtc8DateTime(nowMs),
      nowIso: new Date(nowMs).toISOString(),
      ymd,
      todayRange: getUtc8DateRange(ymd)
    };
  }

  // 基于当前网络时间加上偏移量后输出 UTC+8 日期时间字符串。
  dateTimeStringFromOffset(offsetMs) {
    // 常用于计算“当前时间往前 N 分钟”的业务时间字符串。
    return formatUtc8DateTime(this.nowMs() + offsetMs);
  }

  // 返回当前网络时间对应的 UTC+8 日期。
  getUtc8Ymd() {
    // 返回当前网络时间对应的 UTC+8 日期。
    return formatUtc8Ymd(this.nowMs());
  }

  // 返回当前 UTC+8 日期对应的起止时间范围。
  getTodayUtc8Range() {
    // 基于当前 UTC+8 日期生成当天 00:00:00 到次日 00:00:00。
    return getUtc8DateRange(this.getUtc8Ymd());
  }

  // 将指定 YYYY-MM-DD 日期转换为 UTC+8 起止时间范围。
  getUtc8DateRange(ymd) {
    // 暴露实例方法，便于其他模块统一使用同一套日期校验规则。
    return getUtc8DateRange(ymd);
  }

  // 对指定 YYYY-MM-DD 日期增加或减少天数。
  addUtc8Days(ymd, days) {
    // 用 UTC 日期对象做日偏移，避免本地时区或夏令时影响。
    return addDaysToYmd(ymd, days);
  }

  // 格式化数据库中取出的时间戳为统一字符串。
  formatStoredTimestamp(value) {
    // 数据库时间格式可能不同，统一交给底层格式化函数处理。
    return formatStoredTimestamp(value);
  }

  // 把毫秒时间戳格式化为 UTC+8 日期时间字符串。
  formatUtc8DateTime(ms) {
    // 提供给外部直接格式化毫秒时间戳的能力。
    return formatUtc8DateTime(ms);
  }
}

// 解析 NTP 服务器配置，未配置时返回顶部 DEFAULT_NTP_SERVERS。
function normalizeServers(value) {
  // 未配置环境变量时直接返回顶部默认服务器。
  if (!value) return DEFAULT_NTP_SERVERS;
  // 支持数组或逗号分隔字符串两种配置形式。
  const items = Array.isArray(value) ? value : String(value).split(',');
  // 去掉空白项，避免请求空服务器名。
  const servers = items.map((item) => String(item).trim()).filter(Boolean);
  // 如果配置后结果为空，仍然回退顶部默认服务器。
  return servers.length > 0 ? servers : DEFAULT_NTP_SERVERS;
}

// 向单个 NTP 服务器发送 UDP 请求，并计算校准后的网络时间样本。
function requestNetworkTime(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    // NTP 使用 UDP 协议，这里创建 IPv4 UDP socket。
    const socket = dgram.createSocket('udp4');
    // NTP 请求包固定 48 字节。
    const packet = Buffer.alloc(48);
    // 第一个字节 0x1b 表示客户端模式、NTP v3/v4 兼容请求。
    packet[0] = 0x1b;
    // 用单调时钟记录发送前时间，不受系统时间调整影响。
    const startPerf = performance.now();
    // done 防止超时、错误、消息回调多次触发 Promise 结束。
    let done = false;

    const finish = (err, value) => {
      if (done) return;
      done = true;
      // 不管成功失败都清掉超时器并关闭 socket。
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(value);
    };

    // 超过 timeoutMs 没收到响应就认为该服务器不可用。
    const timer = setTimeout(() => {
      finish(new Error(`${server} NTP 请求超时`));
    }, timeoutMs);
    // 不让超时器阻止进程退出。
    if (typeof timer.unref === 'function') timer.unref();

    // UDP socket 自身错误统一包装成带服务器名的错误。
    socket.once('error', (err) => {
      finish(new Error(`${server} NTP 请求失败: ${err.message}`));
    });

    // 收到 NTP 响应包后解析 transmit timestamp。
    socket.once('message', (message) => {
      // 记录收到响应时的单调时间，用于估算往返耗时。
      const receivePerf = performance.now();
      if (message.length < 48) {
        // NTP 响应小于 48 字节说明包不完整。
        finish(new Error(`${server} NTP 响应长度异常`));
        return;
      }
      // 读取服务器发送时间，并估算网络往返延迟的一半作为校正。
      const transmitMs = readNtpTransmitTime(message);
      const roundTripMs = receivePerf - startPerf;
      finish(null, {
        server,
        perfMs: receivePerf,
        networkTimeAtPerfMs: transmitMs + roundTripMs / 2,
        roundTripMs
      });
    });

    // 发送 NTP 请求包到指定服务器的 123 端口。
    socket.send(packet, 0, packet.length, NTP_PORT, server, (err) => {
      // 发送失败同样结束 Promise，避免等待超时。
      if (err) finish(new Error(`${server} NTP 发送失败: ${err.message}`));
    });
  });
}

// 从 NTP 响应包中读取 transmit timestamp 并转换为 Unix 毫秒时间。
function readNtpTransmitTime(message) {
  // NTP transmit timestamp 的整数秒在第 40-43 字节。
  const seconds = message.readUInt32BE(40);
  // 小数部分在第 44-47 字节，是 2^32 分之一秒单位。
  const fraction = message.readUInt32BE(44);
  // 转成 Unix 毫秒：先减去纪元差，再把小数部分换算为毫秒。
  return (seconds - NTP_TO_UNIX_EPOCH_SECONDS) * 1000 + (fraction * 1000) / 0x100000000;
}

// 把毫秒时间戳格式化为 UTC+8 日期字符串 YYYY-MM-DD。
function formatUtc8Ymd(ms) {
  // 先加 UTC+8 偏移，再用 UTC getter 读取，避免服务器本地时区影响。
  const date = new Date(ms + UTC8_OFFSET_MS);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 把毫秒时间戳格式化为 UTC+8 日期时间字符串 YYYY-MM-DD HH:mm:ss。
function formatUtc8DateTime(ms) {
  // 先把时间平移到 UTC+8，再用 UTC 字段拼成业务时间字符串。
  const date = new Date(ms + UTC8_OFFSET_MS);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  const seconds = String(date.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// 把 Date 对象按当前进程本地时间字段格式化，不再额外做 UTC+8 平移。
function formatLocalDateTime(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

// 根据 UTC+8 日期生成当天开始时间和下一天开始时间。
function getUtc8DateRange(ymd) {
  // 先校验格式，避免拼出非法 SQL 时间条件。
  assertYmd(ymd);
  // 范围采用左闭右开：[当天 00:00:00, 次日 00:00:00)。
  return {
    start: `${ymd} 00:00:00`,
    end: `${addDaysToYmd(ymd, 1)} 00:00:00`
  };
}

// 在 YYYY-MM-DD 日期上增加指定天数，并返回新的日期字符串。
function addDaysToYmd(ymd, days) {
  // 所有入参日期都先做格式校验。
  assertYmd(ymd);
  // 使用 UTC 构造日期，避免本地时区导致跨日偏差。
  const [year, month, day] = ymd.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  const nextYear = date.getUTCFullYear();
  const nextMonth = String(date.getUTCMonth() + 1).padStart(2, '0');
  const nextDay = String(date.getUTCDate()).padStart(2, '0');
  return `${nextYear}-${nextMonth}-${nextDay}`;
}

// 校验日期字符串是否符合 YYYY-MM-DD 格式。
function assertYmd(ymd) {
  // 先校验格式，避免空值或其他字符串进入日期计算。
  const text = String(ymd || '');
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error('日期格式错误，应为 YYYY-MM-DD');
  }
  // 再校验真实日期，防止 2026-02-31、2026-13-01 这类不存在日期被 Date 自动滚动。
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  if (!valid) {
    throw new Error('日期不存在，应为真实日期 YYYY-MM-DD');
  }
}

// 兼容 Date、MySQL 字符串和可解析时间字符串，统一输出 UTC+8 时间。
function formatStoredTimestamp(value) {
  // 空值统一输出空字符串，方便接口响应直接展示。
  if (!value) return '';
  // mysql2 正常配置下会返回字符串；若遇到 Date，按它自身字段输出，避免二次时区偏移。
  if (value instanceof Date) return formatLocalDateTime(value);
  // 字符串先去空格，兼容 MySQL 常见的 YYYY-MM-DD HH:mm:ss。
  const text = String(value).trim();
  const match = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  // 已经是日期时间字符串时，直接规范成空格分隔格式。
  if (match) return `${match[1]} ${match[2]}`;
  // 其他可解析格式用 Date.parse 兜底；不可解析则原样返回。
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? text : formatUtc8DateTime(parsed);
}

// 按指定日志级别输出信息，logger 不支持该级别时静默跳过。
function logWith(logger, level, message) {
  // 只在 logger 存在且支持该级别方法时输出，避免测试环境报错。
  if (logger && typeof logger[level] === 'function') {
    logger[level](message);
  }
}

// 输出 TimeProvider 信息级日志。
TimeProvider.prototype.logInfo = function logInfo(message) {
  // 统一走 logWith，兼容 console 和 winston logger。
  logWith(this.logger, 'info', message);
};

// 输出 TimeProvider 错误级日志。
TimeProvider.prototype.logError = function logError(message) {
  // 错误日志同样兼容不同 logger 实现。
  logWith(this.logger, 'error', message);
};

// 默认导出一个全局 TimeProvider 实例，业务代码直接复用同一个同步状态。
module.exports = new TimeProvider();
// 同时导出类本身，便于测试或特殊场景创建独立实例。
module.exports.TimeProvider = TimeProvider;
