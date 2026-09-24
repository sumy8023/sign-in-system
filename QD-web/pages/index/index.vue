<template>
	<view class="container" @click="onContainerClick" @tap="onContainerClick">
		<view v-if="isKeyValid" class="dashboard">
			<view class="header-card">
				<view class="header-text">
						<text class="title-main">签到打卡系统</text>
					<text class="title-sub">二维码每 5 分钟自动刷新，统计每 1 分钟同步一次</text>
				</view>

				<view class="range-export" @click.stop @tap.stop>
					<view
						class="date-picker date-picker-start"
						:class="{ 'date-picker-active': showDateModal && activeDatePicker === 'start' }"
						@click.stop="openDateModal('start')"
						@tap.stop="openDateModal('start')"
					>
						<view class="date-shell">
							<text class="date-chip date-chip-start">开始</text>
							<text class="date-text" :class="{ 'date-text-placeholder': !formattedStartDate }">
								{{ formattedStartDate || '请选择日期' }}
							</text>
							<text class="date-arrow">▾</text>
						</view>
					</view>
					<view
						class="date-picker date-picker-end"
						:class="{ 'date-picker-active': showDateModal && activeDatePicker === 'end' }"
						@click.stop="openDateModal('end')"
						@tap.stop="openDateModal('end')"
					>
						<view class="date-shell">
							<text class="date-chip date-chip-end">结束</text>
							<text class="date-text" :class="{ 'date-text-placeholder': !formattedEndDate }">
								{{ formattedEndDate || '请选择日期' }}
							</text>
							<text class="date-arrow">▾</text>
						</view>
					</view>
					<button @click="onButtonClick('button3')" class="action-button">按范围导出</button>
					<button @click="onButtonClick('button2')" class="action-button action-button-danger">全部导出</button>
					<button @click="openRankingModal" class="action-button action-button-rank">时长排行榜</button>
					<button @click="openRecordsModal" class="action-button action-button-record">签到详情</button>
				</view>
			</view>

			<view class="content-grid">
				<view class="qr-panel">
					<text v-if="currentRole === 'admin'" class="admin-badge" @click.stop="openAdminManageModal" @tap.stop="openAdminManageModal">管理员模式</text>
					<text class="ntp-time-line">{{ networkTimeDisplay || '同步中...' }}</text>
					<view
						v-if="adminLocatUnavailable"
						class="qr-unavailable"
						@click.stop="openAdminManageModal"
						@tap.stop="openAdminManageModal"
					>
						<text class="qr-unavailable__title">{{ adminLocatUnavailableMessage || '当前地点已关闭' }}</text>
						<text class="qr-unavailable__desc">二维码暂停生成，可在管理员配置中重新启用</text>
					</view>
					<image v-else :src="qrCode" mode="widthFix" class="qr-code qr-code--interactive" @click="handleManualQrRefresh"></image>
					<text class="qr-tip">
						<text class="qr-tip-line">请使用微信扫码，点击二维码可手动刷新</text>
						<text class="qr-tip-line">刷新后上一个二维码会失效</text>
					</text>
					<text v-if="manualQrCooldownRemaining > 0" class="qr-cooldown">
						{{ manualQrCooldownRemaining }} 秒后可再次手动刷新
					</text>
				</view>

				<view class="stats-container">
					<view
						v-for="(item, index) in statsList"
						:key="item.key"
						class="stats-item"
						:style="{ animationDelay: (0.1 + index * 0.04) + 's' }"
						@mouseover="showNames(item.key)"
						@mouseleave="hideNames"
						@click.stop="onStatsItemPress(item.key, 'click')"
						@tap.stop="onStatsItemPress(item.key, 'tap')"
					>
						<text class="stats-label">{{ item.label }}</text>
						<text class="stats-value">{{ item.count }} 人</text>
						<view v-if="hover === item.key" class="tooltip">
							<view v-if="item.count === 0">{{ item.infoText || '暂无记录' }}</view>
							<view v-else-if="item.names.length === 0">暂无记录</view>
							<view v-else v-for="(n, nameIndex) in item.names" :key="item.key + '-' + nameIndex + '-' + n">{{ n }}</view>
						</view>
					</view>
				</view>
			</view>
		</view>

		<view v-else-if="!authInitializing" class="locked-state">
			<text class="locked-title">签到打卡系统</text>
			<text class="locked-desc">请输入密钥后查看二维码与实时统计。</text>
			<view class="locked-key-box" @click.stop @tap.stop>
				<view class="locked-key-title" :class="{ 'locked-key-title--visible': keyPromptMessage || locationForbidden }">
					<template v-if="locationForbidden">
						<text class="location-title-success">密钥正确</text><text>，但与绑定的地点不匹配</text>
					</template>
					<text v-else>{{ keyPromptMessage }}</text>
				</view>
				<view class="input-row">
					<view class="input-wrapper">
						<input
							v-model="inputKey"
							:type="showPassword ? 'text' : 'password'"
							class="modal-input"
							placeholder="请输入最新密钥"
							@confirm="confirmKey"
							:password-icon="false"
							focus
						/>
						<view class="eye-icon" @click="togglePassword">
							<svg
								v-if="!showPassword"
								width="20"
								height="20"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
								<circle cx="12" cy="12" r="3"></circle>
							</svg>
							<svg
								v-else
								width="20"
								height="20"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								stroke-linecap="round"
								stroke-linejoin="round"
							>
								<path
									d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
								></path>
								<line x1="1" y1="1" x2="23" y2="23"></line>
							</svg>
						</view>
					</view>
					<button class="modal-btn confirm-btn" @click="confirmKey">确定</button>
				</view>
			</view>
		</view>

		<view
			v-if="showDateModal"
			class="date-modal-mask"
			@click.stop="closeDateModal"
			@tap.stop="closeDateModal"
		>
			<view class="date-modal" @click.stop @tap.stop>
					<view class="date-modal__header">
						<view class="date-modal__heading">
							<text class="date-modal__title">
								{{
									activeDatePicker === 'start'
										? '选择开始日期'
										: activeDatePicker === 'end'
											? '选择结束日期'
											: '选择签到日期'
								}}
							</text>
							<text class="date-modal__value">{{ datePickerDraft }}</text>
						</view>
						<text class="date-modal__close" @click="closeDateModal" @tap="closeDateModal">取消</text>
					</view>
				<picker-view class="date-modal__picker" :value="datePickerValue" indicator-style="height: 48px;" @change="onDatePickerColumnChange">
					<picker-view-column>
						<view v-for="item in pickerYears" :key="'year-' + item.value" class="date-modal__option">
							{{ item.label }}
						</view>
					</picker-view-column>
					<picker-view-column>
						<view v-for="item in pickerMonths" :key="'month-' + item.value" class="date-modal__option">
							{{ item.label }}
						</view>
					</picker-view-column>
					<picker-view-column>
						<view v-for="item in pickerDays" :key="'day-' + item.value" class="date-modal__option">
							{{ item.label }}
						</view>
					</picker-view-column>
				</picker-view>
				<view class="date-modal__footer">
					<view class="date-modal__action date-modal__action--ghost" @click="closeDateModal" @tap="closeDateModal">取消</view>
					<view class="date-modal__action date-modal__action--primary" @click="confirmDateModal" @tap="confirmDateModal">确定</view>
				</view>
			</view>
		</view>

		<view
			v-if="showRankingModal"
			class="ranking-modal-mask"
			@click="closeRankingModal"
			@tap="closeRankingModal"
		>
			<view class="ranking-modal" @click.stop @tap.stop>
				<view class="ranking-modal__header">
					<view class="ranking-modal__title-wrap">
						<view class="ranking-modal__title-line">
							<text class="ranking-modal__title">总时长排行榜</text>
							<view
								class="ranking-modal__refresh"
								:class="{ 'ranking-modal__refresh--loading': rankingLoading }"
								@click="handleRankingRefresh"
								@tap="handleRankingRefresh"
							>
								<svg
									class="ranking-modal__refresh-svg"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linecap="round"
									stroke-linejoin="round"
								>
									<polyline points="23 4 23 10 17 10"></polyline>
									<polyline points="1 20 1 14 7 14"></polyline>
									<path d="M3.51 9a9 9 0 0 1 14.13-3.36L23 10"></path>
									<path d="M20.49 15a9 9 0 0 1-14.13 3.36L1 14"></path>
								</svg>
							</view>
						</view>
						<text class="ranking-modal__meta" v-if="rankingUpdatedAt">更新于 {{ rankingUpdatedAt }}</text>
					</view>
					<text class="ranking-modal__close" @click="closeRankingModal" @tap="closeRankingModal">关闭</text>
				</view>
				<scroll-view scroll-y class="ranking-modal__list">
					<view v-if="rankingLoading" class="ranking-modal__state">加载中...</view>
					<view v-else-if="rankingList.length === 0" class="ranking-modal__state">暂无可统计的时长数据</view>
					<view
						v-else
						v-for="item in rankingList"
						:key="item.studentId"
						class="ranking-row"
						:class="{ 'ranking-row--top': item.rank <= 3 }"
					>
						<view class="ranking-row__left">
							<text class="ranking-row__rank">#{{ item.rank }}</text>
							<view class="ranking-row__identity">
								<text class="ranking-row__name">{{ item.name || '未命名' }}</text>
								<text class="ranking-row__student-id">{{ item.studentId }}</text>
							</view>
						</view>
						<view class="ranking-row__right">
							<text class="ranking-row__duration">{{ formatHoursToLabel(item.totalHours) }}</text>
							<text class="ranking-row__extra">完成 {{ item.completedCount }}/{{ item.recordCount }} 次</text>
						</view>
					</view>
				</scroll-view>
				<view
					v-if="!rankingLoading && rankingTotal > 0"
					class="ranking-modal__footer"
				>
					<button
						class="ranking-modal__page-btn"
						:disabled="rankingPage <= 1"
						@click="changeRankingPage(-1)"
						@tap="changeRankingPage(-1)"
					>
						上一页
					</button>
					<text class="ranking-modal__page-info">
						第 {{ rankingPage }} / {{ rankingTotalPages }} 页 · 共 {{ rankingTotal }} 条
					</text>
					<button
						class="ranking-modal__page-btn"
						:disabled="rankingPage >= rankingTotalPages"
						@click="changeRankingPage(1)"
						@tap="changeRankingPage(1)"
					>
						下一页
					</button>
				</view>
			</view>
		</view>

		<view
			v-if="showRecordsModal"
			class="records-modal-mask"
			@click="closeRecordsModal"
			@tap="closeRecordsModal"
		>
			<view class="records-modal" @click.stop="closeRecordsLocationDropdown" @tap.stop="closeRecordsLocationDropdown">
				<view class="records-modal__header">
					<view class="records-modal__title-wrap">
						<view class="records-modal__title-line">
							<text class="records-modal__title">签到详情</text>
							<text class="records-modal__meta">· 共 {{ recordsTotal }} 条</text>
						</view>
					</view>
					<text class="records-modal__close" @click="closeRecordsModal" @tap="closeRecordsModal">关闭</text>
				</view>
					<view class="records-modal__toolbar">
						<view class="records-modal__search">
						<view class="records-modal__search-input-wrap">
							<text class="records-modal__search-input-chip records-modal__search-input-chip--name">姓名</text>
							<input
								v-model="recordsSearchName"
								class="records-modal__search-input-inner"
								placeholder="搜索姓名"
								confirm-type="search"
								@confirm="handleRecordsSearch"
							/>
						</view>
						<view class="records-modal__search-input-wrap">
							<text class="records-modal__search-input-chip records-modal__search-input-chip--student">学号</text>
							<input
								v-model="recordsSearchStudentId"
								class="records-modal__search-input-inner"
								placeholder="搜索学号"
								confirm-type="search"
								@confirm="handleRecordsSearch"
							/>
						</view>
						<view class="records-modal__search-location-wrap">
							<view
								class="records-modal__search-location"
								:class="{ 'records-modal__search-location--active': showRecordsLocationDropdown }"
								@click.stop="toggleRecordsLocationDropdown"
								@tap.stop
							>
								<view class="records-modal__search-location-shell">
									<text class="records-modal__search-location-chip">地点</text>
									<text class="records-modal__search-location-text">
										{{ getRecordsSelectedLocationLabel() }}
									</text>
									<text class="records-modal__search-location-arrow">▾</text>
								</view>
							</view>
							<scroll-view
								v-if="showRecordsLocationDropdown"
								scroll-y
								class="records-modal__search-location-dropdown"
								:style="{ height: getRecordsLocationDropdownHeight() }"
								@click.stop
								@tap.stop
								@touchmove.stop
							>
								<view
									v-for="(item, index) in recordsLocationOptions"
									:key="'loc-drop-' + index + '-' + item.value"
									class="records-location-option"
									:class="{ 'records-location-option--active': index === recordsSearchLocationIndex }"
									@click.stop="onRecordsLocationSelect(index)"
									@tap.stop
								>
									<view class="records-location-option__mark"></view>
									<view class="records-location-option__main">
										<text class="records-location-option__label">{{ item.label }}</text>
										<text class="records-location-option__meta">{{ item.value || '不过滤地点' }}</text>
									</view>
									<text v-if="index === recordsSearchLocationIndex" class="records-location-option__check">✓</text>
								</view>
							</scroll-view>
						</view>
						<view class="records-modal__search-date-wrap">
							<view
								class="records-modal__search-date"
								:class="{ 'records-modal__search-date--active': showDateModal && activeDatePicker === 'records' }"
								@click.stop="openRecordsSearchDateModal"
								@tap.stop="openRecordsSearchDateModal"
							>
								<view class="records-modal__search-date-shell">
									<text class="records-modal__search-date-chip">日期</text>
									<text
										class="records-modal__search-date-text"
										:class="{ 'records-modal__search-date-text--placeholder': !recordsSearchDate }"
									>
										{{ recordsSearchDate || '请选择日期' }}
									</text>
									<text class="records-modal__search-date-arrow">▾</text>
								</view>
							</view>
						</view>
						<button class="records-modal__search-btn" @click="handleRecordsSearch">搜索</button>
						<button class="records-modal__search-btn records-modal__search-btn--ghost" @click="resetRecordsSearch">重置</button>
					</view>
					<view class="records-modal__tools-row">
						<view class="records-modal__sizes">
							<text class="records-modal__sizes-label">每页</text>
							<view class="records-modal__size-options">
								<view
									v-for="size in recordsPageSizeOptions"
									:key="'records-size-' + size"
									class="records-modal__size-option"
									:class="{ 'records-modal__size-option--active': recordsPageSize === size }"
									@click="setRecordsPageSize(size)"
									@tap="setRecordsPageSize(size)"
								>
									{{ size }}
								</view>
							</view>
						</view>
						<text class="records-modal__page-info">第 {{ recordsPage }} / {{ recordsTotalPages }} 页</text>
					</view>
				</view>

				<scroll-view scroll-y class="records-modal__list">
					<view v-if="recordsLoading" class="records-modal__state">加载中...</view>
					<view v-else-if="recordsList.length === 0" class="records-modal__state">暂无签到详情</view>
					<view v-else class="records-table-mobile-shell">
						<view class="records-name-fixed">
							<view class="records-name-fixed__cell records-name-fixed__cell--head">姓名</view>
							<view
								v-for="(item, index) in recordsList"
								:key="'fixed-name-' + (item.studentId || 'row') + '-' + index + '-' + (item.signInTime || '')"
								class="records-name-fixed__cell"
							>
								{{ item.name || '-' }}
							</view>
						</view>
						<scroll-view
							scroll-x
							:scroll-left="recordsTableScrollLeft"
							class="records-table-scroll"
							@scroll="onRecordsTableScroll"
						>
						<view class="records-table" :class="{ 'records-table--admin': currentRole === 'admin' }">
							<view class="records-table__row records-table__row--head">
								<text selectable="true" class="records-col">姓名</text>
								<text selectable="true" class="records-col">学号</text>
								<text selectable="true" class="records-col">状态</text>
								<text selectable="true" class="records-col">地点</text>
								<text selectable="true" class="records-col">签到时间</text>
								<text selectable="true" class="records-col">签退时间</text>
								<text selectable="true" class="records-col">时长</text>
								<text v-if="currentRole === 'admin'" selectable="true" class="records-col records-col--action">操作</text>
							</view>
							<view
								v-for="(item, index) in recordsList"
								:key="(item.studentId || 'row') + '-' + index + '-' + (item.signInTime || '')"
								class="records-table__row"
							>
								<text selectable="true" class="records-col records-col--name">{{ item.name || '-' }}</text>
								<text selectable="true" class="records-col">{{ item.studentId || '-' }}</text>
								<text
									selectable="true"
									class="records-col records-col--status"
									:class="item.actionType === '已完成' ? 'records-col--status-done' : 'records-col--status-active'"
								>
									{{ item.actionType || '-' }}
								</text>
								<text selectable="true" class="records-col">{{ formatRecordLocation(item.location) }}</text>
								<text selectable="true" class="records-col">{{ item.signInTime || '-' }}</text>
								<text selectable="true" class="records-col">{{ item.signOutTime || '-' }}</text>
								<text selectable="true" class="records-col">{{ formatRecordDuration(item.timeadd) }}</text>
								<view v-if="currentRole === 'admin'" class="records-col records-col--action">
									<text class="rec-action-btn rec-action-btn--edit" @click.stop="adminEditRecord(item)" @tap.stop="adminEditRecord(item)">编辑</text>
									<text class="rec-action-btn rec-action-btn--del" @click.stop="adminDeleteRecord(item)" @tap.stop="adminDeleteRecord(item)">删除</text>
								</view>
							</view>
						</view>
						</scroll-view>
					</view>
				</scroll-view>

				<scroll-view
					v-if="!recordsLoading && recordsList.length > 0"
					scroll-x
					show-scrollbar="true"
					:scroll-left="recordsTableScrollLeft"
					class="records-table-fixed-scroll"
					@scroll="onRecordsTableScrollbarScroll"
				>
					<view class="records-table-scroll-spacer" :style="{ width: currentRole === 'admin' ? 'max(1040px, 100%)' : 'max(930px, 100%)' }"></view>
				</scroll-view>

				<view class="records-modal__footer">
					<button
						class="records-modal__page-btn"
						:disabled="recordsLoading || recordsPage <= 1"
						@click="changeRecordsPage(-1)"
					>
						上一页
					</button>
					<text class="records-modal__footer-total">共 {{ recordsTotal }} 条</text>
					<button
						class="records-modal__page-btn"
						:disabled="recordsLoading || recordsPage >= recordsTotalPages"
						@click="changeRecordsPage(1)"
					>
						下一页
					</button>
				</view>
			</view>
		</view>


		<view
			v-if="showEditRecordModal"
			class="edit-record-mask"
			@click.stop="showEditRecordModal = false"
			@tap.stop="showEditRecordModal = false"
		>
			<view class="edit-record-modal" @click.stop @tap.stop>
				<view class="edit-record-modal__title">编辑签到记录</view>
				<view class="edit-record-form">
					<view class="edit-record-row edit-record-row--name">
						<text class="edit-record-label">姓名：</text>
						<input class="edit-record-input" v-model="editRecord.name" placeholder="姓名" />
					</view>
					<view class="edit-record-row edit-record-row--student">
						<text class="edit-record-label">学号：</text>
						<input class="edit-record-input" v-model="editRecord.studentId" placeholder="学号" />
					</view>
					<view class="edit-record-row edit-record-row--status">
						<text class="edit-record-label">状态：</text>
						<input class="edit-record-input edit-record-input--readonly" :value="editRecord.actionType" disabled placeholder="签到 / 已完成" />
					</view>
					<view class="edit-record-row edit-record-row--location">
						<text class="edit-record-label">地点：</text>
						<input class="edit-record-input edit-record-input--readonly" :value="formatRecordLocation(editRecord.location)" disabled placeholder="地点" />
					</view>
					<view class="edit-record-row edit-record-row--signin">
						<text class="edit-record-label">签到时间：</text>
						<view class="edit-record-time-group">
							<view class="edit-record-time-btn" @click.stop="openEditTimePicker('signInTime', 'date')" @tap.stop="openEditTimePicker('signInTime', 'date')">
								<text class="edit-record-time-text" :class="editRecord.signInDate ? '' : 'edit-record-time-placeholder'">{{ editRecord.signInDate || '选择年月日' }}</text>
								<text class="edit-record-time-arrow">▾</text>
							</view>
							<view class="edit-record-time-btn" @click.stop="openEditTimePicker('signInTime', 'time')" @tap.stop="openEditTimePicker('signInTime', 'time')">
								<text class="edit-record-time-text" :class="editRecord.signInClock ? '' : 'edit-record-time-placeholder'">{{ editRecord.signInClock || '选择时分秒' }}</text>
								<text class="edit-record-time-arrow">▾</text>
							</view>
						</view>
					</view>
					<view class="edit-record-row edit-record-row--signout">
						<text class="edit-record-label">签退时间：</text>
						<view class="edit-record-time-group" :class="{ 'edit-record-time-group--clearable': editRecord.signOutDate || editRecord.signOutClock }">
							<view class="edit-record-time-btn" @click.stop="openEditTimePicker('signOutTime', 'date')" @tap.stop="openEditTimePicker('signOutTime', 'date')">
								<text class="edit-record-time-text" :class="editRecord.signOutDate ? '' : 'edit-record-time-placeholder'">{{ editRecord.signOutDate || '选择年月日' }}</text>
								<text class="edit-record-time-arrow">▾</text>
							</view>
							<view class="edit-record-time-btn" @click.stop="openEditTimePicker('signOutTime', 'time')" @tap.stop="openEditTimePicker('signOutTime', 'time')">
								<text class="edit-record-time-text" :class="editRecord.signOutClock ? '' : 'edit-record-time-placeholder'">{{ editRecord.signOutClock || '选择时分秒' }}</text>
								<text class="edit-record-time-arrow">▾</text>
							</view>
							<text v-if="editRecord.signOutDate || editRecord.signOutClock" class="edit-record-time-clear" @click.stop="clearEditSignOutTime" @tap.stop="clearEditSignOutTime">清空</text>
						</view>
					</view>
					<view class="edit-record-row edit-record-row--duration">
						<text class="edit-record-label">时长：</text>
						<input class="edit-record-input edit-record-input--readonly" :value="editRecord.timeadd" disabled placeholder="自动计算" />
					</view>
				</view>
				<view class="edit-record-modal__footer">
					<view class="edit-record-modal__btn edit-record-modal__btn--cancel" @click="showEditRecordModal = false" @tap="showEditRecordModal = false">取消</view>
					<view class="edit-record-modal__btn edit-record-modal__btn--confirm" :class="{ 'edit-record-modal__btn--loading': editRecordSubmitting }" @click="submitEditRecord" @tap="submitEditRecord">{{ editRecordSubmitting ? '保存中...' : '保存' }}</view>
				</view>
			</view>
		</view>

		<view
			v-if="showEditTimePicker"
			class="edit-record-mask"
			@click.stop="showEditTimePicker = false"
			@tap.stop="showEditTimePicker = false"
		>
			<view class="edit-record-modal edit-record-modal--time" @click.stop @tap.stop>
				<view class="edit-record-modal__title">
					{{ getEditTimePickerTitle() }}
				</view>
				<view class="edit-tp-preview">
					<text class="edit-tp-preview__value">{{ editTimePickerMode === 'date' ? editTimePickerDateDraft : editTimePickerTimeDraft }}</text>
				</view>
				<picker-view v-if="editTimePickerMode === 'date'" class="date-modal__picker edit-time-picker" :value="editTimePickerDateValue" indicator-style="height: 48px;" @change="onEditDatePickerChange">
					<picker-view-column>
						<view v-for="item in editTimePickerYears" :key="'ety-'+item.value" class="date-modal__option">{{ item.label }}</view>
					</picker-view-column>
					<picker-view-column>
						<view v-for="item in editTimePickerMonths" :key="'etm-'+item.value" class="date-modal__option">{{ item.label }}</view>
					</picker-view-column>
					<picker-view-column>
						<view v-for="item in editTimePickerDays" :key="'etd-'+item.value" class="date-modal__option">{{ item.label }}</view>
					</picker-view-column>
				</picker-view>
				<picker-view v-else class="date-modal__picker edit-time-picker" :value="editTimePickerTimeValue" indicator-style="height: 48px;" @change="onEditTimePickerChange">
					<picker-view-column>
						<view v-for="item in editTimePickerHours" :key="'eth-'+item.value" class="date-modal__option">{{ item.label }}</view>
					</picker-view-column>
					<picker-view-column>
						<view v-for="item in editTimePickerMinutes" :key="'etmin-'+item.value" class="date-modal__option">{{ item.label }}</view>
					</picker-view-column>
					<picker-view-column>
						<view v-for="item in editTimePickerSeconds" :key="'ets-'+item.value" class="date-modal__option">{{ item.label }}</view>
					</picker-view-column>
				</picker-view>
				<view class="date-modal__footer">
					<view class="date-modal__action date-modal__action--ghost" @click="showEditTimePicker = false" @tap="showEditTimePicker = false">取消</view>
					<view class="date-modal__action date-modal__action--primary" @click="confirmEditTimePicker" @tap="confirmEditTimePicker">确定</view>
				</view>
			</view>
		</view>

		<view
			v-if="showDeleteConfirm"
			class="delete-confirm-mask"
			@click.stop="closeDeleteConfirm"
			@tap.stop="closeDeleteConfirm"
		>
			<view class="delete-confirm-modal" @click.stop @tap.stop>
				<view class="delete-confirm__head">
					<text class="delete-confirm__title">确认删除</text>
					<text class="delete-confirm__close" @click="closeDeleteConfirm" @tap="closeDeleteConfirm">关闭</text>
				</view>
				<text class="delete-confirm__desc">删除后无法恢复，确定删除 {{ formatDeleteRecordName(deleteConfirmItem) }} 的签到记录？</text>
				<view class="delete-confirm__record" v-if="deleteConfirmItem">
					<text>学号：{{ deleteConfirmItem.studentId || '-' }}</text>
					<text>签到：{{ deleteConfirmItem.signInTime || '-' }}</text>
					<text>签退：{{ deleteConfirmItem.signOutTime || '-' }}</text>
				</view>
				<view class="delete-confirm__footer">
					<view class="delete-confirm__btn delete-confirm__btn--ghost" @click="closeDeleteConfirm" @tap="closeDeleteConfirm">取消</view>
					<view class="delete-confirm__btn delete-confirm__btn--danger" :class="{ 'delete-confirm__btn--loading': deleteSubmitting }" @click="confirmDeleteRecord" @tap="confirmDeleteRecord">{{ deleteSubmitting ? '删除中...' : '确认删除' }}</view>
				</view>
			</view>
		</view>
		<view
			v-if="showAdminManageModal"
			class="admin-manage-mask"
			@click.stop="closeAdminManageModal"
			@tap.stop="closeAdminManageModal"
		>
			<view
				class="admin-manage-modal"
				@click.stop
				@tap.stop
			>
				<view class="admin-manage__header">
					<view class="admin-manage__title-wrap">
						<text class="admin-manage__title">管理员配置</text>
						<text class="admin-manage__meta">地点与普通密钥</text>
					</view>
					<text class="admin-manage__close" @click="closeAdminManageModal" @tap="closeAdminManageModal">关闭</text>
				</view>
				<view class="admin-manage__tabs">
					<view class="admin-manage__tab" :class="{ 'admin-manage__tab--active': adminManageTab === 'locats' }" @click="adminManageTab = 'locats'" @tap="adminManageTab = 'locats'">地点管理</view>
					<view class="admin-manage__tab" :class="{ 'admin-manage__tab--active': adminManageTab === 'keys' }" @click="adminManageTab = 'keys'" @tap="adminManageTab = 'keys'">密钥管理</view>
				</view>

				<scroll-view scroll-y class="admin-manage__body">
					<view v-if="adminManageLoading" class="admin-manage__state">加载中...</view>
					<view v-else-if="adminManageTab === 'locats'" class="admin-manage__section">
						<view class="admin-table admin-table--locat">
							<view class="admin-table__row admin-table__row--head">
								<text>英文编码</text>
								<text>中文编码</text>
								<text>人数上限</text>
								<text>状态</text>
								<text>音频</text>
								<text>操作</text>
							</view>
							<view
								v-for="(item, index) in adminLocats"
								:key="getAdminLocatRowKey(item, index)"
								class="admin-table__row"
								:class="{ 'admin-table__row--editing': isEditingAdminLocat(item) }"
							>
								<input
									v-if="isEditingAdminLocat(item)"
									class="admin-table-input"
									v-model="item.editDraft.locat_en"
									:focus="isAdminLocatEditFocused(item, 'locat_en')"
									placeholder="英文编码"
								/>
								<text v-else class="admin-table-editable-cell" @click.stop="editAdminLocat(item, 'locat_en')" @tap.stop="editAdminLocat(item, 'locat_en')">{{ item.locat_en || '-' }}</text>
								<input
									v-if="isEditingAdminLocat(item)"
									class="admin-table-input"
									v-model="item.editDraft.locat_cn"
									:focus="isAdminLocatEditFocused(item, 'locat_cn')"
									placeholder="中文编码"
								/>
								<text v-else class="admin-table-editable-cell" @click.stop="editAdminLocat(item, 'locat_cn')" @tap.stop="editAdminLocat(item, 'locat_cn')">{{ item.locat_cn || '-' }}</text>
								<input
									v-if="isEditingAdminLocat(item)"
									class="admin-table-input"
									v-model="item.editDraft.max_people"
									:focus="isAdminLocatEditFocused(item, 'max_people')"
									type="number"
									placeholder="0"
								/>
								<text v-else class="admin-table-editable-cell" @click.stop="editAdminLocat(item, 'max_people')" @tap.stop="editAdminLocat(item, 'max_people')">{{ item.max_people }}</text>
								<view
									v-if="isEditingAdminLocat(item)"
									class="admin-table-switch"
									:class="{ 'admin-table-switch--on': Number(item.editDraft.enabled) === 1 }"
									@click.stop="toggleAdminLocatEditEnabled(item)"
									@tap.stop="toggleAdminLocatEditEnabled(item)"
								>
									<view class="admin-table-switch__track">
										<view class="admin-table-switch__thumb"></view>
									</view>
									<text class="admin-table-switch__label">{{ Number(item.editDraft.enabled) === 1 ? '启用' : '关闭' }}</text>
								</view>
								<view
									v-else
									class="admin-table-switch"
									:class="{ 'admin-table-switch--on': item.enabled === 1 }"
									@click.stop="toggleAdminLocatEnabled(item)"
									@tap.stop="toggleAdminLocatEnabled(item)"
								>
									<view class="admin-table-switch__track">
										<view class="admin-table-switch__thumb"></view>
									</view>
									<text class="admin-table-switch__label">{{ item.enabled === 1 ? '启用' : '关闭' }}</text>
								</view>
								<view
									v-if="isEditingAdminLocat(item)"
									class="admin-table-switch"
									:class="{ 'admin-table-switch--on': Number(item.editDraft.audio) === 1 }"
									@click.stop="toggleAdminLocatEditAudio(item)"
									@tap.stop="toggleAdminLocatEditAudio(item)"
								>
									<view class="admin-table-switch__track">
										<view class="admin-table-switch__thumb"></view>
									</view>
									<text class="admin-table-switch__label">{{ Number(item.editDraft.audio) === 1 ? '开启' : '关闭' }}</text>
								</view>
								<view
									v-else
									class="admin-table-switch"
									:class="{ 'admin-table-switch--on': item.audio === 1 }"
									@click.stop="toggleAdminLocatAudio(item)"
									@tap.stop="toggleAdminLocatAudio(item)"
								>
									<view class="admin-table-switch__track">
										<view class="admin-table-switch__thumb"></view>
									</view>
									<text class="admin-table-switch__label">{{ item.audio === 1 ? '开启' : '关闭' }}</text>
								</view>
								<view class="admin-table__actions">
									<template v-if="isEditingAdminLocat(item)">
										<text class="admin-link-btn admin-link-btn--success" @click="saveAdminLocat(item)" @tap="saveAdminLocat(item)">保存</text>
										<text class="admin-link-btn" @click="cancelAdminLocatEdit(item)" @tap="cancelAdminLocatEdit(item)">取消</text>
									</template>
									<template v-else>
										<text class="admin-link-btn" @click="editAdminLocat(item, 'locat_en')" @tap="editAdminLocat(item, 'locat_en')">编辑</text>
										<text class="admin-link-btn admin-link-btn--danger" @click="deleteAdminLocat(item)" @tap="deleteAdminLocat(item)">删除</text>
									</template>
								</view>
							</view>
							<view class="admin-table-add-row">
								<text
									class="admin-table-add-btn"
									:class="{ 'admin-table-add-btn--disabled': adminManageSubmitting || hasUnsavedAdminLocatNewRow() }"
									@click.stop="addAdminLocatRow"
									@tap.stop="addAdminLocatRow"
								>+</text>
							</view>
						</view>
					</view>

					<view
						v-else
						class="admin-manage__section"
					>
						<view class="admin-table admin-table--key">
							<view class="admin-table__row admin-table__row--head">
								<text>密钥</text>
								<text>状态</text>
								<text>在线</text>
								<text>绑定地点</text>
								<text>操作</text>
							</view>
							<view
								v-for="(item, index) in adminUserKeys"
								:key="getAdminKeyRowKey(item, index)"
								class="admin-table__row"
								:class="{ 'admin-table__row--editing': isEditingAdminKey(item) }"
								@click.stop="handleAdminKeyRowPress(item)"
								@tap.stop="handleAdminKeyRowPress(item)"
							>
								<input
									v-if="isEditingAdminKey(item)"
									class="admin-table-input"
									v-model="item.editDraft.key"
									:focus="isAdminKeyEditFocused(item, 'key')"
									placeholder="密钥"
								/>
								<text
									v-else
									class="admin-key-cell"
									@click.stop="toggleAdminKeyVisible(item)"
									@tap.stop="toggleAdminKeyVisible(item)"
								>{{ getAdminKeyDisplay(item) }}</text>
								<view
									v-if="isEditingAdminKey(item)"
									class="admin-table-switch"
									:class="{ 'admin-table-switch--on': Number(item.editDraft.enabled) === 1 }"
									@click.stop="toggleAdminKeyEditEnabled(item)"
									@tap.stop="toggleAdminKeyEditEnabled(item)"
								>
									<view class="admin-table-switch__track">
										<view class="admin-table-switch__thumb"></view>
									</view>
									<text class="admin-table-switch__label">{{ Number(item.editDraft.enabled) === 1 ? '启用' : '禁用' }}</text>
								</view>
								<view
									v-else
									class="admin-table-switch"
									:class="{ 'admin-table-switch--on': item.enabled === 1 }"
									@click.stop="editAdminKey(item, 'enabled')"
									@tap.stop="editAdminKey(item, 'enabled')"
								>
									<view class="admin-table-switch__track">
										<view class="admin-table-switch__thumb"></view>
									</view>
									<text class="admin-table-switch__label">{{ item.enabled === 1 ? '启用' : '禁用' }}</text>
								</view>
								<text :class="item.online === 1 ? 'admin-status--ok' : 'admin-status--off'">{{ item.online === 1 ? '在线' : '离线' }}</text>
								<view
									v-if="isEditingAdminKey(item)"
									class="admin-location-select admin-key-inline-location"
									:class="{ 'admin-location-select--active': showAdminKeyLocationModal && adminKeyLocationEditingRowKey === getAdminKeyEditRowKey(item) }"
									@click.stop="openAdminKeyLocationModal(item)"
									@tap.stop="openAdminKeyLocationModal(item)"
								>
									<view class="admin-location-select__shell">
										<text class="admin-location-select__text">{{ getAdminKeyEditLocationLabel(item) }}</text>
										<text class="admin-location-select__arrow">▾</text>
									</view>
								</view>
								<text
									v-else
									class="admin-table-editable-cell"
									@click.stop="editAdminKey(item, 'location')"
									@tap.stop="editAdminKey(item, 'location')"
								>{{ item.location_cn || formatAdminLocatLabel(item.location) }}</text>
								<view class="admin-table__actions">
									<template v-if="isEditingAdminKey(item)">
										<text class="admin-link-btn admin-link-btn--success" @click.stop="saveAdminKeyEdit(item)" @tap.stop="saveAdminKeyEdit(item)">保存</text>
										<text class="admin-link-btn" @click.stop="cancelAdminKeyEdit(item)" @tap.stop="cancelAdminKeyEdit(item)">取消</text>
									</template>
									<template v-else>
										<text class="admin-link-btn" @click.stop="editAdminKey(item, 'key')" @tap.stop="editAdminKey(item, 'key')">编辑</text>
										<text class="admin-link-btn" @click.stop="forceLogoutAdminKey(item)" @tap.stop="forceLogoutAdminKey(item)">下线</text>
										<text class="admin-link-btn admin-link-btn--danger" @click.stop="deleteAdminKey(item)" @tap.stop="deleteAdminKey(item)">删除</text>
									</template>
								</view>
							</view>
							<view class="admin-table-add-row">
								<text
									class="admin-table-add-btn"
									:class="{ 'admin-table-add-btn--disabled': adminManageSubmitting || hasUnsavedAdminKeyNewRow() }"
									@click.stop="addAdminKeyRow"
									@tap.stop="addAdminKeyRow"
								>+</text>
							</view>
						</view>
					</view>
				</scroll-view>
			</view>
		</view>
		<view
			v-if="showAdminKeyLocationModal"
			class="admin-location-modal-mask"
			@click.stop="closeAdminKeyLocationModal"
			@tap.stop="closeAdminKeyLocationModal"
		>
			<view class="admin-location-modal" @click.stop @tap.stop>
				<view class="admin-location-modal__header">
					<view class="admin-location-modal__heading">
						<text class="admin-location-modal__title">选择绑定地点</text>
						<text class="admin-location-modal__value">{{ getAdminKeyLocationDraftLabel() }}</text>
					</view>
					<text class="admin-location-modal__close" @click="closeAdminKeyLocationModal" @tap="closeAdminKeyLocationModal">取消</text>
				</view>
				<scroll-view scroll-y class="admin-location-modal__list" @touchmove.stop>
					<view
						class="admin-location-modal__option admin-location-modal__option--all"
						:class="{ 'admin-location-modal__option--active': isAdminKeyLocationDraftSelected('*') }"
						@click.stop="selectAdminKeyLocationDraft('*')"
						@tap.stop="selectAdminKeyLocationDraft('*')"
					>
						<view class="admin-location-modal__mark"></view>
						<view class="admin-location-modal__option-main">
							<text class="admin-location-modal__label">全部地点</text>
							<text class="admin-location-modal__meta">*</text>
						</view>
						<text v-if="isAdminKeyLocationDraftSelected('*')" class="admin-location-modal__check">✓</text>
					</view>
					<view
						v-for="loc in getAdminEnabledLocats()"
						:key="'admin-key-loc-modal-' + loc.id"
						class="admin-location-modal__option"
						:class="{ 'admin-location-modal__option--active': isAdminKeyLocationDraftSelected(loc.locat_en) }"
						@click.stop="selectAdminKeyLocationDraft(loc.locat_en)"
						@tap.stop="selectAdminKeyLocationDraft(loc.locat_en)"
					>
						<view class="admin-location-modal__mark"></view>
						<view class="admin-location-modal__option-main">
							<text class="admin-location-modal__label">{{ loc.locat_cn || loc.locat_en }}</text>
							<text class="admin-location-modal__meta">{{ loc.locat_en }}</text>
						</view>
						<text v-if="isAdminKeyLocationDraftSelected(loc.locat_en)" class="admin-location-modal__check">✓</text>
					</view>
					<view v-if="getAdminEnabledLocats().length === 0" class="admin-location-modal__empty">
						暂无可用地点
					</view>
				</scroll-view>
				<view class="date-modal__footer">
					<view class="date-modal__action date-modal__action--ghost" @click="closeAdminKeyLocationModal" @tap="closeAdminKeyLocationModal">取消</view>
					<view class="date-modal__action date-modal__action--primary" @click="confirmAdminKeyLocationModal" @tap="confirmAdminKeyLocationModal">确定</view>
				</view>
			</view>
		</view>
		<view
			v-if="showAdminConfirm"
			class="admin-confirm-mask"
			@click.stop="resolveAdminConfirm(false)"
			@tap.stop="resolveAdminConfirm(false)"
		>
			<view class="admin-confirm-modal" @click.stop @tap.stop>
				<view class="admin-confirm__head">
					<text class="admin-confirm__title">{{ adminConfirmTitle }}</text>
					<text class="admin-confirm__close" @click="resolveAdminConfirm(false)" @tap="resolveAdminConfirm(false)">关闭</text>
				</view>
				<text class="admin-confirm__desc">{{ adminConfirmContent }}</text>
				<view class="admin-confirm__footer">
					<view class="admin-confirm__btn admin-confirm__btn--ghost" @click="resolveAdminConfirm(false)" @tap="resolveAdminConfirm(false)">取消</view>
					<view class="admin-confirm__btn admin-confirm__btn--danger" @click="resolveAdminConfirm(true)" @tap="resolveAdminConfirm(true)">{{ adminConfirmText }}</view>
				</view>
			</view>
		</view>
		<view v-if="appToast.show" class="app-toast" :class="'app-toast--' + appToast.type">
			<text class="app-toast__icon">{{ appToast.type === 'success' ? '✓' : appToast.type === 'error' ? '!' : 'i' }}</text>
			<text class="app-toast__text">{{ appToast.message }}</text>
		</view>
	</view>
</template>

<script src="./index.js"></script>

<style src="./index.css"></style>
