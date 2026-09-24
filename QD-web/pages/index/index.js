import { sha256 } from 'js-sha256';

// 日期选择器、时间显示和会话认证共用的基础工具。
const padNumber = (value) => String(value).padStart(2, '0');

const createOptionList = (start, end, formatLabel) => {
	const options = [];
	for (let value = start; value <= end; value += 1) {
		options.push({
			value,
			label: formatLabel(value)
		});
	}
	return options;
};

const createYearOptions = (centerYear) => createOptionList(centerYear - 25, centerYear + 15, (value) => `${value}年`);

const createMonthOptions = () => createOptionList(1, 12, (value) => `${padNumber(value)}月`);

const getDaysInMonth = (year, month) => new Date(year, month, 0).getDate();

const createDayOptions = (year, month) => createOptionList(1, getDaysInMonth(year, month), (value) => `${padNumber(value)}日`);

const formatDateParts = (year, month, day) => `${year}-${padNumber(month)}-${padNumber(day)}`;

// 管理员登录采用会话级存储，普通用户密钥按地点持久化存储。
const ADMIN_SESSION_TIMEOUT_MS = 120 * 60 * 1000;
const USER_KEY_STORAGE_PREFIX = 'user_auth';

// 为当前页面实例生成唯一会话 ID，用于普通用户心跳和下线通知。
const createClientSessionId = () => {
	const random = new Uint8Array(16);
	const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
	if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
		cryptoApi.getRandomValues(random);
		return Array.from(random).map((value) => value.toString(16).padStart(2, '0')).join('');
	}
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;
};

const parseDateString = (value) => {
	if (typeof value === 'string') {
		const matched = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
		if (matched) {
			const year = Number(matched[1]);
			const month = Math.min(Math.max(Number(matched[2]), 1), 12);
			const day = Math.min(Math.max(Number(matched[3]), 1), getDaysInMonth(year, month));
			return { year, month, day };
		}
	}
	const today = new Date();
	return {
		year: today.getFullYear(),
		month: today.getMonth() + 1,
		day: today.getDate()
	};
};

const findOptionIndex = (options, value) => {
	const index = options.findIndex((item) => item.value === value);
	return index >= 0 ? index : 0;
};

// 后端网络时间统一按 UTC+8 展示，避免本地时区差异影响二维码时间提示。
const formatUtc8DateTimeFromMs = (ms) => {
	const date = new Date(ms + 8 * 60 * 60 * 1000);
	const year = date.getUTCFullYear();
	const month = padNumber(date.getUTCMonth() + 1);
	const day = padNumber(date.getUTCDate());
	const hour = padNumber(date.getUTCHours());
	const minute = padNumber(date.getUTCMinutes());
	const second = padNumber(date.getUTCSeconds());
	return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
};

// 兼容后端返回的多种网络时间字段格式。
const parseNetworkTimePayload = (payload) => {
	if (!payload) return null;
	const iso = typeof payload.iso === 'string'
		? payload.iso
		: (typeof payload.nowIso === 'string' ? payload.nowIso : '');
	const isoMs = iso ? Date.parse(iso) : NaN;
	if (Number.isFinite(isoMs)) return isoMs;

	const value = typeof payload.now === 'string'
		? payload.now
		: (typeof payload.nowDateTime === 'string' ? payload.nowDateTime : '');
	const matched = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
	if (!matched) return null;
	const [, year, month, day, hour, minute, second] = matched;
	return Date.UTC(
		Number(year),
		Number(month) - 1,
		Number(day),
		Number(hour) - 8,
		Number(minute),
		Number(second)
	);
};

// 手动刷新二维码的前端冷却时间，与后端返回冷却时间一起兜底。
const MANUAL_QR_REFRESH_COOLDOWN_MS = 15000;
const QR_REFRESH_FALLBACK_MS = 300000;
const QR_REFRESH_EARLY_MS = 10000;
const QR_STATUS_SYNC_INTERVAL_MS = 3000;

const parseLocationBinding = (value) => {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (!raw) return { wildcard: false, locations: [], normalized: '' };
	const parts = raw.split(',').map((item) => item.trim()).filter(Boolean);
	if (parts.includes('*')) return { wildcard: true, locations: [], normalized: '*' };
	const seen = new Set();
	const locations = [];
	parts.forEach((item) => {
		if (seen.has(item)) return;
		seen.add(item);
		locations.push(item);
	});
	return {
		wildcard: false,
		locations,
		normalized: locations.join(',')
	};
};

const normalizeLocationBinding = (value) => parseLocationBinding(value).normalized;

const replaceLocationBindingValue = (value, oldLocat, newLocat) => {
	const parsed = parseLocationBinding(value);
	const from = typeof oldLocat === 'string' ? oldLocat.trim() : '';
	const to = typeof newLocat === 'string' ? newLocat.trim() : '';
	if (!parsed.normalized || parsed.wildcard || !from || !to) return parsed.normalized;
	const seen = new Set();
	const locations = [];
	parsed.locations.forEach((locat) => {
		const next = locat === from ? to : locat;
		if (seen.has(next)) return;
		seen.add(next);
		locations.push(next);
	});
	return locations.join(',');
};

export default {
	// 页面状态集中在 data 中，模板只通过这些字段渲染弹窗、表格、二维码和提示。
	data() {
		const initialDate = parseDateString('');
		const pickerYears = createYearOptions(initialDate.year);
		const pickerMonths = createMonthOptions();
		const pickerDays = createDayOptions(initialDate.year, initialDate.month);

		return {
			qrCode: '',
			token: '',
			name: '',
			studentId: '',
			actionType: '',
			locat: '',
			date: '',
			formattedDate: '',
			// 本地演示默认连接回环地址；部署时可在构建配置中替换为后端地址。
			apiBaseUrl: 'http://127.0.0.1:4800',
			isKeyValid: false,
			authInitializing: true,
			startDate: '',
			endDate: '',
			formattedStartDate: '',
			formattedEndDate: '',
			statsList: [],
			showRankingModal: false,
			rankingLoading: false,
			rankingUpdatedAt: '',
			rankingList: [],
			rankingPage: 1,
			rankingPageSize: 50,
			rankingTotal: 0,
			rankingTotalPages: 1,
			showRecordsModal: false,
			showRecordsLocationDropdown: false,
			recordsLoading: false,
			recordsList: [],
			recordsPage: 1,
			recordsPageSize: 80,
			recordsPageSizeOptions: [80, 150, 200],
			recordsTotal: 0,
			recordsTotalPages: 1,
			recordsLocatMap: {},
			recordsLocationOptions: [{ label: '全部地点', value: '' }],
			recordsSearchLocationIndex: 0,
			recordsSearchName: '',
			recordsSearchStudentId: '',
			recordsSearchLocation: '',
			recordsSearchDate: '',
			recordsTableScrollLeft: 0,
			timer: null,
			statsTimer: null,
			showEditRecordModal: false,
			editRecord: { id: null, name: '', studentId: '', actionType: '签到', location: '', signInTime: '', signInDate: '', signInClock: '', signOutTime: '', signOutDate: '', signOutClock: '', timeadd: '' },
			editRecordSubmitting: false,
			showDeleteConfirm: false,
			deleteConfirmItem: null,
			deleteSubmitting: false,
			showAdminManageModal: false,
			adminManageTab: 'locats',
			adminManageLoading: false,
			adminManageSubmitting: false,
			adminLocats: [],
			adminUserKeys: [],
			showAdminKeyLocationModal: false,
			adminKeyLocationDraft: '',
			adminKeyLocationEditingRowKey: '',
			lastAdminKeyLocationSelectAt: 0,
			lastAdminKeyLocationSelectValue: '',
			showAdminConfirm: false,
			adminConfirmTitle: '确认操作',
			adminConfirmContent: '',
			adminConfirmText: '确定',
			adminConfirmResolver: null,
			lastAdminKeyVisibleToggleAt: 0,
			lastAdminKeyVisibleToggleId: null,
			showEditTimePicker: false,
			editTimePickerTarget: '',
			editTimePickerMode: 'date',
			editTimePickerHours: Array.from({length:24},(_,i)=>({value:i,label:String(i).padStart(2,'0')+'时'})),
			editTimePickerMinutes: Array.from({length:60},(_,i)=>({value:i,label:String(i).padStart(2,'0')+'分'})),
			editTimePickerSeconds: Array.from({length:60},(_,i)=>({value:i,label:String(i).padStart(2,'0')+'秒'})),
			editTimePickerDateValue: [0,0,0],
			editTimePickerTimeValue: [0,0,0],
			editTimePickerDateDraft: '',
			editTimePickerTimeDraft: '',
			editTimePickerYears: [],
			editTimePickerMonths: Array.from({length:12},(_,i)=>({value:i+1,label:String(i+1).padStart(2,'0')+'月'})),
			editTimePickerDays: [],
			heartbeatTimer: null,
			qrStatusTimer: null,
			adminSessionTimer: null,
			adminSessionExpiredHandled: false,
			adminLocatUnavailable: false,
			adminLocatUnavailableMessage: '',
			currentKey: '',
			currentRole: '',
			currentSessionId: createClientSessionId(),
			activeDatePicker: '',
			showDateModal: false,
			pickerYears,
			pickerMonths,
			pickerDays,
			datePickerValue: [findOptionIndex(pickerYears, initialDate.year), initialDate.month - 1, initialDate.day - 1],
			datePickerDraft: formatDateParts(initialDate.year, initialDate.month, initialDate.day),
			lastStatsPressAt: 0,
			lastStatsPressKey: '',
			lastStatsPressSource: '',
			hover: '',
			inputKey: '',
			keyPromptMessage: '',
			keyError: false,
			locationForbidden: false,
			showPassword: false,
			qrRefreshing: false,
			networkTimeDisplay: '',
			networkTimeSyncedAt: '',
			networkTimeBaseMs: 0,
			networkTimeBaseLocalMs: 0,
			networkTimeTickTimer: null,
			networkTimeLoading: false,
			lastManualQrRefreshAt: 0,
			manualQrCooldownRemaining: 0,
			manualQrCooldownTimer: null,
			toastTimer: null,
			appToast: {
				show: false,
				message: '',
				type: 'info'
			}
		};
	},
	// 页面进入时根据已有管理员/用户密钥决定是否直接进入仪表盘。
	onLoad(options) {
		this.locat = options && typeof options.locat === 'string' ? options.locat.trim() : '';

		// 优先读取管理员 sessionStorage（会话级别）
		const adminKey = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('admin_key') : null;
		if (adminKey) {
			if (this.isAdminSessionExpired()) {
				this.handleAdminSessionExpired();
				return;
			}
			this.currentKey = adminKey;
			this.currentRole = 'admin';
			this._startAdminSessionTimer();
			this.startDashboard().finally(() => {
				this.authInitializing = false;
			});
			return;
		}

		// 再读当前地点的普通用户 localStorage（持久）
		const savedKey = this.getStoredUserKey();
		if (savedKey) {
			this.currentKey = savedKey;
			this.currentRole = 'user';
			// 重新向后端校验密钥状态
			this.revalidateKeyAndStart();
			return;
		}
		this.authInitializing = false;
		this.validateKey();
	},
		// 页面退出时清理轮询，并尽量通知后端当前普通用户会话下线。
		onUnload() {
			this.stopDashboardTimers();
			this.clearManualQrCooldown();
			this.stopNetworkTimeTicker();
			this._stopHeartbeat();
		this._stopAdminSessionTimer();
		if (this.toastTimer) {
			clearTimeout(this.toastTimer);
		}
		// 页面卸载时只通知当前标签页会话下线，其他标签页不受影响。
		if (this.currentRole === 'user' && this.currentKey) {
			try {
				const payload = JSON.stringify({ key: this.currentKey, sessionId: this.currentSessionId });
				navigator.sendBeacon(this.apiBaseUrl + '/offline', new Blob([payload], { type: 'application/json' }));
			} catch(e) {}
		}
	},
	methods: {
			// 普通用户缓存按地点隔离，避免多个地点页面互相覆盖登录状态。
			getUserStorageKey(name) {
				const locat = typeof this.locat === 'string' && this.locat.trim() ? this.locat.trim() : 'default';
				return `${USER_KEY_STORAGE_PREFIX}:${locat}:${name}`;
			},
			getStoredUserKey() {
				return uni.getStorageSync(this.getUserStorageKey('key')) || '';
			},
			setStoredUserSession(key, location, loginAt) {
				uni.setStorageSync(this.getUserStorageKey('key'), key || '');
				uni.setStorageSync(this.getUserStorageKey('location'), location || '');
				uni.setStorageSync(this.getUserStorageKey('loginAt'), loginAt || '');
			},
			clearStoredUserSession() {
				uni.removeStorageSync(this.getUserStorageKey('key'));
				uni.removeStorageSync(this.getUserStorageKey('location'));
				uni.removeStorageSync(this.getUserStorageKey('loginAt'));
			},
			// 统一生成后端接口认证头：管理员直传 key，普通用户通过 nonce + HMAC 签名。
			async getAuthHeaders() {
				// 管理员：用 sessionStorage 存的 key，直接明文发送
				if (this.currentRole === 'admin') {
					const adminKey = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('admin_key') : null;
					if (this.isAdminSessionExpired()) {
						this.handleAdminSessionExpired();
						return null;
					}
					if (!adminKey) return null;
					return { 'key': adminKey };
				}

				// 普通用户：HMAC 签名。只使用当前页面实例密钥，避免其他地点标签页覆盖本页身份。
				const plainKey = this.currentKey || this.getStoredUserKey();
				if (!plainKey) return null;

				const nonceRes = await new Promise((resolve) => {
					uni.request({
						url: `${this.apiBaseUrl}/auth/nonce`,
						method: 'GET',
						header: { 'X-Key-Hash': sha256(plainKey).slice(0, 12) },
						success: (res) => resolve(res),
						fail: () => resolve(null)
					});
				});
				if (!nonceRes || nonceRes.statusCode !== 200 || !nonceRes.data || !nonceRes.data.nonce) return null;
				const nonce = nonceRes.data.nonce;

				const hex = sha256.hmac(plainKey, nonce);

				return {
					'X-Auth-Nonce': nonce,
					'X-Auth-Sign': hex,
					'X-Session-Id': this.currentSessionId
				};
			},
		// 使用页面内自定义 toast，避免不同端对 uni.showToast 的展示差异。
		showAppToast(payload) {
			const options = typeof payload === 'string' ? { title: payload } : (payload || {});
			const title = options.title || '';
			const icon = options.icon || 'none';
			const duration = typeof options.duration === 'number' ? options.duration : 1800;

			this.appToast.message = title;
			this.appToast.type = icon === 'success' ? 'success' : icon === 'error' ? 'error' : 'info';
			this.appToast.show = true;

			if (this.toastTimer) {
				clearTimeout(this.toastTimer);
				this.toastTimer = null;
			}
			if (duration > 0) {
				this.toastTimer = setTimeout(() => {
					this.hideAppToast();
				}, duration);
			}
		},
		hideAppToast() {
			this.appToast.show = false;
		},
		getResponseMessage(res, fallback = '') {
			const message = res && res.data && typeof res.data.message === 'string' ? res.data.message.trim() : '';
			return message || fallback;
		},
		// 管理员 session 只在当前浏览器会话内有效，超时后回到密钥输入。
		getAdminLoginAt() {
			try {
				if (typeof sessionStorage === 'undefined') return 0;
				const value = Number(sessionStorage.getItem('admin_login_at'));
				return Number.isFinite(value) ? value : 0;
			} catch(e) {
				return 0;
			}
		},
		isAdminSessionExpired() {
			const loginAt = this.getAdminLoginAt();
			return !loginAt || Date.now() - loginAt >= ADMIN_SESSION_TIMEOUT_MS;
		},
		clearAdminSession() {
			try {
				if (typeof sessionStorage !== 'undefined') {
					sessionStorage.removeItem('admin_key');
					sessionStorage.removeItem('admin_location');
					sessionStorage.removeItem('admin_login_at');
				}
			} catch(e) {}
		},
		_startAdminSessionTimer() {
			this._stopAdminSessionTimer();
			const loginAt = this.getAdminLoginAt();
			const remaining = ADMIN_SESSION_TIMEOUT_MS - (Date.now() - loginAt);
			if (!loginAt || remaining <= 0) {
				this.handleAdminSessionExpired();
				return;
			}
			this.adminSessionTimer = setTimeout(() => {
				this.handleAdminSessionExpired();
			}, remaining);
		},
		_stopAdminSessionTimer() {
			if (this.adminSessionTimer) {
				clearTimeout(this.adminSessionTimer);
				this.adminSessionTimer = null;
			}
		},
		handleAdminSessionExpired() {
			this._stopAdminSessionTimer();
			this.clearAdminSession();
			this.adminSessionExpiredHandled = true;
			this.currentKey = '';
			this.currentRole = '';
			this.showAdminManageModal = false;
			this.returnToKeyInput('管理员登录已超时，请重新输入密钥', {
				icon: 'none',
				duration: 2500
			});
		},
		// 仪表盘会启动二维码刷新、统计刷新和网络时间计时器，退出时统一清理。
		stopDashboardTimers() {
			if (this.timer) {
				clearTimeout(this.timer);
				this.timer = null;
			}
			this.stopQrStatusSync();
			if (this.statsTimer) {
				clearInterval(this.statsTimer);
				this.statsTimer = null;
			}
			this.stopNetworkTimeTicker();
		},
		async startDashboard() {
			this.stopDashboardTimers();
			this.isKeyValid = true;
			this.fetchNetworkTime({ silent: true });

			const qrOk = await this.fetchQrCode({ allowAdminUnavailable: this.currentRole === 'admin' });
			if (!qrOk || !this.isKeyValid) return false;
			this.startQrStatusSync();

			await this.fetchStats();
			if (!this.isKeyValid) return false;

			this.statsTimer = setInterval(() => {
				this.fetchStats();
			}, 60000);
			return true;
		},
		scheduleQrRefresh(remainingSeconds) {
			if (this.timer) {
				clearTimeout(this.timer);
				this.timer = null;
			}
			if (!this.isKeyValid || this.adminLocatUnavailable) return;
			const remaining = Number(remainingSeconds);
			const delay = Number.isFinite(remaining) && remaining > 0
				? Math.max(1000, remaining * 1000 - QR_REFRESH_EARLY_MS)
				: QR_REFRESH_FALLBACK_MS;
			this.timer = setTimeout(async () => {
				this.timer = null;
				if (!this.isKeyValid) return;
				await this.fetchQrCode({ silent: true, allowAdminUnavailable: this.currentRole === 'admin', forceRefresh: true });
			}, delay);
		},
		startQrStatusSync() {
			this.stopQrStatusSync();
			const syncStatus = async () => {
				if (!this.isKeyValid || this.adminLocatUnavailable || !this.locat || !this.token) return;
				try {
					const res = await uni.request({
						url: `${this.apiBaseUrl}/qr-status?locat=${encodeURIComponent(this.locat)}`,
						method: 'GET'
					});
					if (res.statusCode !== 200 || !res.data || !res.data.active) return;
					const activeHash = typeof res.data.tokenHash === 'string' ? res.data.tokenHash : '';
					const currentHash = this.token ? sha256(this.token).slice(0, 12) : '';
					if (activeHash && currentHash && activeHash !== currentHash) {
						await this.fetchQrCode({ silent: true, allowAdminUnavailable: this.currentRole === 'admin' });
					} else if (activeHash && activeHash === currentHash) {
						this.scheduleQrRefresh(res.data.tokenRemainingSeconds);
					}
				} catch (e) { /* 状态同步失败忽略，下次再试 */ }
			};
			this.qrStatusTimer = setInterval(syncStatus, QR_STATUS_SYNC_INTERVAL_MS);
		},
		stopQrStatusSync() {
			if (this.qrStatusTimer) {
				clearInterval(this.qrStatusTimer);
				this.qrStatusTimer = null;
			}
		},
		// 重置到密钥输入态，同时关闭所有可能打开的弹窗和异步状态。
		returnToKeyInput(message, options = {}) {
			this._stopHeartbeat();
			this._stopAdminSessionTimer();
			if (options.clearKey) {
				this.clearStoredUserSession();
				this.clearAdminSession();
				this.currentKey = '';
				this.currentRole = '';
			}
			this.stopDashboardTimers();
			this.qrCode = '';
			this.token = '';
			this.networkTimeDisplay = '';
			this.networkTimeSyncedAt = '';
			this.networkTimeBaseMs = 0;
			this.networkTimeBaseLocalMs = 0;
			this.networkTimeLoading = false;
			this.adminLocatUnavailable = false;
			this.adminLocatUnavailableMessage = '';
			this.statsList = [];
			this.qrRefreshing = false;
			this.lastManualQrRefreshAt = 0;
			this.clearManualQrCooldown();
			this.hover = '';
			this.showRankingModal = false;
			this.showRecordsModal = false;
			this.showRecordsLocationDropdown = false;
			this.showEditRecordModal = false;
			this.showEditTimePicker = false;
			this.showDeleteConfirm = false;
			this.showAdminManageModal = false;
			this.showAdminKeyLocationModal = false;
			if (typeof this.adminConfirmResolver === 'function') {
				this.adminConfirmResolver(false);
			}
			this.adminConfirmResolver = null;
			this.showAdminConfirm = false;
			this.deleteConfirmItem = null;
			this.deleteSubmitting = false;
			this.recordsLoading = false;
			this.isKeyValid = false;
			this.validateKey();
			this.locationForbidden = Boolean(options.locationForbidden);
			if (message) {
				this.keyPromptMessage = message;
				this.keyError = !this.locationForbidden;
			}
			if (message && options.toast === true) {
				this.showAppToast({
					title: message,
					icon: options.icon || 'none',
					duration: typeof options.duration === 'number' ? options.duration : 2500
				});
			}
		},
		handleLocatInvalid(message = '该地址不存在，请联系管理员') {
			this.returnToKeyInput(message, {
				clearKey: true,
				icon: 'none',
				duration: 3000
			});
		},
		markAdminLocatUnavailable(message = '该地点已关闭，请联系管理员', options = {}) {
			this.adminLocatUnavailable = true;
			this.adminLocatUnavailableMessage = message;
			this.qrCode = '';
			this.token = '';
			if (!options.silent) {
				this.showAppToast({
					title: message,
					icon: 'none',
					duration: typeof options.duration === 'number' ? options.duration : 2600
				});
			}
		},

		// 统计卡片悬浮和点击逻辑，移动端会去重 tap/click 双触发。
		showNames(loc) {
			this.hover = loc;
		},
		onStatsItemPress(loc, source = '') {
			const now = Date.now();
			const isSameLoc = this.lastStatsPressKey === loc;
			const isTapThenClickDuplicate =
				source === 'click' &&
				this.lastStatsPressSource === 'tap' &&
				isSameLoc &&
				now - this.lastStatsPressAt < 850;
			const isSameSourceDuplicate = source && this.lastStatsPressSource === source && isSameLoc && now - this.lastStatsPressAt < 260;
			if (isTapThenClickDuplicate || isSameSourceDuplicate) {
				return;
			}
			this.lastStatsPressAt = now;
			this.lastStatsPressKey = loc;
			this.lastStatsPressSource = source;
			this.toggleNames(loc);
		},
		onContainerClick() {
			this.hideNames();
			this.closeDateModal();
			this.closeRecordsLocationDropdown();
			this.closeRankingModal();
			this.closeRecordsModal();
		},
		hideNames() {
			this.hover = '';
		},
		toggleNames(loc) {
			this.hover = this.hover === loc ? '' : loc;
		},
		// 首页、记录筛选共用同一个三列日期选择弹窗。
		openDateModal(type) {
			let currentValue = '';
			if (type === 'start') {
				currentValue = this.startDate;
			} else if (type === 'end') {
				currentValue = this.endDate;
			} else if (type === 'records') {
				currentValue = this.recordsSearchDate;
			}
			this.hideNames();
			this.closeRecordsLocationDropdown();
			this.activeDatePicker = type;
			this.syncDatePickerDraft(currentValue);
			this.showDateModal = true;
		},
		closeDateModal() {
			this.showDateModal = false;
			this.activeDatePicker = '';
		},
		formatHoursToLabel(totalHours) {
			const hourValue = Number(totalHours) || 0;
			const totalMinutes = Math.max(0, Math.round(hourValue * 60));
			const hours = Math.floor(totalMinutes / 60);
			const minutes = totalMinutes % 60;
			if (hours <= 0) return `${minutes} 分钟`;
			if (minutes === 0) return `${hours} 小时`;
			return `${hours} 小时 ${minutes} 分钟`;
		},
		formatRankingTimestamp(timestamp) {
			if (!timestamp) return '';
			const date = new Date(timestamp);
			if (Number.isNaN(date.getTime())) return '';
			const year = date.getFullYear();
			const month = String(date.getMonth() + 1).padStart(2, '0');
			const day = String(date.getDate()).padStart(2, '0');
			const hour = String(date.getHours()).padStart(2, '0');
			const minute = String(date.getMinutes()).padStart(2, '0');
			return `${year}-${month}-${day} ${hour}:${minute}`;
		},
		// 总时长排行榜弹窗和分页数据。
		async openRankingModal() {
			this.hideNames();
			this.closeDateModal();
			this.closeRecordsModal();
			this.showRankingModal = true;
			await this.fetchTimeaddRanking(1);
		},
		closeRankingModal() {
			this.showRankingModal = false;
		},
		async handleRankingRefresh() {
			if (this.rankingLoading) return;
			await this.fetchTimeaddRanking(1);
		},
		async changeRankingPage(delta) {
			if (this.rankingLoading) return;
			const nextPage = this.rankingPage + delta;
			if (nextPage < 1 || nextPage > this.rankingTotalPages) return;
			await this.fetchTimeaddRanking(nextPage);
		},
		async fetchTimeaddRanking(page = this.rankingPage) {
			if (this.rankingLoading) return;
			this.rankingLoading = true;
			try {
				const requestedPage = Number(page);
				const safePage = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
				const header = await this.getAuthHeaders();
				if (!header) {
					this._authFail();
					return;
				}

				const res = await uni.request({
					url: `${this.apiBaseUrl}/timeadd-ranking?page=${safePage}`,
					method: 'GET',
					header
				});

				if (res.statusCode === 200 && res.data) {
					const rows = Array.isArray(res.data.list) ? res.data.list : [];
					const total = Number(res.data.total) || 0;
					const totalPages = Number(res.data.totalPages) || 1;
					const responsePage = Number(res.data.page) || safePage;
					this.rankingList = rows.map((item, index) => ({
						rank: Number(item.rank) || index + 1,
						studentId: item.studentId || '',
						name: item.name || '',
						totalHours: Number(item.totalHours) || 0,
						recordCount: Number(item.recordCount) || 0,
						completedCount: Number(item.completedCount) || 0
					}));
					this.rankingPage = responsePage;
					this.rankingPageSize = Number(res.data.pageSize) || 50;
					this.rankingTotal = total;
					this.rankingTotalPages = Math.max(1, totalPages);
					this.rankingUpdatedAt = this.formatRankingTimestamp(res.data.generatedAt);
				} else if (res.statusCode === 403) {
					this._authFail();
				} else {
					console.error('获取时长排行榜失败:', res);
					this.showAppToast({ title: '获取时长排行榜失败，请稍后重试', icon: 'error', duration: 1800 });
				}
			} catch (err) {
				console.error('获取时长排行榜出错:', err);
				this.showAppToast({ title: '网络错误，请稍后重试', icon: 'error', duration: 1800 });
			} finally {
				this.rankingLoading = false;
			}
		},
		// 管理员编辑签到记录时，把接口时间拆成日期和时分秒，方便分别选择。
		getEditDateTimeKeys(target) {
			return target === 'signOutTime'
				? { valueKey: 'signOutTime', dateKey: 'signOutDate', timeKey: 'signOutClock' }
				: { valueKey: 'signInTime', dateKey: 'signInDate', timeKey: 'signInClock' };
		},

		parseEditDateTime(value) {
			const text = typeof value === 'string' ? value.trim() : '';
			const matched = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
			if (!matched) {
				return { date: '', time: '' };
			}
			const year = Number(matched[1]);
			const month = Math.min(Math.max(Number(matched[2]), 1), 12);
			const day = Math.min(Math.max(Number(matched[3]), 1), getDaysInMonth(year, month));
			if (matched[4] === undefined) {
				return { date: formatDateParts(year, month, day), time: '' };
			}
			const hour = Math.min(Math.max(Number(matched[4]), 0), 23);
			const minute = Math.min(Math.max(Number(matched[5]), 0), 59);
			const second = Math.min(Math.max(Number(matched[6] || 0), 0), 59);
			return {
				date: formatDateParts(year, month, day),
				time: `${padNumber(hour)}:${padNumber(minute)}:${padNumber(second)}`
			};
		},

		getEditDateTimeParts(target) {
			const keys = this.getEditDateTimeKeys(target);
			const parsed = this.parseEditDateTime(this.editRecord[keys.valueKey]);
			return {
				date: this.editRecord[keys.dateKey] || parsed.date,
				time: this.editRecord[keys.timeKey] || parsed.time
			};
		},

		buildEditDateTime(target) {
			const keys = this.getEditDateTimeKeys(target);
			const date = (this.editRecord[keys.dateKey] || '').trim();
			const time = (this.editRecord[keys.timeKey] || '').trim();
			return date && time ? `${date} ${time}` : '';
		},

		syncEditDateTimeValue(target) {
			const keys = this.getEditDateTimeKeys(target);
			this.editRecord[keys.valueKey] = this.buildEditDateTime(target);
		},

		syncEditActionType() {
			this.editRecord.actionType = this.buildEditDateTime('signOutTime') ? '已完成' : '签到';
		},

		// 复用 picker-view 实现签到/签退时间的日期和时间选择。
		openEditTimePicker(target, mode = 'date') {
			this.editTimePickerTarget = target;
			this.editTimePickerMode = mode === 'time' ? 'time' : 'date';
			const now = new Date();
			const currentYear = now.getFullYear();
			const parts = this.getEditDateTimeParts(target);
			const dateParts = parseDateString(parts.date);
			const timeMatched = (parts.time || '').match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
			const hour = timeMatched ? Math.min(Math.max(Number(timeMatched[1]), 0), 23) : now.getHours();
			const minute = timeMatched ? Math.min(Math.max(Number(timeMatched[2]), 0), 59) : now.getMinutes();
			const second = timeMatched ? Math.min(Math.max(Number(timeMatched[3] || 0), 0), 59) : now.getSeconds();

			this.editTimePickerYears = createYearOptions(dateParts.year || currentYear);
			this.editTimePickerMonths = createMonthOptions();
			this.editTimePickerDays = createDayOptions(dateParts.year, dateParts.month);
			this.editTimePickerDateValue = [
				findOptionIndex(this.editTimePickerYears, dateParts.year),
				dateParts.month - 1,
				Math.min(dateParts.day, getDaysInMonth(dateParts.year, dateParts.month)) - 1
			];
			this.editTimePickerTimeValue = [hour, minute, second];
			this.editTimePickerDateDraft = formatDateParts(dateParts.year, dateParts.month, dateParts.day);
			this.editTimePickerTimeDraft = `${padNumber(hour)}:${padNumber(minute)}:${padNumber(second)}`;
			this.showEditTimePicker = true;
		},

		onEditDatePickerChange(e) {
			const [yIdx, mIdx, dIdx] = e.detail.value;
			const year  = (this.editTimePickerYears[yIdx] || this.editTimePickerYears[0]).value;
			const month = mIdx + 1;
			const daysInMonth = new Date(year, month, 0).getDate();
			this.editTimePickerDays = Array.from({length: daysInMonth}, (_, i) => ({ value: i+1, label: String(i+1).padStart(2,'0') + '日' }));
			const day = Math.min(dIdx + 1, daysInMonth);
			this.editTimePickerDateValue = [yIdx, mIdx, day - 1];
			this.editTimePickerDateDraft = year + '-' + String(month).padStart(2,'0') + '-' + String(day).padStart(2,'0');
		},

		onEditTimePickerChange(e) {
			const [h, min, sec] = e.detail.value;
			this.editTimePickerTimeValue = [h, min, sec];
			this.editTimePickerTimeDraft = String(h).padStart(2,'0') + ':' + String(min).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
		},

		confirmEditTimePicker() {
			const keys = this.getEditDateTimeKeys(this.editTimePickerTarget);
			if (this.editTimePickerMode === 'date') {
				this.editRecord[keys.dateKey] = this.editTimePickerDateDraft;
			} else {
				this.editRecord[keys.timeKey] = this.editTimePickerTimeDraft;
			}
			this.syncEditDateTimeValue(this.editTimePickerTarget);
			this.syncEditActionType();
			this.showEditTimePicker = false;
		},

		getEditTimePickerTitle() {
			const targetLabel = this.editTimePickerTarget === 'signOutTime' ? '签退' : '签到';
			const modeLabel = this.editTimePickerMode === 'time' ? '时分秒' : '年月日';
			return `选择${targetLabel}${modeLabel}`;
		},

		clearEditSignOutTime() {
			this.editRecord.signOutTime = '';
			this.editRecord.signOutDate = '';
			this.editRecord.signOutClock = '';
			this.syncEditActionType();
		},

		// 管理员对签到详情中的单条记录进行编辑、删除和保存。
		adminEditRecord(item) {
			const signInParts = this.parseEditDateTime(item.signInTime || '');
			const signOutParts = this.parseEditDateTime(item.signOutTime || '');
			const signInTime = signInParts.date && signInParts.time ? `${signInParts.date} ${signInParts.time}` : '';
			const signOutTime = signOutParts.date && signOutParts.time ? `${signOutParts.date} ${signOutParts.time}` : '';
			this.editRecord = {
				id: item.id,
				name: item.name || '',
				studentId: item.studentId || '',
				actionType: signOutTime ? '已完成' : '签到',
				location: item.location || '',
				signInTime,
				signInDate: signInParts.date,
				signInClock: signInParts.time,
				signOutTime,
				signOutDate: signOutParts.date,
				signOutClock: signOutParts.time,
				timeadd: item.timeadd === '' || item.timeadd === null || item.timeadd === undefined ? '' : String(item.timeadd),
			};
			this.showDeleteConfirm = false;
			this.showEditRecordModal = true;
		},

		adminDeleteRecord(item) {
			if (!item.id) return;
			this.deleteConfirmItem = { ...item };
			this.showDeleteConfirm = true;
		},

		closeDeleteConfirm() {
			if (this.deleteSubmitting) return;
			this.showDeleteConfirm = false;
			this.deleteConfirmItem = null;
		},

		formatDeleteRecordName(item) {
			if (!item) return '该记录';
			return item.name || item.studentId || '该记录';
		},

		async confirmDeleteRecord() {
			if (this.deleteSubmitting || !this.deleteConfirmItem || !this.deleteConfirmItem.id) return;
			const item = this.deleteConfirmItem;
			this.deleteSubmitting = true;
			try {
				const headers = await this.getAuthHeaders();
				if (!headers) return;
				const res = await uni.request({
					url: `${this.apiBaseUrl}/sign-records/${item.id}`,
					method: 'DELETE',
					header: headers
				});
				if (res.statusCode === 200) {
					this.showDeleteConfirm = false;
					this.deleteConfirmItem = null;
					this.showAppToast({ title: '删除成功', icon: 'success' });
					this.fetchSignRecords();
				} else {
					this.showAppToast({ title: (res.data && res.data.message) || '删除失败', icon: 'error' });
				}
			} catch (e) {
				this.showAppToast({ title: '网络错误', icon: 'error' });
			} finally {
				this.deleteSubmitting = false;
			}
		},

		async submitEditRecord() {
			if (this.editRecordSubmitting) return;
			const { id, name, studentId, location } = this.editRecord;
			if (!id) return;
			const signInTime = this.buildEditDateTime('signInTime');
			const signOutTime = this.buildEditDateTime('signOutTime');
			const hasPartialSignOutTime = Boolean(this.editRecord.signOutDate || this.editRecord.signOutClock);
			if (!signInTime) {
				this.showAppToast({ title: '请选择完整签到时间', icon: 'error' });
				return;
			}
			if (hasPartialSignOutTime && !signOutTime) {
				this.showAppToast({ title: '请选择完整签退日期和时间', icon: 'error' });
				return;
			}
			const finalActionType = signOutTime ? '已完成' : '签到';
			this.editRecordSubmitting = true;
			try {
				const headers = await this.getAuthHeaders();
				if (!headers) { this.editRecordSubmitting = false; return; }
				const res = await uni.request({
					url: `${this.apiBaseUrl}/sign-records/${id}`,
					method: 'PUT',
					header: { ...headers, 'Content-Type': 'application/json' },
					data: { name, studentId, actionType: finalActionType, location, signInTime, signOutTime }
				});
				if (res.statusCode === 200) {
					this.showEditRecordModal = false;
					this.showAppToast({ title: '保存成功', icon: 'success' });
					this.fetchSignRecords();
				} else {
					this.showAppToast({ title: (res.data && res.data.message) || '保存失败', icon: 'error' });
				}
			} catch (e) {
				this.showAppToast({ title: '网络错误', icon: 'error' });
			} finally {
				this.editRecordSubmitting = false;
			}
		},

		// 签到详情弹窗负责搜索、分页、地点筛选和移动端横向滚动同步。
		async openRecordsModal() {
			this.hideNames();
			this.closeDateModal();
			this.closeRankingModal();
			this.closeRecordsLocationDropdown();
			this.showRecordsModal = true;
			this.recordsPage = 1;
			await this.fetchSignRecords();
		},
		closeRecordsModal() {
			this.showRecordsModal = false;
			this.showRecordsLocationDropdown = false;
			this.showEditRecordModal = false;
			this.showEditTimePicker = false;
			this.showDeleteConfirm = false;
			this.deleteConfirmItem = null;
		},
		syncRecordsLocationOptions(rows = []) {
			const map = this.recordsLocatMap && typeof this.recordsLocatMap === 'object' ? this.recordsLocatMap : {};
			const hasLocationCode = (code) => Object.prototype.hasOwnProperty.call(map, code);
			const entries = Object.keys(map)
				.map((code) => {
					const value = typeof code === 'string' ? code.trim() : '';
					if (!value) return null;
					const cn = typeof map[code] === 'string' ? map[code].trim() : '';
					return {
						value,
						label: cn || value
					};
				})
				.filter(Boolean);
			const fallbackEntries = (Array.isArray(rows) ? rows : [])
				.map((item) => {
					const value = item && typeof item.location === 'string' ? item.location.trim() : '';
					if (!value || hasLocationCode(value)) return null;
					return {
						value,
						label: value
					};
				})
				.filter(Boolean)
				.filter((item, index, list) => list.findIndex((current) => current.value === item.value) === index);
			const options = [{ label: '全部地点', value: '' }, ...entries, ...fallbackEntries];
			this.recordsLocationOptions = options;

			const currentValue = typeof this.recordsSearchLocation === 'string' ? this.recordsSearchLocation : '';
			const matchedIndex = options.findIndex((item) => item.value === currentValue);
			if (matchedIndex >= 0) {
				this.recordsSearchLocationIndex = matchedIndex;
			} else {
				this.recordsSearchLocation = '';
				this.recordsSearchLocationIndex = 0;
			}
		},
		getRecordsSelectedLocationLabel() {
			const options = Array.isArray(this.recordsLocationOptions) ? this.recordsLocationOptions : [];
			const index = Number.isInteger(this.recordsSearchLocationIndex) ? this.recordsSearchLocationIndex : 0;
			const selected = options[index];
			return selected && selected.label ? selected.label : '全部地点';
		},
		getRecordsLocationDropdownHeight() {
			const count = Array.isArray(this.recordsLocationOptions) ? this.recordsLocationOptions.length : 1;
			const visibleCount = Math.max(1, Math.min(count, 5));
			return `${visibleCount * 44 + 12}px`;
		},
		toggleRecordsLocationDropdown() {
			this.closeDateModal();
			this.showRecordsLocationDropdown = !this.showRecordsLocationDropdown;
		},
		closeRecordsLocationDropdown() {
			this.showRecordsLocationDropdown = false;
		},
		onRecordsLocationSelect(index) {
			const options = Array.isArray(this.recordsLocationOptions) ? this.recordsLocationOptions : [];
			if (!options.length) {
				this.recordsSearchLocation = '';
				this.recordsSearchLocationIndex = 0;
				this.closeRecordsLocationDropdown();
				return;
			}
			const parsedIndex = Number.parseInt(index, 10);
			const safeIndex = Number.isInteger(parsedIndex) && parsedIndex >= 0 && parsedIndex < options.length ? parsedIndex : 0;
			this.recordsSearchLocationIndex = safeIndex;
			this.recordsSearchLocation = options[safeIndex] && typeof options[safeIndex].value === 'string' ? options[safeIndex].value : '';
			this.closeRecordsLocationDropdown();
		},
		getRecordsSearchPayload() {
			const name = typeof this.recordsSearchName === 'string' ? this.recordsSearchName.trim() : '';
			const studentId = typeof this.recordsSearchStudentId === 'string' ? this.recordsSearchStudentId.trim() : '';
			const location = typeof this.recordsSearchLocation === 'string' ? this.recordsSearchLocation.trim() : '';
			const date = typeof this.recordsSearchDate === 'string' ? this.recordsSearchDate.trim() : '';
			return { name, studentId, location, date };
		},
		openRecordsSearchDateModal() {
			this.closeRecordsLocationDropdown();
			this.openDateModal('records');
		},
		async handleRecordsSearch() {
			this.closeRecordsLocationDropdown();
			this.recordsPage = 1;
			await this.fetchSignRecords();
		},
		async resetRecordsSearch() {
			this.closeRecordsLocationDropdown();
			this.recordsSearchName = '';
			this.recordsSearchStudentId = '';
			this.recordsSearchLocation = '';
			this.recordsSearchLocationIndex = 0;
			this.recordsSearchDate = '';
			this.recordsPage = 1;
			await this.fetchSignRecords();
		},
		async setRecordsPageSize(size) {
			const nextSize = Number(size);
			if (!this.recordsPageSizeOptions.includes(nextSize)) return;
			if (this.recordsPageSize === nextSize) return;
			this.recordsPageSize = nextSize;
			this.recordsPage = 1;
			await this.fetchSignRecords();
		},
		async changeRecordsPage(step) {
			if (this.recordsLoading) return;
			const delta = Number(step);
			if (!Number.isFinite(delta)) return;
			const nextPage = this.recordsPage + delta;
			if (nextPage < 1 || nextPage > this.recordsTotalPages) return;
			this.recordsPage = nextPage;
			await this.fetchSignRecords();
		},
		formatRecordLocation(code) {
			const normalized = typeof code === 'string' ? code.trim() : '';
			if (!normalized) return '-';
			return this.recordsLocatMap[normalized] || normalized;
		},
		formatRecordDuration(value) {
			if (value === '' || value === null || value === undefined) return '-';
			const hoursValue = Number(value);
			if (!Number.isFinite(hoursValue)) return '-';
			return this.formatHoursToLabel(hoursValue);
		},
		syncRecordsTableScroll(e) {
			const nextLeft = Number(e && e.detail && e.detail.scrollLeft);
			if (!Number.isFinite(nextLeft)) return;
			this.recordsTableScrollLeft = nextLeft;
		},
		onRecordsTableScroll(e) {
			this.syncRecordsTableScroll(e);
		},
		onRecordsTableScrollbarScroll(e) {
			this.syncRecordsTableScroll(e);
		},
		async fetchSignRecords() {
			if (this.recordsLoading) return;
			this.recordsLoading = true;
			try {
				const header = await this.getAuthHeaders();
				if (!header) {
					this._authFail();
					return;
				}
				const searchPayload = this.getRecordsSearchPayload();
				const queryParts = [`page=${this.recordsPage}`, `pageSize=${this.recordsPageSize}`];
				if (searchPayload.name) {
					queryParts.push(`name=${encodeURIComponent(searchPayload.name)}`);
				}
				if (searchPayload.studentId) {
					queryParts.push(`studentId=${encodeURIComponent(searchPayload.studentId)}`);
				}
				if (searchPayload.location) {
					queryParts.push(`location=${encodeURIComponent(searchPayload.location)}`);
				}
				if (searchPayload.date) {
					queryParts.push(`date=${encodeURIComponent(searchPayload.date)}`);
				}
				const res = await uni.request({
					url: `${this.apiBaseUrl}/sign-records?${queryParts.join('&')}`,
					method: 'GET',
					header
				});

				if (res.statusCode === 200 && res.data) {
					const payload = res.data || {};
					const nextPageSize = Number(payload.pageSize);
					if (this.recordsPageSizeOptions.includes(nextPageSize)) {
						this.recordsPageSize = nextPageSize;
					}

					const nextTotal = Number(payload.total);
					this.recordsTotal = Number.isFinite(nextTotal) && nextTotal > 0 ? Math.floor(nextTotal) : 0;

					const nextTotalPages = Number(payload.totalPages);
					this.recordsTotalPages = Number.isFinite(nextTotalPages) && nextTotalPages > 0 ? Math.floor(nextTotalPages) : 1;

					const nextPage = Number(payload.page);
					this.recordsPage = Number.isFinite(nextPage) && nextPage > 0 ? Math.min(Math.floor(nextPage), this.recordsTotalPages) : 1;

					const rows = Array.isArray(payload.list) ? payload.list : [];
					this.recordsList = rows.map((item) => {
						const signOutTime = item && item.signOutTime ? item.signOutTime : '';
						const rawActionType = item && item.actionType ? item.actionType : '';
						return {
							name: item && item.name ? item.name : '',
							id: item && item.id ? item.id : null,
							studentId: item && item.studentId ? item.studentId : '',
							actionType: signOutTime ? (rawActionType || '已完成') : '签到',
							location: item && item.location ? item.location : '',
							signInTime: item && item.signInTime ? item.signInTime : '',
							signOutTime,
							timeadd: item && item.timeadd !== undefined && item.timeadd !== null && item.timeadd !== '' ? Number(item.timeadd) : ''
						};
					});
					this.recordsLocatMap = payload.locatMap && typeof payload.locatMap === 'object' ? payload.locatMap : {};
					this.syncRecordsLocationOptions(rows);
				} else if (res.statusCode === 403) {
					this._authFail();
				} else {
					console.error('获取签到详情失败:', res);
					const serverMessage = res && res.data && typeof res.data.message === 'string' ? res.data.message : '';
					this.showAppToast({
						title: serverMessage || '获取签到详情失败，请稍后重试',
						icon: 'error',
						duration: 1800
					});
				}
			} catch (err) {
				console.error('获取签到详情出错:', err);
				this.showAppToast({ title: '网络错误，请稍后重试', icon: 'error', duration: 1800 });
			} finally {
				this.recordsLoading = false;
			}
		},
		// 三列日期 picker 的数据同步，自动处理跨月份天数变化。
		ensureDatePickerYear(year) {
			const firstYear = this.pickerYears[0] ? this.pickerYears[0].value : year;
			const lastYear = this.pickerYears[this.pickerYears.length - 1] ? this.pickerYears[this.pickerYears.length - 1].value : year;
			if (year < firstYear || year > lastYear) {
				this.pickerYears = createYearOptions(year);
			}
		},
		syncDatePickerDraft(value) {
			const parsed = parseDateString(value);
			this.ensureDatePickerYear(parsed.year);
			this.pickerDays = createDayOptions(parsed.year, parsed.month);
			this.datePickerValue = [
				findOptionIndex(this.pickerYears, parsed.year),
				parsed.month - 1,
				Math.max(Math.min(parsed.day, this.pickerDays.length), 1) - 1
			];
			this.datePickerDraft = formatDateParts(parsed.year, parsed.month, parsed.day);
		},
		onDatePickerColumnChange(event) {
			const value = Array.isArray(event.detail.value) ? event.detail.value : [0, 0, 0];
			const yearIndex = Math.max(value[0] || 0, 0);
			const monthIndex = Math.max(value[1] || 0, 0);
			const year = this.pickerYears[yearIndex] ? this.pickerYears[yearIndex].value : this.pickerYears[0].value;
			const month = this.pickerMonths[monthIndex] ? this.pickerMonths[monthIndex].value : this.pickerMonths[0].value;
			const nextDays = createDayOptions(year, month);
			const dayIndex = Math.min(Math.max(value[2] || 0, 0), nextDays.length - 1);
			const day = nextDays[dayIndex] ? nextDays[dayIndex].value : 1;

			this.pickerDays = nextDays;
			this.datePickerValue = [yearIndex, monthIndex, dayIndex];
			this.datePickerDraft = formatDateParts(year, month, day);
		},
		confirmDateModal() {
			if (!this.activeDatePicker || !this.datePickerDraft) {
				this.closeDateModal();
				return;
			}
			if (this.activeDatePicker === 'start') {
				this.startDate = this.datePickerDraft;
				this.formattedStartDate = this.datePickerDraft;
			} else if (this.activeDatePicker === 'end') {
				this.endDate = this.datePickerDraft;
				this.formattedEndDate = this.datePickerDraft;
			} else if (this.activeDatePicker === 'records') {
				this.recordsSearchDate = this.datePickerDraft;
			}
			this.closeDateModal();
		},
		// 兼容新旧两种统计接口结构，统一转换为模板使用的 statsList。
		normalizeStatsPayload(payload) {
			if (!payload || typeof payload !== 'object') return [];

			const normalizeItem = (item) => {
				if (!item || typeof item !== 'object') return null;
				const rawKey = typeof item.key === 'string' ? item.key.trim() : '';
				if (!rawKey) return null;
				const rawLabel = typeof item.label === 'string' ? item.label.trim() : '';
				return {
					key: rawKey,
					label: rawLabel || rawKey,
					count: Number(item.count) || 0,
					names: Array.isArray(item.names) ? item.names : [],
					infoText: typeof item.infoText === 'string'
						? item.infoText
						: (typeof item.info_text === 'string' ? item.info_text : '')
				};
			};

			if (Array.isArray(payload.locations)) {
				return payload.locations.map(normalizeItem).filter(Boolean);
			}

			return Object.keys(payload)
				.map((key) => {
					const current = payload[key];
					if (!current || typeof current !== 'object') return null;
					if (!Object.prototype.hasOwnProperty.call(current, 'count')) return null;
					if (!Object.prototype.hasOwnProperty.call(current, 'names')) return null;
					return normalizeItem({
						key,
						label: current.label || key,
						count: current.count,
						names: current.names,
						infoText: current.infoText || current.info_text || ''
					});
				})
				.filter(Boolean);
		},

		async fetchStats() {
			try {
				const header = await this.getAuthHeaders();
				if (!header) {
					this._authFail();
					return;
				}
				const res = await uni.request({
					url: `${this.apiBaseUrl}/get-stats`,
					method: 'GET',
					header
				});

				if (res.statusCode === 200 && res.data) {
					const nextStatsList = this.normalizeStatsPayload(res.data);
					this.statsList = nextStatsList;
					if (this.hover && !nextStatsList.some((item) => item.key === this.hover)) {
						this.hover = '';
					}
				} else if (res.statusCode === 403) {
					this._authFail();
				} else {
					console.error('获取统计信息失败:', res);
				}
			} catch (err) {
				console.error('获取统计信息出错:', err);
			}
		},
		formatDate(date) {
			const d = new Date(date);
			const year = d.getFullYear();
			const month = (d.getMonth() + 1).toString().padStart(2, '0');
			const day = d.getDate().toString().padStart(2, '0');
			return `${year}-${month}-${day}`;
		},

		onDateChange(e) {
			this.date = e.detail.value;
			this.formattedDate = this.formatDate(this.date);
		},

		// 页面恢复已有普通用户密钥时，先向后端重新校验再进入仪表盘。
		async revalidateKeyAndStart() {
			const storedKey = this.getStoredUserKey();
			if (!storedKey) {
				this.authInitializing = false;
				this.validateKey();
				return;
			}
			try {
				const res = await uni.request({
					url: `${this.apiBaseUrl}/validate-key`,
					method: 'POST',
					data: { key: storedKey, locat: this.locat, sessionId: this.currentSessionId }
				});
				if (res.statusCode === 200 && res.data) {
					const { role, location } = res.data;
					this.currentKey = storedKey;
					this.currentRole = role || 'user';
					if (location) uni.setStorageSync(this.getUserStorageKey('location'), location);
					this._startHeartbeat(storedKey);
					await this.startDashboard();
				} else {
					const code = res.data && res.data.code;
					let msg = '密钥验证失败，请重新输入';
					if (code === 'KEY_DISABLED') msg = '密钥已被禁用';
					else if (code === 'KEY_FORCED_LOGOUT') msg = '密钥已被管理员强制下线，请重新输入';
					else if (code === 'KEY_NOT_FOUND') msg = '密钥已被删除，请重新输入';
					else if (code === 'KEY_SESSION_EXPIRED') msg = '密钥会话已失效，请重新输入';
					else if (code === 'LOCATION_MISMATCH') msg = '密钥绑定的地点不匹配，请更换正确的地址';
					else if (code === 'LOCAT_NOT_FOUND') msg = this.getResponseMessage(res, '该地址不存在，请联系管理员');
					this.clearStoredUserSession();
					this.currentKey = '';
					this.currentRole = '';
					this.returnToKeyInput(msg, { icon: 'none', duration: 2500, locationForbidden: code === 'LOCATION_MISMATCH' });
				}
			} catch (e) {
				// 网络异常时保留本地状态，直接进入仪表盘
				this.currentKey = storedKey;
				this.currentRole = 'user';
				this._startHeartbeat(storedKey);
				await this.startDashboard();
			} finally {
				this.authInitializing = false;
			}
		},

		// 普通用户心跳用于感知禁用、强制下线、地点不匹配等后端状态变化。
		_startHeartbeat(key) {
			this._stopHeartbeat();
			const sendHeartbeat = async () => {
				try {
					const res = await uni.request({
						url: `${this.apiBaseUrl}/heartbeat`,
						method: 'POST',
						data: { key, sessionId: this.currentSessionId, locat: this.locat }
					});
					const code = res.data && res.data.code;
					if (code === 'KEY_DISABLED' || code === 'KEY_FORCED_LOGOUT' || code === 'KEY_NOT_FOUND' || code === 'KEY_SESSION_EXPIRED' || code === 'LOCATION_MISMATCH' || code === 'LOCAT_NOT_FOUND') {
						const message = code === 'KEY_FORCED_LOGOUT'
							? '密钥已被管理员强制下线，请重新输入'
							: code === 'KEY_NOT_FOUND'
								? '密钥已被删除，请重新输入'
								: code === 'KEY_SESSION_EXPIRED'
									? '密钥会话已失效，请重新输入'
									: code === 'LOCATION_MISMATCH'
										? '密钥绑定的地点不匹配，请更换正确的地址'
										: code === 'LOCAT_NOT_FOUND'
											? this.getResponseMessage(res, '该地点已关闭，请联系管理员')
											: '密钥已被禁用，请重新输入';
						this.returnToKeyInput(
							message,
							{
								clearKey: true,
								icon: 'none',
								duration: 2500,
								locationForbidden: code === 'LOCATION_MISMATCH'
							}
						);
						return;
					}
				} catch (e) { /* 网络异常忽略，下次再试 */ }
			};
			sendHeartbeat();
			this.heartbeatTimer = setInterval(sendHeartbeat, 30 * 1000);
		},

		_stopHeartbeat() {
			if (this.heartbeatTimer) {
				clearInterval(this.heartbeatTimer);
				this.heartbeatTimer = null;
			}
		},

		async validateKey() {
			this.authInitializing = false;
			this.inputKey = '';
			this.keyPromptMessage = '';
			this.keyError = false;
			this.locationForbidden = false;
			this.showPassword = false;
		},
		togglePassword() {
			this.showPassword = !this.showPassword;
		},
		// 认证失败时清掉本地状态，统一退回密钥输入界面。
		_authFail() {
			if (this.adminSessionExpiredHandled) {
				this.adminSessionExpiredHandled = false;
				return;
			}
			this._stopHeartbeat();
			this.clearAdminSession();
			this.currentKey = '';
			this.currentRole = '';
			this.returnToKeyInput('密钥已失效，请重新输入', {
				clearKey: true,
				icon: 'none',
				duration: 2000
			});
		},
		async adminRequest(method, path, data) {
			const header = await this.getAuthHeaders();
			if (!header) {
				this._authFail();
				return null;
			}
			const options = {
				url: `${this.apiBaseUrl}${path}`,
				method,
				header: data === undefined ? header : { ...header, 'Content-Type': 'application/json' }
			};
			if (data !== undefined) {
				options.data = data;
			}
			try {
				const res = await uni.request(options);
				if (res.statusCode === 403) {
					this._authFail();
					return null;
				}
				return res;
			} catch (err) {
				console.error('管理员配置请求失败:', err);
				this.showAppToast({ title: '网络错误，请稍后重试', icon: 'error', duration: 1800 });
				return null;
			}
		},
		// 管理员危险操作统一走确认弹窗，避免在每个操作中重复状态管理。
		confirmAdminAction(content, options = {}) {
			return new Promise((resolve) => {
				this.adminConfirmTitle = options.title || '确认操作';
				this.adminConfirmContent = content;
				this.adminConfirmText = options.confirmText || '确定';
				this.adminConfirmResolver = resolve;
				this.showAdminConfirm = true;
			});
		},
		resolveAdminConfirm(confirmed) {
			const resolver = this.adminConfirmResolver;
			this.showAdminConfirm = false;
			this.adminConfirmTitle = '确认操作';
			this.adminConfirmContent = '';
			this.adminConfirmText = '确定';
			this.adminConfirmResolver = null;
			if (typeof resolver === 'function') {
				resolver(Boolean(confirmed));
			}
		},
		// 管理员配置：地点和普通用户密钥的启停、编辑、新增、删除。
		toggleAdminKeyEditEnabled(item) {
			const draft = this.getAdminKeyEditDraft(item);
			if (!draft) return;
			draft.enabled = Number(draft.enabled) === 1 ? 0 : 1;
		},
		toggleAdminLocatEditEnabled(item) {
			const draft = this.getAdminLocatEditDraft(item);
			if (!draft) return;
			draft.enabled = Number(draft.enabled) === 1 ? 0 : 1;
		},
		toggleAdminLocatEditAudio(item) {
			const draft = this.getAdminLocatEditDraft(item);
			if (!draft) return;
			draft.audio = Number(draft.audio) === 1 ? 0 : 1;
		},
		async toggleAdminLocatEnabled(item) {
			if (!item || !item.id || this.adminManageSubmitting) return;
			if (this.isEditingAdminLocat(item)) {
				this.toggleAdminLocatEditEnabled(item);
				return;
			}
			const nextEnabled = Number(item.enabled) === 1 ? 0 : 1;
			const maxPeople = Number(item.max_people);
			this.adminManageSubmitting = true;
			try {
				const res = await this.adminRequest('PUT', `/admin/locats/${item.id}`, {
					locat_en: item.locat_en || '',
					locat_cn: item.locat_cn || '',
					max_people: Number.isInteger(maxPeople) && maxPeople >= 0 ? maxPeople : 0,
					enabled: nextEnabled,
					audio: Number(item.audio) === 1 ? 1 : 0,
					info_text: item.info_text || ''
				});
				if (!res) return;
				if (res.statusCode === 200) {
					item.enabled = nextEnabled;
					if ((item.locat_en || '').trim() === this.locat) {
						if (nextEnabled === 1) {
							await this.fetchQrCode({ silent: true, allowAdminUnavailable: true });
						} else {
							this.markAdminLocatUnavailable('当前地点已关闭，二维码暂停生成', { silent: true });
						}
					}
					this.showAppToast({ title: nextEnabled === 1 ? '地点已启用' : '地点已关闭', icon: 'success', duration: 1200 });
				} else {
					this.showAppToast({ title: (res.data && res.data.message) || '切换地点状态失败', icon: 'error' });
				}
			} finally {
				this.adminManageSubmitting = false;
			}
		},
		async toggleAdminLocatAudio(item) {
			if (!item || !item.id || this.adminManageSubmitting) return;
			if (this.isEditingAdminLocat(item)) {
				this.toggleAdminLocatEditAudio(item);
				return;
			}
			const nextAudio = Number(item.audio) === 1 ? 0 : 1;
			const maxPeople = Number(item.max_people);
			this.adminManageSubmitting = true;
			try {
				const res = await this.adminRequest('PUT', `/admin/locats/${item.id}`, {
					locat_en: item.locat_en || '',
					locat_cn: item.locat_cn || '',
					max_people: Number.isInteger(maxPeople) && maxPeople >= 0 ? maxPeople : 0,
					enabled: Number(item.enabled) === 1 ? 1 : 0,
					audio: nextAudio,
					info_text: item.info_text || ''
				});
				if (!res) return;
				if (res.statusCode === 200) {
					item.audio = nextAudio;
					this.showAppToast({ title: nextAudio === 1 ? '音频已开启' : '音频已关闭', icon: 'success', duration: 1200 });
				} else {
					this.showAppToast({ title: (res.data && res.data.message) || '切换音频状态失败', icon: 'error' });
				}
			} finally {
				this.adminManageSubmitting = false;
			}
		},
		async toggleAdminKeyEnabled(item) {
			if (!item || !item.id || this.adminManageSubmitting) return;
			if (this.isEditingAdminKey(item)) {
				this.toggleAdminKeyEditEnabled(item);
				return;
			}
			const nextEnabled = Number(item.enabled) === 1 ? 0 : 1;
			const key = typeof item.key === 'string' ? item.key.trim() : '';
			const location = typeof item.location === 'string' ? item.location.trim() : '';
			if (!key || !location) {
				this.showAppToast({ title: '密钥或绑定地点缺失', icon: 'error' });
				return;
			}
			this.adminManageSubmitting = true;
			try {
				const res = await this.adminRequest('PUT', `/admin/user-keys/${item.id}`, {
					key,
					enabled: nextEnabled,
					location
				});
				if (!res) return;
				if (res.statusCode === 200) {
					item.enabled = nextEnabled;
					if (nextEnabled !== 1) item.online = 0;
					this.showAppToast({ title: nextEnabled === 1 ? '密钥已启用' : '密钥已禁用', icon: 'success', duration: 1200 });
				} else {
					this.showAppToast({ title: (res.data && res.data.message) || '切换密钥状态失败', icon: 'error' });
				}
			} finally {
				this.adminManageSubmitting = false;
			}
		},
		getAdminKeyDisplay(item) {
			const key = item && item.key ? String(item.key) : '';
			if (!key) return '-';
			return item.showKey ? key : '*****';
		},
		toggleAdminKeyVisible(item) {
			if (!item || !item.key) return;
			const itemId = item.__isNew ? '__new__' : item.id;
			const now = Date.now();
			if (this.lastAdminKeyVisibleToggleId === itemId && now - this.lastAdminKeyVisibleToggleAt < 250) return;
			this.lastAdminKeyVisibleToggleId = itemId;
			this.lastAdminKeyVisibleToggleAt = now;
			item.showKey = !item.showKey;
		},
		getAdminEnabledLocats() {
			return (Array.isArray(this.adminLocats) ? this.adminLocats : [])
				.filter((item) => item && Number(item.enabled) === 1 && item.locat_en);
		},
		getAdminKeyEditLocationLabel(item) {
			const draft = this.getAdminKeyEditDraft(item);
			const label = this.formatAdminLocatLabel(draft && draft.location);
			return label === '-' ? '请选择' : label;
		},
		getAdminKeyLocationDraftLabel() {
			const label = this.formatAdminLocatLabel(this.adminKeyLocationDraft);
			return label === '-' ? '请选择地点' : label;
		},
		openAdminKeyLocationModal(item) {
			if (this.adminManageSubmitting) return;
			if (!this.isEditingAdminKey(item)) return;
			const draft = this.getAdminKeyEditDraft(item);
			if (!draft) return;
			this.adminKeyLocationEditingRowKey = this.getAdminKeyEditRowKey(item);
			this.adminKeyLocationDraft = normalizeLocationBinding(draft.location);
			this.lastAdminKeyLocationSelectAt = 0;
			this.lastAdminKeyLocationSelectValue = '';
			this.showAdminKeyLocationModal = true;
		},
		closeAdminKeyLocationModal() {
			this.showAdminKeyLocationModal = false;
			this.adminKeyLocationEditingRowKey = '';
			this.lastAdminKeyLocationSelectAt = 0;
			this.lastAdminKeyLocationSelectValue = '';
		},
		selectAdminKeyLocationDraft(location) {
			const value = typeof location === 'string' ? location.trim() : '';
			if (!value) return;
			const now = Date.now();
			if (this.lastAdminKeyLocationSelectValue === value && now - this.lastAdminKeyLocationSelectAt < 250) return;
			this.lastAdminKeyLocationSelectAt = now;
			this.lastAdminKeyLocationSelectValue = value;
			if (value === '*') {
				this.adminKeyLocationDraft = '*';
				return;
			}
			const parsed = parseLocationBinding(this.adminKeyLocationDraft);
			const current = parsed.wildcard ? [] : parsed.locations.slice();
			const exists = current.includes(value);
			const next = exists ? current.filter((item) => item !== value) : current.concat(value);
			this.adminKeyLocationDraft = normalizeLocationBinding(next.join(','));
		},
		isAdminKeyLocationDraftSelected(location) {
			const value = typeof location === 'string' ? location.trim() : '';
			if (!value) return false;
			const parsed = parseLocationBinding(this.adminKeyLocationDraft);
			return parsed.wildcard ? value === '*' : parsed.locations.includes(value);
		},
		confirmAdminKeyLocationModal() {
			const location = normalizeLocationBinding(this.adminKeyLocationDraft);
			if (!location) {
				this.showAppToast({ title: '请选择绑定地点', icon: 'none' });
				return;
			}
			const item = this.adminUserKeys.find((row) => this.getAdminKeyEditRowKey(row) === this.adminKeyLocationEditingRowKey);
			const draft = this.getAdminKeyEditDraft(item);
			if (draft) draft.location = location;
			this.closeAdminKeyLocationModal();
		},
		async openAdminManageModal() {
			if (this.currentRole !== 'admin') return;
			this.hideNames();
			this.closeDateModal();
			this.closeRankingModal();
			this.closeRecordsModal();
			this.resetAdminLocatEditDraft();
			this.resetAdminKeyEditDraft();
			this.showAdminManageModal = true;
			await this.loadAdminManageData();
		},
		closeAdminManageModal() {
			if (this.adminManageSubmitting || this.showAdminConfirm) return;
			this.closeAdminKeyLocationModal();
			this.resetAdminLocatEditDraft();
			this.resetAdminKeyEditDraft();
			this.showAdminManageModal = false;
		},
		async loadAdminManageData() {
			if (this.currentRole !== 'admin') return;
			this.adminManageLoading = true;
			try {
				this.resetAdminLocatEditDraft();
				this.resetAdminKeyEditDraft();
				await Promise.all([
					this.loadAdminLocats(),
					this.loadAdminUserKeys()
				]);
			} finally {
				this.adminManageLoading = false;
			}
		},
		async loadAdminLocats() {
			const res = await this.adminRequest('GET', '/admin/locats');
			if (!res) return false;
			if (res.statusCode === 200 && res.data) {
				const rows = Array.isArray(res.data.list) ? res.data.list : [];
				this.adminLocats = rows.map((item) => ({
					id: Number(item.id) || null,
					locat_en: item.locat_en || '',
					locat_cn: item.locat_cn || '',
					max_people: Number(item.max_people) || 0,
					enabled: Number(item.enabled) === 0 ? 0 : 1,
					audio: Number(item.audio) === 0 ? 0 : 1,
					info_text: item.info_text || '',
					isEditing: false,
					editFocus: '',
					editDraft: null
				}));
				return true;
			}
			this.showAppToast({ title: (res.data && res.data.message) || '获取地点配置失败', icon: 'error' });
			return false;
		},
		async loadAdminUserKeys() {
			const res = await this.adminRequest('GET', '/admin/user-keys');
			if (!res) return false;
			if (res.statusCode === 200 && res.data) {
				const rows = Array.isArray(res.data.list) ? res.data.list : [];
				this.adminUserKeys = rows.map((item) => ({
					id: Number(item.id) || null,
					key: item.key || '',
					enabled: Number(item.enabled) === 1 ? 1 : 0,
					online: Number(item.online) === 1 ? 1 : 0,
					location: item.location || '',
					location_cn: item.location_cn || '',
					forced_logout_at: item.forced_logout_at || '',
					last_login_at: item.last_login_at || '',
					updated_at: item.updated_at || '',
					showKey: false,
					isEditing: false,
					editFocus: '',
					editDraft: null
				}));
				return true;
			}
			this.showAppToast({ title: (res.data && res.data.message) || '获取普通密钥失败', icon: 'error' });
			return false;
		},
		getAdminLocatRowKey(item, index) {
			if (item && item.__isNew) return 'locat-admin-' + (item.clientId || 'new');
			return 'locat-admin-' + ((item && item.id) || index);
		},
		getAdminKeyRowKey(item, index) {
			if (item && item.__isNew) return 'user-key-admin-new';
			return 'user-key-admin-' + ((item && item.id) || index);
		},
		isEditingAdminLocat(item) {
			return Boolean(item && item.isEditing && item.editDraft);
		},
		getAdminLocatEditDraft(item) {
			return item && item.editDraft ? item.editDraft : null;
		},
		isAdminLocatEditFocused(item, field) {
			return Boolean(item && item.editFocus === field);
		},
		createAdminLocatEditDraft(item) {
			return {
				id: item.__isNew ? null : (item.id || null),
				locat_en: item.locat_en || '',
				locat_cn: item.locat_cn || '',
				max_people: item.max_people === null || item.max_people === undefined ? '' : String(item.max_people),
				enabled: Number(item.enabled) === 0 ? 0 : 1,
				audio: Number(item.audio) === 0 ? 0 : 1,
				info_text: item.info_text || '',
				isNew: Boolean(item.__isNew)
			};
		},
		hasUnsavedAdminLocatNewRow() {
			return this.adminLocats.some((item) => item && item.__isNew);
		},
		applySavedAdminLocat(item, payload) {
			if (!item || !payload) return;
			const oldLocatEn = item.locat_en || '';
			const nextLocatEn = payload.locat_en || '';
			item.id = Number(payload.id) || item.id;
			item.locat_en = nextLocatEn;
			item.locat_cn = payload.locat_cn || '';
			item.max_people = Number(payload.max_people) || 0;
			item.enabled = Number(payload.enabled) === 1 ? 1 : 0;
			item.audio = Number(payload.audio) === 1 ? 1 : 0;
			item.info_text = payload.info_text || '';
			item.__isNew = false;
			item.clientId = '';
			item.isEditing = false;
			item.editFocus = '';
			item.editDraft = null;
			this.adminUserKeys.forEach((keyItem) => {
				if (!keyItem) return;
				const nextKeyLocation = replaceLocationBindingValue(keyItem.location, oldLocatEn, nextLocatEn);
				if (nextKeyLocation !== normalizeLocationBinding(keyItem.location)) {
					keyItem.location = nextKeyLocation;
					keyItem.location_cn = '';
				}
				if (keyItem.editDraft) {
					const nextDraftLocation = replaceLocationBindingValue(keyItem.editDraft.location, oldLocatEn, nextLocatEn);
					if (nextDraftLocation !== normalizeLocationBinding(keyItem.editDraft.location)) {
						keyItem.editDraft.location = nextDraftLocation;
					}
				}
			});
		},
		resetAdminLocatEditDraft() {
			this.adminLocats.forEach((item) => {
				if (item) {
					item.isEditing = false;
					item.editFocus = '';
					item.editDraft = null;
				}
			});
			this.adminLocats = this.adminLocats.filter((row) => !row.__isNew);
		},
		editAdminLocat(item, focusField = '') {
			if (!item || this.adminManageSubmitting) return;
			this.adminManageTab = 'locats';
			if (!item.editDraft) item.editDraft = this.createAdminLocatEditDraft(item);
			item.isEditing = true;
			this.adminLocats.forEach((row) => {
				if (row && row !== item) row.editFocus = '';
			});
			item.editFocus = focusField || 'locat_en';
		},
		addAdminLocatRow() {
			if (this.adminManageSubmitting) return;
			if (this.hasUnsavedAdminLocatNewRow()) {
				this.showAppToast({ title: '请先保存或取消新增地点', icon: 'none' });
				return;
			}
			const newRow = {
				id: null,
				clientId: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				locat_en: '',
				locat_cn: '',
				max_people: 0,
				enabled: 1,
				audio: 0,
				info_text: '',
				isEditing: false,
				editFocus: '',
				editDraft: null,
				__isNew: true
			};
			newRow.editDraft = this.createAdminLocatEditDraft(newRow);
			newRow.isEditing = true;
			newRow.editFocus = 'locat_en';
			this.adminLocats.push(newRow);
		},
		cancelAdminLocatEdit(item) {
			if (this.adminManageSubmitting) return;
			if (!item) return;
			if (item.__isNew) {
				this.adminLocats = this.adminLocats.filter((row) => row !== item);
			} else {
				item.isEditing = false;
				item.editFocus = '';
				item.editDraft = null;
			}
		},
		async saveAdminLocat(item) {
			if (this.adminManageSubmitting) return;
			if (!item || !this.isEditingAdminLocat(item)) return;
			const draft = this.getAdminLocatEditDraft(item);
			if (!draft) return;
			const locatEn = (draft.locat_en || '').trim();
			const locatCn = (draft.locat_cn || '').trim();
			const maxPeopleText = draft.max_people === null || draft.max_people === undefined
				? ''
				: String(draft.max_people).trim();
			const maxPeople = Number(maxPeopleText);
			const enabled = Number(draft.enabled) === 1 ? 1 : 0;
			const audio = Number(draft.audio) === 1 ? 1 : 0;
			if (!locatEn) {
				this.showAppToast({ title: '英文编码不能为空', icon: 'error' });
				return;
			}
			if (locatEn === '*' || locatEn.includes(',')) {
				this.showAppToast({ title: '英文编码不能使用 * 或英文逗号', icon: 'error' });
				return;
			}
			if (!locatCn) {
				this.showAppToast({ title: '中文编码不能为空', icon: 'error' });
				return;
			}
			if (!maxPeopleText) {
				this.showAppToast({ title: '人数上限不能为空', icon: 'error' });
				return;
			}
			if (!Number.isInteger(maxPeople) || maxPeople < 0) {
				this.showAppToast({ title: '人数上限必须是非负整数', icon: 'error' });
				return;
			}
			this.adminManageSubmitting = true;
			try {
				const isEdit = Boolean(draft.id);
				const previousLocatEn = item.locat_en || '';
				const res = await this.adminRequest(
					isEdit ? 'PUT' : 'POST',
					isEdit ? `/admin/locats/${draft.id}` : '/admin/locats',
					{
						locat_en: locatEn,
						locat_cn: locatCn,
						max_people: maxPeople,
						enabled,
						audio,
						info_text: draft.info_text || ''
					}
				);
				if (!res) return;
				if (res.statusCode === 200) {
					this.showAppToast({ title: isEdit ? '地点已保存' : '地点已新增', icon: 'success' });
					const savedId = isEdit ? draft.id : Number(res.data && res.data.id);
					if (!isEdit && !savedId) {
						await this.loadAdminLocats();
						return;
					}
					this.applySavedAdminLocat(item, {
						id: savedId,
						locat_en: locatEn,
						locat_cn: locatCn,
						max_people: maxPeople,
						enabled,
						audio,
						info_text: draft.info_text || ''
					});
					if (locatEn === this.locat || previousLocatEn === this.locat) {
						if (enabled === 1) {
							await this.fetchQrCode({ silent: true, allowAdminUnavailable: true });
						} else {
							this.markAdminLocatUnavailable('当前地点已关闭，二维码暂停生成', { silent: true });
						}
					}
				} else {
					this.showAppToast({ title: (res.data && res.data.message) || '保存地点失败', icon: 'error' });
				}
			} finally {
				this.adminManageSubmitting = false;
			}
		},
		async deleteAdminLocat(item) {
			if (!item || !item.id || this.adminManageSubmitting) return;
			if (this.isEditingAdminLocat(item)) {
				this.showAppToast({ title: '请先保存或取消该地点编辑', icon: 'none' });
				return;
			}
			const confirmed = await this.confirmAdminAction(`确定删除地点“${item.locat_cn || item.locat_en}”？`, {
				confirmText: '确认删除'
			});
			if (!confirmed) return;
			this.adminManageSubmitting = true;
			try {
				const res = await this.adminRequest('DELETE', `/admin/locats/${item.id}`);
				if (!res) return;
				if (res.statusCode === 200) {
					this.showAppToast({ title: '地点已删除', icon: 'success' });
					this.adminLocats = this.adminLocats.filter((row) => row !== item);
				} else {
					this.showAppToast({ title: (res.data && res.data.message) || '删除地点失败', icon: 'error' });
				}
			} finally {
				this.adminManageSubmitting = false;
			}
		},
		isEditingAdminKey(item) {
			return Boolean(item && item.isEditing && item.editDraft);
		},
		resetAdminKeyEditDraft() {
			this.adminUserKeys.forEach((item) => {
				if (item) {
					item.isEditing = false;
					item.editFocus = '';
					item.editDraft = null;
				}
			});
			this.adminUserKeys = this.adminUserKeys.filter((row) => !row.__isNew);
			this.closeAdminKeyLocationModal();
		},
		editAdminKey(item, focusField = '') {
			if (!item || this.adminManageSubmitting) return;
			this.adminManageTab = 'keys';
			if (!item.editDraft) {
				item.editDraft = {
					id: item.__isNew ? null : (item.id || null),
					key: item.key || '',
					enabled: Number(item.enabled) === 1 ? 1 : 0,
					location: item.location || '',
					isNew: Boolean(item.__isNew)
				};
			}
			item.isEditing = true;
			this.adminUserKeys.forEach((row) => {
				if (row && row !== item) row.editFocus = '';
			});
			item.editFocus = focusField || 'key';
			if (focusField === 'location') this.openAdminKeyLocationModal(item);
		},
		getAdminKeyEditRowKey(item) {
			if (!item) return '';
			if (item.__isNew) return item.clientId || '__new__';
			return item.id ? `id:${item.id}` : '';
		},
		getAdminKeyEditDraft(item) {
			return item && item.editDraft ? item.editDraft : null;
		},
		isAdminKeyEditFocused(item, field) {
			return Boolean(item && item.editFocus === field);
		},
		createAdminKeyEditDraft(item) {
			return {
				id: item.__isNew ? null : (item.id || null),
				key: item.key || '',
				enabled: Number(item.enabled) === 1 ? 1 : 0,
				location: item.location || '',
				isNew: Boolean(item.__isNew)
			};
		},
		hasUnsavedAdminKeyNewRow() {
			return this.adminUserKeys.some((item) => item && item.__isNew);
		},
		applySavedAdminKey(item, payload) {
			if (!item || !payload) return;
			const rowKey = this.getAdminKeyEditRowKey(item);
			const savedLocation = normalizeLocationBinding(payload.location);
			const keyChanged = item.key !== (payload.key || '');
			const locationChanged = normalizeLocationBinding(item.location) !== savedLocation;
			item.id = Number(payload.id) || item.id;
			item.key = payload.key || '';
			item.enabled = Number(payload.enabled) === 1 ? 1 : 0;
			item.location = savedLocation;
			item.location_cn = '';
			if (item.enabled !== 1 || keyChanged || locationChanged) item.online = 0;
			item.__isNew = false;
			item.clientId = '';
			item.isEditing = false;
			item.editFocus = '';
			item.editDraft = null;
			if (this.adminKeyLocationEditingRowKey === rowKey) {
				this.closeAdminKeyLocationModal();
			}
		},
		handleAdminKeyRowPress(item) {
			if (this.isEditingAdminKey(item)) return;
			this.editAdminKey(item, 'key');
		},
		cancelAdminKeyEdit(item) {
			if (this.adminManageSubmitting) return;
			if (!item) return;
			if (item.__isNew) {
				this.adminUserKeys = this.adminUserKeys.filter((row) => row !== item);
			} else {
				item.isEditing = false;
				item.editFocus = '';
				item.editDraft = null;
			}
			if (this.adminKeyLocationEditingRowKey === this.getAdminKeyEditRowKey(item)) {
				this.closeAdminKeyLocationModal();
			}
		},
		addAdminKeyRow() {
			if (this.adminManageSubmitting) return;
			if (this.hasUnsavedAdminKeyNewRow()) {
				this.showAppToast({ title: '请先保存或取消新增密钥', icon: 'none' });
				return;
			}
			const newRow = {
				id: null,
				clientId: `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				key: '',
				enabled: 1,
				online: 0,
				location: '',
				location_cn: '',
				forced_logout_at: '',
				last_login_at: '',
				updated_at: '',
				showKey: false,
				isEditing: false,
				editFocus: '',
				editDraft: null,
				__isNew: true
			};
			newRow.editDraft = this.createAdminKeyEditDraft(newRow);
			newRow.isEditing = true;
			newRow.editFocus = 'key';
			this.adminUserKeys.push(newRow);
		},
		async saveAdminKeyEdit(item) {
			if (this.adminManageSubmitting) return;
			if (!item || !this.isEditingAdminKey(item)) return;
			const draft = this.getAdminKeyEditDraft(item);
			if (!draft) return;
			const key = (draft.key || '').trim();
			const location = normalizeLocationBinding(draft.location);
			const enabled = Number(draft.enabled) === 1 ? 1 : 0;
			if (!key) {
				this.showAppToast({ title: '密钥不能为空', icon: 'error' });
				return;
			}
			if (!location) {
				this.showAppToast({ title: '请选择绑定地点', icon: 'error' });
				return;
			}
			this.adminManageSubmitting = true;
			try {
				const isEdit = Boolean(draft.id);
				const res = await this.adminRequest(
					isEdit ? 'PUT' : 'POST',
					isEdit ? `/admin/user-keys/${draft.id}` : '/admin/user-keys',
					{ key, enabled, location }
				);
				if (!res) return;
				if (res.statusCode === 200) {
					this.showAppToast({ title: isEdit ? '密钥已保存' : '密钥已新增', icon: 'success' });
					const savedId = isEdit ? draft.id : Number(res.data && res.data.id);
					if (!isEdit && !savedId) {
						await this.loadAdminUserKeys();
						return;
					}
					this.applySavedAdminKey(item, {
						id: savedId,
						key,
						enabled,
						location
					});
				} else {
					this.showAppToast({ title: (res.data && res.data.message) || '保存密钥失败', icon: 'error' });
				}
			} finally {
				this.adminManageSubmitting = false;
			}
		},
		async deleteAdminKey(item) {
			if (!item || !item.id || this.adminManageSubmitting) return;
			if (this.isEditingAdminKey(item)) {
				this.showAppToast({ title: '请先保存或取消该密钥编辑', icon: 'none' });
				return;
			}
			const confirmed = await this.confirmAdminAction(`确定删除普通密钥“${item.key || item.id}”？`, {
				confirmText: '确认删除'
			});
			if (!confirmed) return;
			this.adminManageSubmitting = true;
			try {
				const res = await this.adminRequest('DELETE', `/admin/user-keys/${item.id}`);
				if (!res) return;
				if (res.statusCode === 200) {
					this.showAppToast({ title: '密钥已删除', icon: 'success' });
					this.adminUserKeys = this.adminUserKeys.filter((row) => row !== item);
				} else {
					this.showAppToast({ title: (res.data && res.data.message) || '删除密钥失败', icon: 'error' });
				}
			} finally {
				this.adminManageSubmitting = false;
			}
		},
		async forceLogoutAdminKey(item) {
			if (!item || !item.id || this.adminManageSubmitting) return;
			if (this.isEditingAdminKey(item)) {
				this.showAppToast({ title: '请先保存或取消该密钥编辑', icon: 'none' });
				return;
			}
			const confirmed = await this.confirmAdminAction(`确定强制下线普通密钥“${item.key || item.id}”？`, {
				confirmText: '强制下线'
			});
			if (!confirmed) return;
			this.adminManageSubmitting = true;
			try {
				const res = await this.adminRequest('POST', `/admin/user-keys/${item.id}/force-logout`, {});
				if (!res) return;
				if (res.statusCode === 200) {
					this.showAppToast({ title: '已强制下线', icon: 'success' });
					item.online = 0;
				} else {
					this.showAppToast({ title: (res.data && res.data.message) || '强制下线失败', icon: 'error' });
				}
			} finally {
				this.adminManageSubmitting = false;
			}
		},
		formatAdminLocatLabel(location) {
			const parsed = parseLocationBinding(location);
			if (!parsed.normalized) return '-';
			if (parsed.wildcard) return '全部地点';
			const labels = parsed.locations.map((value) => {
				const loc = this.adminLocats.find((item) => item.locat_en === value);
				return loc ? (loc.locat_cn || loc.locat_en) : value;
			});
			return labels.length > 0 ? labels.join('、') : '-';
		},
			// 密钥登录入口：根据后端返回角色写入不同存储，并启动对应会话维护。
			async confirmKey() {
				const content = this.inputKey.trim();
				if (!content) {
					this.keyPromptMessage = '请输入密钥';
					this.keyError = true;
					this.locationForbidden = false;
					return;
				}
				this.keyError = false;
				this.locationForbidden = false;
				this.keyPromptMessage = '';
				this.adminSessionExpiredHandled = false;
				try {
					const res = await uni.request({
						url: `${this.apiBaseUrl}/validate-key`,
						method: 'POST',
						data: { key: content, locat: this.locat, relogin: true, sessionId: this.currentSessionId }
					});
					if (res.statusCode === 200 && res.data) {
						const { role, location, loginAt } = res.data;
						this.currentRole = role;
						this.currentKey = content;
						if (role === 'admin') {
							// 管理员：存入 sessionStorage，120 分钟后自动超时
							if (typeof sessionStorage !== 'undefined') {
								sessionStorage.setItem('admin_key', content);
								sessionStorage.setItem('admin_location', location || '');
								sessionStorage.setItem('admin_login_at', String(Date.now()));
							}
							this._startAdminSessionTimer();
						} else {
							this._stopAdminSessionTimer();
							this.clearAdminSession();
							// 普通用户：存入 localStorage（持久），同时写 loginAt 和 location
							this.setStoredUserSession(content, location || '', loginAt || '');
							// 启动普通用户心跳
							this._startHeartbeat(content);
						}
						this.keyError = false;
						const started = await this.startDashboard();
						if (started) {
							this.showAppToast({ title: '验证成功', icon: 'success' });
						}
					} else {
						const code = res.data && res.data.code;
						let msg = '验证失败，请重新输入';
						if (code === 'KEY_DISABLED') msg = '密钥已被禁用';
						else if (code === 'KEY_FORCED_LOGOUT') msg = '密钥已被管理员强制下线，请重新输入';
						else if (code === 'KEY_NOT_FOUND') msg = '密钥已被删除，请重新输入';
						else if (code === 'KEY_SESSION_EXPIRED') msg = '密钥会话已失效，请重新输入';
						else if (code === 'ADMIN_KEY_DISABLED') msg = '管理员密钥已被禁用';
						else if (code === 'LOCATION_MISMATCH') msg = '密钥绑定的地点不匹配，请更换正确的地址';
						else if (code === 'LOCAT_NOT_FOUND') msg = this.getResponseMessage(res, '该地址不存在，请联系管理员');
						this.locationForbidden = code === 'LOCATION_MISMATCH';
						this.keyError = !this.locationForbidden;
						this.keyPromptMessage = msg;
						this.inputKey = '';
					}
				} catch (err) {
					console.error('验证 key 时出错:', err);
					this.keyPromptMessage = '服务器错误，请稍后重试';
					this.keyError = true;
					this.locationForbidden = false;
				}
			},
		// 二维码获取会处理地点不存在、地点关闭、认证失效和网络时间同步。
		async fetchQrCode(options = {}) {
			const silent = Boolean(options && options.silent);
			const allowAdminUnavailable = this.currentRole === 'admin' && Boolean(options && options.allowAdminUnavailable);
			try {
				if (!this.locat) {
					if (this.currentRole === 'admin') {
						this.markAdminLocatUnavailable('缺少地点参数，二维码暂停生成', { silent });
						return allowAdminUnavailable;
					}
					this.handleLocatInvalid('缺少地点参数');
					return false;
				}
				const header = await this.getAuthHeaders();
				if (!header) {
					this._authFail();
					return false;
				}
				const query = [`locat=${encodeURIComponent(this.locat)}`];
				if (options && options.forceRefresh) query.push('forceRefresh=1');
				const res = await uni.request({
					url: `${this.apiBaseUrl}/generate-qr?${query.join('&')}`,
					method: 'GET',
					header
				});
				if (res.statusCode === 200) {
					this.adminLocatUnavailable = false;
					this.adminLocatUnavailableMessage = '';
					this.qrCode = res.data.qrCode;
					this.token = res.data.token;
					this.applyNetworkTime(res.data.serverTime);
					this.syncManualQrCooldown(res.data.cooldownRemaining);
					this.scheduleQrRefresh(res.data.tokenRemainingSeconds);
					return true;
				} else if (
					(res.statusCode === 400 || res.statusCode === 404) &&
					res.data &&
					(res.data.code === 'LOCAT_REQUIRED' || res.data.code === 'LOCAT_NOT_FOUND')
				) {
					const serverMessage = typeof res.data.message === 'string' && res.data.message.trim()
						? res.data.message.trim()
						: '该地址不存在，请联系管理员';
					if (this.currentRole === 'admin') {
						this.markAdminLocatUnavailable(serverMessage, { silent });
						return allowAdminUnavailable;
					}
					this.handleLocatInvalid(serverMessage);
					return false;
				} else if (res.statusCode === 403) {
					if (res.data && res.data.code === 'LOCATION_FORBIDDEN') {
						const serverMessage = typeof res.data.message === 'string' && res.data.message.trim()
							? res.data.message.trim()
							: '密钥绑定的地点不匹配，请更换正确的地址';
						this._stopHeartbeat();
						if (this.currentRole === 'admin') this.clearAdminSession();
						this.currentRole = '';
						this.returnToKeyInput(serverMessage, { icon: 'none', duration: 3000, locationForbidden: true });
						return false;
					}
					this._authFail();
					return false;
				} else {
					if (!silent) {
						this.showAppToast({ title: '获取二维码失败，请稍后重试', icon: 'none', duration: 3000 });
					}
					return false;
				}
			} catch (err) {
				console.error('获取二维码失败', err);
				if (!silent) {
					this.showAppToast({ title: '网络错误，请稍后重试', icon: 'error', duration: 3000 });
				}
				return false;
			}
		},
		// 网络时间以服务端时间为基准，本地每秒递增显示。
		applyNetworkTime(payload) {
			const baseMs = parseNetworkTimePayload(payload);
			if (!Number.isFinite(baseMs)) return;
			this.networkTimeBaseMs = baseMs;
			this.networkTimeBaseLocalMs = Date.now();
			this.networkTimeSyncedAt = typeof payload.iso === 'string' ? payload.iso : (payload.nowIso || '');
			this.updateNetworkTimeDisplay();
			this.startNetworkTimeTicker();
		},
		updateNetworkTimeDisplay() {
			if (!Number.isFinite(this.networkTimeBaseMs) || !this.networkTimeBaseLocalMs) return;
			const elapsedMs = Date.now() - this.networkTimeBaseLocalMs;
			this.networkTimeDisplay = formatUtc8DateTimeFromMs(this.networkTimeBaseMs + elapsedMs);
		},
		startNetworkTimeTicker() {
			this.stopNetworkTimeTicker();
			this.networkTimeTickTimer = setInterval(() => {
				this.updateNetworkTimeDisplay();
			}, 1000);
		},
		stopNetworkTimeTicker() {
			if (this.networkTimeTickTimer) {
				clearInterval(this.networkTimeTickTimer);
				this.networkTimeTickTimer = null;
			}
		},
		async fetchNetworkTime(options = {}) {
			if (this.networkTimeLoading) return false;
			this.networkTimeLoading = true;
			const silent = Boolean(options && options.silent);
			try {
				const header = await this.getAuthHeaders();
				if (!header) {
					this._authFail();
					return false;
				}
				const res = await uni.request({
					url: `${this.apiBaseUrl}/network-time`,
					method: 'GET',
					header
				});
				if (!this.isKeyValid) return false;
				if (res.statusCode === 200) {
					this.applyNetworkTime(res.data);
					return true;
				}
				if (res.statusCode === 403) {
					this._authFail();
					return false;
				}
				if (!silent) {
					this.showAppToast({ title: '网络时间同步失败', icon: 'none', duration: 1800 });
				}
				return false;
			} catch (err) {
				console.error('同步网络时间失败', err);
				if (!silent) {
					this.showAppToast({ title: '网络时间同步失败', icon: 'none', duration: 1800 });
				}
				return false;
			} finally {
				this.networkTimeLoading = false;
			}
		},
		// 手动刷新二维码的冷却展示，防止用户连续点击造成无效请求。
		clearManualQrCooldown() {
			if (this.manualQrCooldownTimer) {
				clearInterval(this.manualQrCooldownTimer);
				this.manualQrCooldownTimer = null;
			}
			this.manualQrCooldownRemaining = 0;
		},
		startManualQrCooldown() {
			this.clearManualQrCooldown();
			const updateRemaining = () => {
				const elapsed = Date.now() - (Number(this.lastManualQrRefreshAt) || 0);
				const remaining = Math.max(0, Math.ceil((MANUAL_QR_REFRESH_COOLDOWN_MS - elapsed) / 1000));
				this.manualQrCooldownRemaining = remaining;
				if (remaining <= 0) {
					this.clearManualQrCooldown();
				}
			};
			updateRemaining();
			if (this.manualQrCooldownRemaining > 0) {
				this.manualQrCooldownTimer = setInterval(updateRemaining, 1000);
			}
		},
		syncManualQrCooldown(remainingSeconds) {
			const remaining = Number(remainingSeconds);
			if (!Number.isFinite(remaining) || remaining <= 0) return;
			const elapsedMs = Math.max(0, MANUAL_QR_REFRESH_COOLDOWN_MS - remaining * 1000);
			this.lastManualQrRefreshAt = Date.now() - elapsedMs;
			this.startManualQrCooldown();
		},
		async handleManualQrRefresh() {
			if (!this.isKeyValid || this.qrRefreshing) return;
			if (this.adminLocatUnavailable) {
				this.showAppToast({ title: this.adminLocatUnavailableMessage || '当前地点已关闭，无法刷新二维码', icon: 'none', duration: 1800 });
				return;
			}
			const now = Date.now();
			const elapsed = now - (Number(this.lastManualQrRefreshAt) || 0);
			if (elapsed > 0 && elapsed < MANUAL_QR_REFRESH_COOLDOWN_MS) {
				this.startManualQrCooldown();
				return;
			}
			this.lastManualQrRefreshAt = now;
			this.startManualQrCooldown();
			this.qrRefreshing = true;
			const ok = await this.fetchQrCode({ silent: true, forceRefresh: true });
			this.qrRefreshing = false;
			if (ok) {
				this.showAppToast({ title: '二维码已刷新', icon: 'success', duration: 1200 });
			} else if (this.isKeyValid) {
				this.showAppToast({
					title: this.adminLocatUnavailable ? (this.adminLocatUnavailableMessage || '当前地点已关闭，无法刷新二维码') : '刷新失败，请稍后重试',
					icon: this.adminLocatUnavailable ? 'none' : 'error',
					duration: 1500
				});
			}
		},

		// 导出 Excel：支持按范围导出和全部导出，下载逻辑集中在 doExport。
		async onButtonClick(buttonType) {
			const header = await this.getAuthHeaders();
			if (!header) {
				this._authFail();
				return;
			}
			const doExport = (url, filename) => {
				uni.request({
					url,
					method: 'GET',
					header,
					responseType: 'arraybuffer',
					success: (res) => {
						if (res.statusCode === 200) {
							const blob = new Blob([res.data], {
								type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
							});
							const link = document.createElement('a');
							const urlObj = window.URL.createObjectURL(blob);
							link.href = urlObj;
							link.download = filename;
							document.body.appendChild(link);
							link.click();
							document.body.removeChild(link);
							window.URL.revokeObjectURL(urlObj);
						} else if (res.statusCode === 403) {
							this._authFail();
						} else if (res.statusCode === 404) {
							this.showAppToast({ title: '数据不存在', icon: 'error', duration: 3000 });
						} else {
							this.showAppToast({ title: '请求失败，请稍后重试', icon: 'error', duration: 3000 });
						}
					},
					fail: (err) => {
						console.error('请求失败:', err);
						this.showAppToast({ title: '网络错误，请稍后重试', icon: 'error' });
					}
				});
			};
			if (buttonType === 'button1') {
				if (this.formattedDate) {
					doExport(
						`${this.apiBaseUrl}/export-excel?date=${encodeURIComponent(this.formattedDate)}`,
						`签到表_${this.formattedDate}.xlsx`
					);
				} else {
					this.showAppToast({ title: '请先选择日期', icon: 'error' });
				}
			} else if (buttonType === 'button2') {
				doExport(this.apiBaseUrl + '/export-excel', '签到表_all.xlsx');
			} else if (buttonType === 'button3') {
				if (this.formattedStartDate && this.formattedEndDate) {
					doExport(
						`${this.apiBaseUrl}/export-excel-range?start=${encodeURIComponent(this.formattedStartDate)}&end=${encodeURIComponent(this.formattedEndDate)}`,
						`签到表_${this.formattedStartDate}_到_${this.formattedEndDate}.xlsx`
					);
				} else {
					this.showAppToast({ title: '请选择开始和结束日期', icon: 'error' });
				}
			}
		}
	}
};
