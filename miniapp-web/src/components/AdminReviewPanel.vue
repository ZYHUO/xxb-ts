<script setup>
import { computed, reactive } from 'vue';
import { buildAdminSections, summarizeReason } from '../lib/adminGroups';

const props = defineProps({
  manualQueue: { type: Array, default: () => [] },
  aiApproved: { type: Array, default: () => [] },
  groups: { type: Array, default: () => [] },
  adminBusyKey: { type: String, default: '' },
  adminMessage: { type: String, default: '' },
  adminTone: { type: String, default: 'info' },
});

const emit = defineEmits(['approve', 'approve-enable', 'reject', 'toggle-group', 'ai-review', 'refresh', 'remove-group', 'check-group-permissions']);

const tg = window.Telegram?.WebApp ?? null;

const openSections = reactive({ manual: true, ai: false, groups: true });
const expandedReasons = reactive({});

const sections = computed(() =>
  buildAdminSections({
    manualQueue: props.manualQueue,
    aiApproved: props.aiApproved,
    groups: props.groups,
  })
);

const allEmpty = computed(
  () => props.manualQueue.length === 0 && props.aiApproved.length === 0 && props.groups.length === 0
);

function toggleSection(key) {
  openSections[key] = !openSections[key];
  try { tg?.HapticFeedback?.selectionChanged?.(); } catch { /* ignore */ }
}

function toggleReason(key) {
  expandedReasons[key] = !expandedReasons[key];
}

function reasonKey(sectionKey, item) {
  return `${sectionKey}:${item.request_id ?? item.chat_id ?? 'row'}`;
}

function formatReason(sectionKey, item) {
  const key = reasonKey(sectionKey, item);
  const reason = String(item.ai_reason ?? '').trim();
  if (!reason) return '—';
  return expandedReasons[key] ? reason : summarizeReason(reason, 56);
}

function formatConfidence(value) {
  if (typeof value !== 'number') return '—';
  return value.toFixed(2);
}

function formatTimestamp(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts * 1000));
}

function submitterUserId(item) {
  const a = item.user_id;
  const b = item.submitter_user_id;
  if (a != null && a !== '') return Number(a);
  if (b != null && b !== '') return Number(b);
  return null;
}

function submitterDisplayName(item) {
  const fn = String(item.first_name ?? item.submitter_first_name ?? '').trim();
  const ln = String(item.last_name ?? item.submitter_last_name ?? '').trim();
  if (fn && ln) return `${fn} ${ln}`;
  if (fn) return fn;
  if (ln) return ln;
  return '';
}

function formatSubmitter(item) {
  const u = item.username ?? item.submitter_username;
  if (typeof u === 'string' && u.trim() !== '') return `@${u.trim()}`;
  const name = submitterDisplayName(item);
  if (name) return name;
  const uid = submitterUserId(item);
  if (uid != null && Number.isFinite(uid) && uid !== 0) return `uid ${uid}`;
  return '暂无';
}

function decisionClass(decision) {
  if (decision === 'APPROVE') return 'status-on';
  if (decision === 'REJECT') return 'perm-false';
  return '';
}

function confirmAction(message, callback) {
  if (tg?.showConfirm) {
    tg.showConfirm(message, (confirmed) => { if (confirmed) callback(); });
  } else if (window.confirm(message)) {
    callback();
  }
}

function onReject(item) {
  confirmAction('确定要拒绝这个申请吗？', () => emit('reject', item));
}

function onToggleGroup(item) {
  if (item.enabled) {
    confirmAction('确定要关闭该群的机器人吗？', () => emit('toggle-group', item));
  } else {
    emit('toggle-group', item);
  }
}

function onRemoveGroup(item) {
  confirmAction('确定要从白名单中彻底移除该群吗？此操作不可撤销。', () => emit('remove-group', item));
}

function onRefresh() {
  try { tg?.HapticFeedback?.impactOccurred?.('light'); } catch { /* ignore */ }
  emit('refresh');
}
</script>

<template>
  <div class="admin-review-head">
    <div class="tg-section-header admin-review-title">审核中心</div>
    <button type="button" class="admin-refresh-btn" @click="onRefresh">刷新</button>
  </div>

  <template v-if="allEmpty">
    <section class="tg-section">
      <div class="tg-cell tg-cell-center">
        <span class="tg-hint">暂无待处理事项。</span>
      </div>
    </section>
  </template>

  <template v-else>
    <template v-for="section in sections" :key="section.key">
      <!-- Section toggle -->
      <section class="tg-section">
        <button class="tg-cell tg-cell-row section-toggle" @click="toggleSection(section.key)">
          <span class="tg-cell-label section-label-stack">
            {{ section.title }}
            <span v-if="section.subtitle" class="section-subtitle">{{ section.subtitle }}</span>
          </span>
          <span class="section-count">
            <span class="section-count-num">{{ section.items.length }}</span>
            <span class="section-arrow" :class="{ 'section-arrow-open': openSections[section.key] }">›</span>
          </span>
        </button>
      </section>

      <!-- Section body -->
      <template v-if="openSections[section.key]">
        <template v-if="!section.items.length">
          <div class="tg-section-footer">暂无记录。</div>
        </template>

        <template v-else>
          <template v-for="item in section.items" :key="item.request_id || item.chat_id">
            <section class="tg-section record-section">
              <!-- Title row -->
              <div class="tg-cell tg-cell-multi">
                <div class="tg-cell-row">
                  <strong class="record-title">{{ item.chat_title || item.title || item.chat_id }}</strong>
                  <span class="tg-cell-value record-time">
                    {{ formatTimestamp(item.ai_reviewed_at || item.updated_at || item.created_at) }}
                  </span>
                </div>
                <span class="tg-cell-subtitle">{{ item.chat_id }}</span>
              </div>

              <div class="tg-cell tg-cell-row submitter-row">
                <span class="tg-cell-label submitter-label">提交者</span>
                <span class="tg-cell-value submitter-value">{{ formatSubmitter(item) }}</span>
              </div>

              <!-- Fields for manual / ai -->
              <template v-if="section.key !== 'groups'">
                <div class="tg-cell tg-cell-row">
                  <span class="tg-cell-label">AI 决定</span>
                  <span :class="['tg-cell-value', decisionClass(item.ai_decision)]">
                    {{ item.ai_decision || '—' }}
                  </span>
                </div>
                <div class="tg-cell tg-cell-row">
                  <span class="tg-cell-label">置信度</span>
                  <span class="tg-cell-value">{{ formatConfidence(item.ai_confidence) }}</span>
                </div>
                <div class="tg-cell tg-cell-multi">
                  <div class="tg-cell-row">
                    <span class="tg-cell-label">理由</span>
                    <button
                      v-if="item.ai_reason"
                      class="reason-toggle"
                      @click="toggleReason(reasonKey(section.key, item))"
                    >
                      {{ expandedReasons[reasonKey(section.key, item)] ? '收起' : '展开' }}
                    </button>
                  </div>
                  <span class="tg-cell-subtitle reason-text">{{ formatReason(section.key, item) }}</span>
                </div>
              </template>

              <!-- Fields for manual: note -->
              <div v-if="section.key === 'manual'" class="tg-cell tg-cell-multi">
                <span class="tg-cell-label">备注</span>
                <span class="tg-cell-subtitle">{{ item.note || '无备注' }}</span>
              </div>

              <!-- Fields for groups -->
              <template v-if="section.key === 'groups'">
                <div class="tg-cell tg-cell-row">
                  <span class="tg-cell-label">审核</span>
                  <span class="tg-cell-value">
                    {{ item.review_state === 'auto_approved' ? 'AI 自动' : (item.review_state === 'manual_approved' ? '人工通过' : (item.review_state || '—')) }}
                  </span>
                </div>
                <div class="tg-cell tg-cell-row">
                  <span class="tg-cell-label">来源</span>
                  <span class="tg-cell-value">{{ item.approved_by || '—' }}</span>
                </div>
                <div class="tg-cell tg-cell-row">
                  <span class="tg-cell-label">状态</span>
                  <span :class="['tg-cell-value', item.enabled ? 'status-on' : 'status-off']">
                    {{ item.enabled ? '已启用' : '未启用' }}
                  </span>
                </div>
              </template>

              <!-- Action buttons: manual -->
              <div v-if="section.key === 'manual'" class="action-group">
                <button
                  class="tg-button tg-button-primary"
                  :disabled="Boolean(adminBusyKey)"
                  @click="emit('approve', item)"
                >
                  {{ adminBusyKey === `approve:${item.request_id}` ? '处理中…' : '通过' }}
                </button>
                <button
                  class="tg-button tg-button-secondary"
                  :disabled="Boolean(adminBusyKey)"
                  @click="emit('approve-enable', item)"
                >
                  {{ adminBusyKey === `approve_on:${item.request_id}` ? '处理中…' : '通过并启用' }}
                </button>
                <button
                  class="tg-button tg-button-secondary"
                  :disabled="Boolean(adminBusyKey)"
                  @click="emit('ai-review', item)"
                >
                  {{ adminBusyKey === `ai_review:${item.request_id}` ? '处理中…' : 'AI 审核' }}
                </button>
                <button
                  class="tg-button tg-button-danger"
                  :disabled="Boolean(adminBusyKey)"
                  @click="onReject(item)"
                >
                  {{ adminBusyKey === `reject:${item.request_id}` ? '处理中…' : '拒绝' }}
                </button>
              </div>

              <!-- Action buttons: groups -->
              <div v-if="section.key === 'groups'" class="action-group">
                <button
                  class="tg-button tg-button-secondary"
                  :disabled="Boolean(adminBusyKey)"
                  @click="emit('check-group-permissions', item)"
                >
                  检查 Bot 权限
                </button>
                <button
                  class="tg-button tg-button-plain"
                  :disabled="Boolean(adminBusyKey)"
                  @click="onToggleGroup(item)"
                >
                  {{ adminBusyKey === `toggle:${item.chat_id}` ? '处理中…' : item.enabled ? '关闭' : '启用' }}
                </button>
                <button
                  class="tg-button tg-button-danger"
                  :disabled="Boolean(adminBusyKey)"
                  @click="onRemoveGroup(item)"
                >
                  {{ adminBusyKey === `remove:${item.chat_id}` ? '处理中…' : '移除' }}
                </button>
              </div>
            </section>
          </template>
        </template>
      </template>
    </template>
  </template>

  <!-- Admin feedback -->
  <div v-if="adminMessage" :class="['tg-banner', `tg-banner-${adminTone}`]">
    {{ adminMessage }}
  </div>
</template>

<style scoped>
.admin-review-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-right: 16px;
}

.admin-review-title {
  flex: 1;
  margin-bottom: 0;
  padding-bottom: 0;
}

.admin-refresh-btn {
  flex-shrink: 0;
  border: none;
  background: color-mix(in srgb, var(--tg-theme-button-color, #007aff) 14%, transparent);
  color: var(--tg-theme-button-color, #007aff);
  font-size: 14px;
  font-weight: 600;
  padding: 6px 12px;
  border-radius: 8px;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}

.admin-refresh-btn:active {
  opacity: 0.7;
}

.section-label-stack {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  text-align: left;
  min-width: 0;
}

.section-subtitle {
  display: block;
  font-size: 12px;
  font-weight: 400;
  color: var(--tg-theme-hint-color, #8e8e93);
  line-height: 1.35;
  white-space: normal;
}

.section-toggle {
  background: none;
  border: none;
  cursor: pointer;
  width: 100%;
  -webkit-tap-highlight-color: transparent;
}

.section-toggle:active {
  background: color-mix(in srgb, var(--tg-theme-hint-color, #8e8e93) 8%, transparent);
}

.section-count {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--tg-theme-hint-color, #8e8e93);
}

.section-count-num {
  font-size: 15px;
  font-weight: 600;
  color: var(--tg-theme-accent-text-color, var(--tg-theme-link-color, #007aff));
}

.section-arrow {
  font-size: 18px;
  font-weight: 600;
  transition: transform 0.2s ease;
  color: var(--tg-theme-hint-color, #8e8e93);
}

.section-arrow-open {
  transform: rotate(90deg);
}

.submitter-label {
  color: var(--tg-theme-text-color, #000000);
  font-weight: 600;
}

.submitter-value {
  color: var(--tg-theme-text-color, #000000) !important;
  font-weight: 500;
  text-align: right;
}

.record-section {
  margin-top: 6px;
}

.record-title {
  font-size: 15px;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.record-time {
  font-size: 13px;
  flex-shrink: 0;
}

.reason-toggle {
  border: none;
  background: transparent;
  color: var(--tg-theme-link-color, #007aff);
  font-size: 13px;
  cursor: pointer;
  padding: 0;
}

.reason-text {
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
}

.action-group {
  display: grid;
  gap: 8px;
  padding: 10px 16px 14px;
}

.status-on {
  color: #34c759;
  font-weight: 600;
}

.status-off {
  color: var(--tg-theme-hint-color, #8e8e93);
}

.perm-false {
  color: var(--tg-theme-destructive-text-color, #ff3b30);
  font-weight: 600;
}
</style>
