<script setup>
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
const AdminReviewPanel = defineAsyncComponent(() => import('./components/AdminReviewPanel.vue'));
const HealthStatusPanel = defineAsyncComponent(() => import('./components/HealthStatusPanel.vue'));
const ModelStatusBar = defineAsyncComponent(() => import('./components/ModelStatusBar.vue'));
const ModelRoutingPanel = defineAsyncComponent(() => import('./components/ModelRoutingPanel.vue'));
import { normalizeGroupIdInput } from './lib/permissions';

const API_URL = '/miniapp_api';
const tg = window.Telegram?.WebApp ?? null;

/** 静默轮询间隔：列表与「我的申请」在后台自动对齐服务端 */
const AUTO_REFRESH_INTERVAL_MS = 45_000;

const activeTab = ref('apply');
const revealStep = ref(1); // header visible immediately

let autoRefreshTimer = null;
let silentRefreshInFlight = false;

const errorMessages = {
  invalid_init_data: '登录状态失效，请回到 Telegram 后重新打开。',
  managed_allowlist_disabled: '名单审核未开启，暂无法提交。',
  invalid_chat_id: '群编号格式不对，请填数字（可只填 10 位后缀，也可填完整的 -100… 形式）。',
  chat_id_must_not_be_bot_id: '不能填机器人的数字 ID。请填群的 chat_id（在群里打开本 Mini App 可自动带上，或从群资料里查看）。',
  missing_chat_id: '没有拿到群编号，请手动填写目标群的 chat_id。',
  submitter_not_admin: '提交失败：只有群管理员或群主才能申请。',
  bot_not_in_group: 'Bot 不在目标群里，请先把机器人拉进群里再重试。',
  telegram_unavailable: '暂时无法向 Telegram 校验群成员状态，请稍后再试。',
  redis_unavailable: '服务暂时不可用，请稍后再试。',
  redis_error: '服务正在忙，请稍后再试。',
  rate_limited: '提交过于频繁，请稍后再试。',
  already_registered: '这个群已经通过审核，无需重复提交。',
  already_pending: '这个群已有待审核申请，请等待处理。',
  save_failed: '保存申请失败，请稍后再试。',
  missing_request_id: '缺少请求编号，请刷新后重试。',
  ai_failed: 'AI 审核暂时失败，请稍后再试。',
  ai_unparseable: 'AI 审核返回异常，请改为人工处理。',
  forbidden: '你没有权限执行这个操作。',
  request_failed: '请求失败，请稍后再试。',
  http_500: '服务器内部错误，请稍后再试或联系维护者。',
  http_502: '网关错误，请稍后再试。',
  http_503: '服务暂时不可用，请稍后再试。',
  unknown_action: '页面需要刷新，请关闭后重新打开。',
  invalid_provider_label: 'Provider 标签不合法，请使用字母数字和下划线/中划线。',
  missing_provider_fields: 'Provider 信息不完整，请补全 label/endpoint/model。',
  missing_provider_secret: '该 Provider 缺少密钥，请填写 API Key。',
  provider_unavailable: 'Provider 验证失败，请检查 endpoint/key/model 是否可用。',
  invalid_reply_main: '主模型未设置或不存在，请重新选择。',
  invalid_reply_backups: '备用模型包含无效项，请检查后重试。',
  invalid_allowlist_review_label: 'AI 审核模型无效，请重新选择。',
};

const state = reactive({
  loading: true,
  boot: null,
  mySubmissions: null,
  submitBusy: false,
  adminBusyKey: '',
  modelRoutingBusy: false,
  providerValidationResult: null,
  health: null,
  healthError: '',
  submitMessage: '',
  submitTone: 'info',
  adminMessage: '',
  adminTone: 'info',
  loadError: '',
});

const form = reactive({
  chatId: '',
  note: '',
});

const isMaster = computed(() => Boolean(state.boot?.is_master));
const managedEnabled = computed(() => Boolean(state.boot?.managed_enabled));
const manualQueue = computed(() => state.boot?.manual_queue ?? state.boot?.pending ?? []);
const aiApproved = computed(() => state.boot?.ai_approved ?? groups.value.filter((g) => g.review_state === 'auto_approved'));
const groups = computed(() => state.boot?.groups ?? []);
const modelRouting = computed(() => state.boot?.model_routing ?? null);
const suggestedChatId = computed(() => state.boot?.suggested_chat_id ?? '');
const suggestedChatTitle = computed(() => state.boot?.suggested_chat_title ?? '');

const isDirty = computed(() => {
  const note = String(form.note ?? '').trim();
  return normalizeGroupIdInput(form.chatId) !== '' || note !== '';
});

const chatIdHint = computed(() => {
  const raw = normalizeGroupIdInput(form.chatId);
  if (raw === '') return '';
  if (!/^-?\d+$/.test(raw)) {
    return '群编号只能包含数字（首位可为负号，如 -100…）。';
  }
  const digits = raw.replace(/^-/, '');
  if (digits.length < 5) {
    return '群编号过短，请填写完整的数字 ID。';
  }
  return '';
});

const mySubmissionRows = computed(() => {
  const m = state.mySubmissions;
  if (!m || isMaster.value) return [];
  const rows = [];
  for (const p of m.pending ?? []) {
    rows.push({ kind: 'pending', item: p, ts: (p.updated_at ?? p.created_at ?? 0) });
  }
  for (const r of m.reviewed ?? []) {
    rows.push({ kind: 'reviewed', item: r, ts: (r.updated_at ?? r.created_at ?? 0) });
  }
  for (const g of m.groups ?? []) {
    rows.push({ kind: 'group', item: g, ts: (g.updated_at ?? g.approved_at ?? 0) });
  }
  rows.sort((a, b) => b.ts - a.ts);
  return rows;
});

const canSubmit = computed(() => {
  if (state.submitBusy || !managedEnabled.value) return false;
  const norm = normalizeGroupIdInput(form.chatId);
  return norm !== '' && /^-?\d+$/.test(norm);
});

function haptic(type = 'impact', style = 'light') {
  try {
    if (type === 'impact') tg?.HapticFeedback?.impactOccurred?.(style);
    else if (type === 'notification') tg?.HapticFeedback?.notificationOccurred?.(style);
    else if (type === 'selection') tg?.HapticFeedback?.selectionChanged?.();
  } catch { /* ignore */ }
}

function applyThemeColors() {
  try {
    tg?.setHeaderColor?.('secondary_bg_color');
    tg?.setBackgroundColor?.('secondary_bg_color');
  } catch { /* ignore */ }
}

function setupTelegram() {
  tg?.ready?.();
  tg?.expand?.();
  applyThemeColors();
}

function onThemeChanged() {
  applyThemeColors();
}

function applySuggestedChatFromClient() {
  if (normalizeGroupIdInput(form.chatId)) return;

  const unsafeChat = tg?.initDataUnsafe?.chat;
  if (unsafeChat != null && unsafeChat.id != null) {
    const id = Number(unsafeChat.id);
    if (Number.isFinite(id) && id < 0) {
      form.chatId = String(id);
      return;
    }
  }

  const raw = tg?.initData;
  if (typeof raw !== 'string' || raw.length === 0) return;

  try {
    const params = new URLSearchParams(raw);
    const encoded = params.get('chat');
    if (!encoded) return;
    const obj = JSON.parse(encoded);
    const id = obj?.id;
    if (id != null && Number(id) < 0) form.chatId = String(id);
  } catch { /* ignore */ }
}

function parseError(data, httpStatus = 0) {
  let code = typeof data?.error === 'string' ? data.error : '';
  if (!code && httpStatus >= 400) code = `http_${httpStatus}`;
  if (!code) code = 'request_failed';
  const decision = typeof data?.decision === 'string' ? data.decision : '';
  return {
    code,
    decision,
    http_code: Number(data?.http_code || httpStatus || 0),
    latency_ms: Number(data?.latency_ms || 0),
    detail: typeof data?.detail === 'string' ? data.detail : '',
  };
}

function mapDecision(decision) {
  if (decision === 'APPROVE') return 'AI 建议通过。';
  if (decision === 'REJECT') return 'AI 建议拒绝。';
  return decision ? `AI 返回：${decision}` : '';
}

function mapError(error) {
  if (typeof error === 'string') return errorMessages[error] ?? error;
  const code = typeof error?.code === 'string' ? error.code : 'request_failed';
  const fallback = errorMessages[code] ?? code;
  const decision = mapDecision(error?.decision ?? '');
  return decision ? `${fallback} ${decision}` : fallback;
}

async function request(action, payload = {}) {
  const response = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      init_data: tg?.initData ?? '',
      ...payload,
    }),
  });

  let data = {};
  try { data = await response.json(); } catch { data = {}; }
  if (!response.ok || !data?.ok) throw parseError(data, response.status);
  return data;
}

async function loadMySubmissions() {
  if (isMaster.value) return;
  try {
    const data = await request('my_submissions');
    state.mySubmissions = data;
  } catch {
    state.mySubmissions = { pending: [], reviewed: [], groups: [] };
  }
}

async function mergeBootstrapData(data) {
  state.boot = data;
  applySuggestedChatFromClient();
  if (!normalizeGroupIdInput(form.chatId) && data.suggested_chat_id != null && data.suggested_chat_id !== '') {
    form.chatId = String(data.suggested_chat_id);
  }
  if (data.is_master) {
    state.mySubmissions = null;
  } else if (data.my_submissions && typeof data.my_submissions === 'object') {
    state.mySubmissions = data.my_submissions;
  } else {
    await loadMySubmissions();
  }
}

async function pullBootstrapAndMerge() {
  const data = await request('bootstrap');
  await mergeBootstrapData(data);
}

async function loadHealth() {
  try {
    const response = await fetch('/miniapp_api/health');
    if (!response.ok) throw new Error('health_unavailable');
    state.health = await response.json();
    state.healthError = '';
  } catch {
    state.healthError = '无法加载运行状态';
  }
}

function canSilentAutoRefresh() {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
  if (state.loading || state.submitBusy || state.adminBusyKey) return false;
  if (!state.boot) return false;
  return true;
}

async function silentRefreshBootstrap() {
  if (!canSilentAutoRefresh() || silentRefreshInFlight) return;
  silentRefreshInFlight = true;
  try {
    await pullBootstrapAndMerge();
    if (isMaster.value) await loadHealth();
    cloudSet(CACHE_KEY, state.boot);
    if (state.loadError) state.loadError = '';
  } catch {
    /* 保留当前界面，不打断用户 */
  } finally {
    silentRefreshInFlight = false;
  }
}

function startAutoRefresh() {
  stopAutoRefresh();
  autoRefreshTimer = window.setInterval(() => {
    silentRefreshBootstrap();
  }, AUTO_REFRESH_INTERVAL_MS);
}

function stopAutoRefresh() {
  if (autoRefreshTimer != null) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

function onVisibilityChange() {
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
    silentRefreshBootstrap();
  }
}


// ===== Telegram CloudStorage Cache =====
const CACHE_KEY = 'boot_cache';
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

function cloudGet(key) {
  return new Promise((resolve) => {
    try {
      tg?.CloudStorage?.getItem?.(key, (err, val) => {
        if (err || !val) return resolve(null);
        try {
          const obj = JSON.parse(val);
          if (obj._ts && Date.now() - obj._ts < CACHE_TTL_MS) {
            resolve(obj.data);
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
      // Fallback timeout in case callback never fires
      setTimeout(() => resolve(null), 200);
    } catch { resolve(null); }
  });
}

function cloudSet(key, data) {
  try {
    tg?.CloudStorage?.setItem?.(key, JSON.stringify({ _ts: Date.now(), data }));
  } catch { /* ignore */ }
}

async function loadBootstrap() {
  state.loading = true;
  state.loadError = '';

  // 1. Try cached data first for instant render
  const cached = await cloudGet(CACHE_KEY);
  if (cached) {
    await mergeBootstrapData(cached);
    state.loading = false;
    revealStep.value = 2;
    requestAnimationFrame(() => { revealStep.value = 3; });
    setTimeout(() => { revealStep.value = 4; }, 80);

    // 2. Refresh in background (silent)
    pullBootstrapAndMerge()
      .then(async () => {
        if (isMaster.value) await loadHealth();
        cloudSet(CACHE_KEY, state.boot);
      })
      .catch(() => {});
    return;
  }

  // 3. No cache: normal load
  try {
    await pullBootstrapAndMerge();
    if (isMaster.value) await loadHealth();
    cloudSet(CACHE_KEY, state.boot);
  } catch (error) {
    state.loadError = mapError(error);
  } finally {
    state.loading = false;
    revealStep.value = 2;
    requestAnimationFrame(() => { revealStep.value = 3; });
    setTimeout(() => { revealStep.value = 4; }, 80);
  }
}

async function submitApplication() {
  state.submitBusy = true;
  state.submitMessage = '';
  applySuggestedChatFromClient();

  const payload = { note: form.note };
  const norm = normalizeGroupIdInput(form.chatId);
  if (norm !== '') {
    if (!/^-?\d+$/.test(norm)) {
      state.submitTone = 'danger';
      state.submitMessage = errorMessages.invalid_chat_id;
      state.submitBusy = false;
      haptic('notification', 'error');
      return;
    }
    payload.chat_id = norm;
  }

  haptic('impact', 'medium');
  try {
    await request('submit', payload);
    form.note = '';
    state.submitTone = 'success';
    state.submitMessage = '已提交，可在后台查看。';
    haptic('notification', 'success');
    if (tg?.showPopup) {
      tg.showPopup({ title: '提交成功', message: '申请已提交，请等待审核。', buttons: [{ type: 'ok' }] });
    }
    if (!isMaster.value) {
      try {
        await pullBootstrapAndMerge();
      } catch {
        await loadMySubmissions();
      }
    }
  } catch (error) {
    state.submitTone = 'danger';
    state.submitMessage = mapError(error);
    haptic('notification', 'error');
  } finally {
    state.submitBusy = false;
    updateMainButton();
  }
}

function updateMainButton() {
  if (!tg?.MainButton) return;
  if (canSubmit.value) {
    tg.MainButton.setText(state.submitBusy ? '提交中…' : '提交申请');
    tg.MainButton.show();
    if (state.submitBusy) {
      tg.MainButton.showProgress();
      tg.MainButton.disable();
    } else {
      tg.MainButton.hideProgress();
      tg.MainButton.enable();
    }
  } else {
    tg.MainButton.hide();
  }
}

function onMainButtonClick() {
  if (canSubmit.value && !state.submitBusy) submitApplication();
}

async function runAdminAction(key, action, payload, successMessage) {
  state.adminBusyKey = key;
  state.adminMessage = '';
  haptic('impact', 'medium');
  try {
    const result = await request(action, payload);
    await pullBootstrapAndMerge();
    state.adminTone = 'success';
    state.adminMessage = successMessage + (result.decision ? ` ${mapDecision(result.decision)}` : '');
    haptic('notification', 'success');
  } catch (error) {
    state.adminTone = 'danger';
    state.adminMessage = mapError(error);
    haptic('notification', 'error');
  } finally {
    state.adminBusyKey = '';
  }
}

async function saveModelRouting(payload) {
  state.modelRoutingBusy = true;
  state.adminMessage = '';
  try {
    const res = await request('model_routing_save', payload);
    if (state.boot) state.boot.model_routing = res.model_routing ?? state.boot.model_routing;
    state.adminTone = 'success';
    state.adminMessage = '模型路由已保存。';
    haptic('notification', 'success');
    await onAdminRefresh();
  } catch (error) {
    state.adminTone = 'danger';
    state.adminMessage = mapError(error);
    haptic('notification', 'error');
  } finally {
    state.modelRoutingBusy = false;
  }
}

async function upsertProvider(payload) {
  state.modelRoutingBusy = true;
  state.adminMessage = '';
  state.providerValidationResult = null;
  try {
    const res = await request('provider_upsert', payload);
    if (state.boot) state.boot.model_routing = res.model_routing ?? state.boot.model_routing;
    state.adminTone = 'success';
    state.adminMessage = 'Provider 已保存。';
    haptic('notification', 'success');
    await onAdminRefresh();
  } catch (error) {
    state.adminTone = 'danger';
    state.adminMessage = mapError(error);
    haptic('notification', 'error');
  } finally {
    state.modelRoutingBusy = false;
  }
}

async function validateProvider(payload) {
  state.modelRoutingBusy = true;
  state.adminMessage = '';
  state.providerValidationResult = null;
  try {
    const res = await request('provider_validate', payload);
    const latency = Number(res.latency_ms || 0);
    state.providerValidationResult = {
      ok: true,
      httpCode: Number(res.http_code || 0),
      latencyMs: latency > 0 ? latency : 0,
      detail: '',
    };
    state.adminTone = 'success';
    state.adminMessage = `Provider 可用（HTTP ${res.http_code}，${latency}ms）`;
    haptic('notification', 'success');
  } catch (error) {
    state.providerValidationResult = {
      ok: false,
      httpCode: Number(error?.http_code || 0),
      latencyMs: Number(error?.latency_ms || 0),
      detail: String(error?.detail || mapError(error)),
    };
    state.adminTone = 'danger';
    state.adminMessage = mapError(error);
    haptic('notification', 'error');
  } finally {
    state.modelRoutingBusy = false;
  }
}


async function checkGroupPermissions(group) {
  const chatId = String(group?.chat_id ?? '');
  if (!chatId) return;
  state.adminMessage = '';
  haptic('impact', 'light');
  try {
    const data = await request('check_bot_permissions', { chat_id: chatId });
    const canSend = data.permissions?.can_send_messages;
    const statusText = data.permissions?.status || 'unknown';
    const sendText = canSend === true ? '可发消息' : (canSend === false ? '不可发消息' : '权限未知');
    state.adminTone = 'success';
    state.adminMessage = `群 ${group?.title || chatId}: ${statusText}，${sendText}`;
    haptic('notification', 'success');
  } catch (error) {
    state.adminTone = 'danger';
    state.adminMessage = mapError(error);
    haptic('notification', 'error');
  }
}

function formatTimestamp(ts) {
  if (!Number.isFinite(ts) || ts <= 0) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).format(new Date(ts * 1000));
}

function submissionLineTitle(row) {
  const it = row.item;
  if (row.kind === 'group') return it.title || String(it.chat_id ?? '');
  return it.chat_title || String(it.chat_id ?? '');
}

async function onAdminRefresh() {
  try {
    await pullBootstrapAndMerge();
    if (isMaster.value) await loadHealth();
    state.loadError = '';
  } catch (error) {
    state.adminTone = 'danger';
    state.adminMessage = mapError(error);
    haptic('notification', 'error');
  }
}

watch(() => form.chatId, (nextValue) => {
  updateMainButton();
});

watch(canSubmit, () => updateMainButton());
watch(() => state.submitBusy, () => updateMainButton());

watch(isDirty, (dirty) => {
  try {
    if (!tg) return;
    if (dirty) {
      tg.enableClosingConfirmation?.();
      tg.disableVerticalSwipes?.();
    } else {
      tg.disableClosingConfirmation?.();
      tg.enableVerticalSwipes?.();
    }
  } catch { /* ignore */ }
}, { immediate: true });

onMounted(async () => {
  setupTelegram();
  tg?.MainButton?.onClick?.(onMainButtonClick);
  tg?.onEvent?.('themeChanged', onThemeChanged);
  await nextTick();
  applySuggestedChatFromClient();
  await loadBootstrap();
  applySuggestedChatFromClient();
  setTimeout(() => applySuggestedChatFromClient(), 80);
  setTimeout(() => applySuggestedChatFromClient(), 400);
  updateMainButton();
  document.addEventListener('visibilitychange', onVisibilityChange);
  startAutoRefresh();
});

onUnmounted(() => {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  stopAutoRefresh();
  tg?.MainButton?.offClick?.(onMainButtonClick);
  tg?.offEvent?.('themeChanged', onThemeChanged);
  try {
    tg?.disableClosingConfirmation?.();
    tg?.enableVerticalSwipes?.();
  } catch { /* ignore */ }
});
</script>

<template>
  <main class="tg-page">
    <!-- Header -->
    <div class="tg-header-section">
      <h1 class="tg-page-title">白名单管理</h1>
      <div class="tg-status-row">
        <span :class="['tg-badge', managedEnabled ? 'tg-badge-active' : 'tg-badge-muted']">
          {{ managedEnabled ? '审核制' : '未启用' }}
        </span>
        <span :class="['tg-badge', isMaster ? 'tg-badge-accent' : 'tg-badge-muted']">
          {{ isMaster ? '管理员' : '申请者' }}
        </span>
        <span v-if="isMaster && manualQueue.length" class="tg-badge tg-badge-destructive">
          {{ manualQueue.length }} 待办
        </span>
      </div>
    </div>

    <!-- Loading -->
    <section v-if="state.loading" class="tg-section tg-skeleton-section">
      <div v-for="n in 4" :key="n" class="tg-cell tg-skeleton-cell">
        <span class="tg-skeleton-bar" :style="{ width: n === 1 ? '55%' : n === 2 ? '72%' : '88%' }" />
      </div>
    </section>

    <!-- Error -->
    <section v-else-if="state.loadError" class="tg-section">
      <div class="tg-section-header">无法完成初始化</div>
      <div class="tg-cell">
        <span class="tg-destructive">{{ state.loadError }}</span>
      </div>
    </section>

    <template v-else>
      <!-- ===== Tab: 申请 ===== -->
      <div v-show="activeTab === 'apply'" :class="{ 'reveal-in': revealStep >= 2 }">
      <!-- Submit Section -->
      <div class="tg-section-header">提交申请</div>
      <section class="tg-section">
        <div v-if="!managedEnabled" class="tg-cell">
          <span class="tg-hint">名单审核未开启，暂时无法提交。</span>
        </div>

        <div v-if="suggestedChatId" class="tg-cell tg-cell-multi">
          <div class="tg-cell-row">
            <span class="tg-cell-label">当前群</span>
            <span class="tg-cell-value">{{ suggestedChatId }}</span>
          </div>
          <span v-if="suggestedChatTitle" class="tg-cell-subtitle">{{ suggestedChatTitle }}</span>
        </div>

        <label class="tg-cell tg-cell-input">
          <span class="tg-cell-label">群号</span>
          <input
            v-model="form.chatId"
            type="text"
            inputmode="numeric"
            placeholder="10 位数字 / -100…"
            autocomplete="off"
          />
        </label>
        <div v-if="chatIdHint" class="tg-section-footer tg-chatid-hint">{{ chatIdHint }}</div>

        <label class="tg-cell tg-cell-input tg-cell-textarea">
          <span class="tg-cell-label">说明</span>
          <textarea
            v-model="form.note"
            rows="3"
            maxlength="500"
            placeholder="选填"
          ></textarea>
        </label>
      </section>
      <div v-if="!chatIdHint" class="tg-section-footer">填写群号后可点击底部按钮提交申请。</div>

      <!-- Inline submit for non-TG environments -->
      <section v-if="!tg?.MainButton" class="tg-section">
        <button
          class="tg-button-full"
          :disabled="!canSubmit || state.submitBusy"
          @click="submitApplication"
        >
          {{ state.submitBusy ? '提交中…' : '提交申请' }}
        </button>
      </section>

      <!-- Submit feedback -->
      <div v-if="state.submitMessage" :class="['tg-banner', `tg-banner-${state.submitTone}`]">
        {{ state.submitMessage }}
      </div>

      <!-- My submissions (applicants) -->
      <template v-if="!isMaster && state.mySubmissions">
        <div class="tg-section-header">我的申请</div>
        <section class="tg-section">
          <div v-if="!mySubmissionRows.length" class="tg-cell tg-cell-center">
            <span class="tg-hint">暂无提交记录。</span>
          </div>
          <template v-else>
            <div
              v-for="(row, idx) in mySubmissionRows"
              :key="`${row.kind}-${row.item.request_id ?? row.item.chat_id ?? idx}`"
              class="tg-cell tg-cell-multi tg-submission-cell"
            >
              <div class="tg-cell-row">
                <strong class="tg-submission-title">{{ submissionLineTitle(row) }}</strong>
                <span class="tg-cell-value tg-submission-cid">{{ row.item.chat_id }}</span>
              </div>
              <div class="tg-submission-badges">
                <template v-if="row.kind === 'pending'">
                  <span class="tg-badge tg-badge-muted">待审核</span>
                </template>
                <template v-else-if="row.kind === 'reviewed'">
                  <span class="tg-badge tg-badge-destructive">已拒绝</span>
                </template>
                <template v-else>
                  <span class="tg-badge tg-badge-active">已通过</span>
                  <span
                    :class="['tg-badge', row.item.enabled ? 'tg-badge-active' : 'tg-badge-muted']"
                  >
                    {{ row.item.enabled ? '已启用' : '未启用' }}
                  </span>
                </template>
              </div>
              <span class="tg-cell-subtitle">{{ formatTimestamp(row.ts) }}</span>
            </div>
          </template>
        </section>
      </template>

      </div>

      <!-- ===== Tab: 审核 ===== -->
      <div v-show="activeTab === 'review'" :class="{ 'reveal-in': revealStep >= 3 }">
      <!-- Admin Panel -->
      <AdminReviewPanel
        v-if="isMaster"
        :manual-queue="manualQueue"
        :ai-approved="aiApproved"
        :groups="groups"
        :admin-busy-key="state.adminBusyKey"
        :admin-message="state.adminMessage"
        :admin-tone="state.adminTone"
        @refresh="onAdminRefresh"
        @approve="(item) => runAdminAction(`approve:${item.request_id}`, 'approve', { request_id: item.request_id, enable_now: false }, '申请已通过。')"
        @approve-enable="(item) => runAdminAction(`approve_on:${item.request_id}`, 'approve', { request_id: item.request_id, enable_now: true }, '申请已通过并立即启用。')"
        @reject="(item) => runAdminAction(`reject:${item.request_id}`, 'reject', { request_id: item.request_id }, '申请已拒绝。')"
        @ai-review="(item) => runAdminAction(`ai_review:${item.request_id}`, 'ai_review', { request_id: item.request_id }, 'AI 审核已完成。')"
        @toggle-group="(group) => runAdminAction(`toggle:${group.chat_id}`, 'set_enabled', { chat_id: group.chat_id, enabled: !group.enabled }, group.enabled ? '机器人已关闭。' : '机器人已启用。')"
        @remove-group="(group) => runAdminAction(`remove:${group.chat_id}`, 'remove_group', { chat_id: group.chat_id }, '已从名单中移除该群。')"
        @check-group-permissions="checkGroupPermissions"
      />

      </div>

      <!-- ===== Tab: 设置 ===== -->
      <div v-show="activeTab === 'settings'" :class="{ 'reveal-in': revealStep >= 3 }">
      <ModelRoutingPanel
        v-if="isMaster && modelRouting"
        :model-routing="modelRouting"
        :busy="state.modelRoutingBusy"
        :validation-result="state.providerValidationResult"
        @save-routing="saveModelRouting"
        @upsert-provider="upsertProvider"
        @validate-provider="validateProvider"
      />

      <HealthStatusPanel
        v-if="isMaster"
        :health="state.health"
        :error="state.healthError"
      />

      <!-- Model Status -->
      <ModelStatusBar :init-data="tg?.initData ?? ''" />
      </div>
    </template>

    <!-- Bottom Tab Bar -->
    <nav class="tab-bar" :class="{ 'reveal-in': revealStep >= 4 }">
      <button
        :class="['tab-item', { 'tab-active': activeTab === 'apply' }]"
        @click="activeTab = 'apply'"
      >
        <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>
        <span>申请</span>
      </button>
      <button
        v-if="isMaster"
        :class="['tab-item', { 'tab-active': activeTab === 'review' }]"
        @click="activeTab = 'review'"
      >
        <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
        <span>审核</span>
        <span v-if="manualQueue.length" class="tab-badge">{{ manualQueue.length }}</span>
      </button>
      <button
        v-if="isMaster"
        :class="['tab-item', { 'tab-active': activeTab === 'settings' }]"
        @click="activeTab = 'settings'"
      >
        <svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        <span>设置</span>
      </button>
    </nav>
  </main>
</template>

<style>
*,
*::before,
*::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: -apple-system, 'SF Pro Text', 'Helvetica Neue', 'Noto Sans SC', sans-serif;
  font-size: 15px;
  line-height: 1.35;
  color: var(--tg-theme-text-color, #000000);
  background: var(--tg-theme-secondary-bg-color, #efeff4);
  -webkit-font-smoothing: antialiased;
  -webkit-text-size-adjust: 100%;
  -webkit-tap-highlight-color: transparent;
}

button, input, textarea {
  font: inherit;
  color: inherit;
}

.tg-page {
  max-width: 480px;
  margin: 0 auto;
  padding: 0 0 100px;
}

/* ── Header ── */
.tg-header-section {
  padding: 16px 16px 12px;
}

.tg-page-title {
  font-size: 28px;
  font-weight: 700;
  letter-spacing: -0.02em;
  margin-bottom: 10px;
}

.tg-status-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.tg-badge {
  display: inline-flex;
  align-items: center;
  padding: 3px 8px;
  border-radius: 10px;
  font-size: 13px;
  font-weight: 600;
}

.tg-badge-active {
  background: var(--tg-theme-button-color, #007aff);
  color: var(--tg-theme-button-text-color, #ffffff);
}

.tg-badge-accent {
  background: color-mix(in srgb, var(--tg-theme-accent-text-color, #007aff) 15%, transparent);
  color: var(--tg-theme-accent-text-color, #007aff);
}

.tg-badge-muted {
  background: color-mix(in srgb, var(--tg-theme-hint-color, #8e8e93) 15%, transparent);
  color: var(--tg-theme-hint-color, #8e8e93);
}

.tg-badge-destructive {
  background: color-mix(in srgb, var(--tg-theme-destructive-text-color, #ff3b30) 15%, transparent);
  color: var(--tg-theme-destructive-text-color, #ff3b30);
}

/* ── Section / Cell (Telegram native list style) ── */
.tg-section-header {
  padding: 8px 24px 6px;
  font-size: 13px;
  font-weight: 400;
  text-transform: uppercase;
  color: var(--tg-theme-section-header-text-color, var(--tg-theme-hint-color, #8e8e93));
}

.tg-section-footer {
  padding: 6px 24px 8px;
  font-size: 13px;
  color: var(--tg-theme-hint-color, #8e8e93);
}

.tg-section {
  background: var(--tg-theme-section-bg-color, var(--tg-theme-bg-color, #ffffff));
  border: 0.5px solid var(--tg-theme-section-separator-color, rgba(0,0,0,0.08));
  border-radius: 14px;
  margin: 0 12px;
  overflow: hidden;
}

.tg-section + .tg-section-header {
  margin-top: 24px;
}

.tg-section + .tg-section-footer {
  margin-top: 0;
}

.tg-section-footer + .tg-section-header {
  margin-top: 24px;
}

.tg-section + .tg-section {
  margin-top: 24px;
}

/* ── Cells ── */
.tg-cell {
  padding: 11px 16px;
  min-height: 44px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.tg-cell + .tg-cell {
  border-top: 0.5px solid var(--tg-theme-section-separator-color, rgba(0,0,0,0.08));
}

.tg-cell-center {
  justify-content: center;
}

.tg-cell-multi {
  flex-direction: column;
  align-items: stretch;
  gap: 2px;
}

.tg-cell-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.tg-cell-label {
  font-size: 15px;
  color: var(--tg-theme-text-color, #000000);
  flex-shrink: 0;
}

.tg-cell-value {
  font-size: 15px;
  color: var(--tg-theme-hint-color, #8e8e93);
  text-align: right;
  word-break: break-all;
}

.tg-cell-subtitle {
  font-size: 13px;
  color: var(--tg-theme-subtitle-text-color, var(--tg-theme-hint-color, #8e8e93));
}

/* ── Input cells ── */
.tg-cell-input {
  cursor: text;
  gap: 12px;
}

.tg-cell-input input,
.tg-cell-input textarea {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 15px;
  color: var(--tg-theme-text-color, #000000);
  text-align: right;
  min-width: 0;
}

.tg-cell-input input::placeholder,
.tg-cell-input textarea::placeholder {
  color: var(--tg-theme-hint-color, #8e8e93);
  opacity: 0.6;
}

.tg-cell-textarea {
  flex-direction: column;
  align-items: stretch;
  gap: 6px;
}

.tg-cell-textarea textarea {
  text-align: left;
  resize: vertical;
  min-height: 60px;
  line-height: 1.4;
}

/* ── Hint / destructive text ── */
.tg-hint {
  font-size: 15px;
  color: var(--tg-theme-hint-color, #8e8e93);
}

.tg-destructive {
  font-size: 15px;
  color: var(--tg-theme-destructive-text-color, #ff3b30);
}

/* ── Banner (feedback) ── */
.tg-banner {
  margin: 8px 12px;
  padding: 10px 14px;
  border-radius: 14px;
  font-size: 14px;
  line-height: 1.4;
}

.tg-banner-success {
  background: color-mix(in srgb, #34c759 12%, var(--tg-theme-bg-color, #ffffff));
  color: #248a3d;
}

.tg-banner-danger {
  background: color-mix(in srgb, var(--tg-theme-destructive-text-color, #ff3b30) 12%, var(--tg-theme-bg-color, #ffffff));
  color: var(--tg-theme-destructive-text-color, #ff3b30);
}

/* ── Full-width button (fallback when no MainButton) ── */
.tg-button-full {
  width: 100%;
  padding: 14px 16px;
  border: none;
  border-radius: 12px;
  background: var(--tg-theme-button-color, #007aff);
  color: var(--tg-theme-button-text-color, #ffffff);
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
}

.tg-button-full:disabled {
  opacity: 0.4;
  cursor: default;
}

.tg-button-full:active:not(:disabled) {
  opacity: 0.7;
}

/* ── Inline action buttons (admin, permission check) ── */
.tg-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 12px 16px;
  border: none;
  border-radius: 10px;
  font-size: 15px;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s;
}

.tg-button:disabled {
  opacity: 0.4;
  cursor: default;
}

.tg-button:active:not(:disabled) {
  opacity: 0.7;
}

.tg-button-primary {
  background: var(--tg-theme-button-color, #007aff);
  color: var(--tg-theme-button-text-color, #ffffff);
}

.tg-button-secondary {
  background: color-mix(in srgb, var(--tg-theme-button-color, #007aff) 12%, transparent);
  color: var(--tg-theme-button-color, #007aff);
}

.tg-button-danger {
  background: color-mix(in srgb, var(--tg-theme-destructive-text-color, #ff3b30) 12%, transparent);
  color: var(--tg-theme-destructive-text-color, #ff3b30);
}

.tg-button-plain {
  background: var(--tg-theme-bg-color, #ffffff);
  color: var(--tg-theme-text-color, #000000);
  border: 0.5px solid var(--tg-theme-section-separator-color, rgba(0,0,0,0.12));
}

/* ── Skeleton loading ── */
@keyframes tg-skeleton-pulse {
  0%,
  100% {
    opacity: 0.38;
  }
  50% {
    opacity: 0.72;
  }
}

.tg-skeleton-section .tg-skeleton-cell {
  min-height: 48px;
}

.tg-skeleton-bar {
  display: block;
  height: 13px;
  border-radius: 6px;
  max-width: 100%;
  background: var(--tg-theme-section-separator-color, rgba(0, 0, 0, 0.1));
  animation: tg-skeleton-pulse 0.8s ease-in-out infinite;
}

.tg-chatid-hint {
  color: var(--tg-theme-destructive-text-color, #ff3b30);
  padding-top: 0;
  margin-top: -4px;
}

.tg-submission-cell + .tg-submission-cell {
  border-top: 0.5px solid var(--tg-theme-section-separator-color, rgba(0, 0, 0, 0.08));
}

.tg-submission-title {
  font-size: 15px;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tg-submission-cid {
  flex-shrink: 0;
  max-width: 42%;
  word-break: break-all;
}

.tg-submission-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-self: flex-start;
}

/* ===== Bottom Tab Bar ===== */
.tg-page {
  padding-bottom: 72px;
}
.tab-bar {
  position: fixed;
  bottom: 0;
  left: 0;
  right: 0;
  display: flex;
  justify-content: space-around;
  align-items: center;
  height: 56px;
  background: var(--tg-theme-secondary-bg-color, #f2f2f7);
  border-top: 0.5px solid var(--tg-theme-section-separator-color, rgba(0,0,0,.12));
  border-radius: 18px 18px 0 0;
  z-index: 100;
  padding-bottom: env(safe-area-inset-bottom, 0);
}
.tab-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  border: none;
  background: none;
  color: var(--tg-theme-hint-color, #8e8e93);
  font-size: 10px;
  font-weight: 500;
  cursor: pointer;
  padding: 6px 16px;
  position: relative;
  transition: color .15s;
  -webkit-tap-highlight-color: transparent;
}
.tab-item.tab-active {
  color: var(--tg-theme-button-color, #007aff);
}
.tab-icon {
  width: 22px;
  height: 22px;
}
.tab-badge {
  position: absolute;
  top: 2px;
  right: 6px;
  min-width: 16px;
  height: 16px;
  line-height: 16px;
  text-align: center;
  font-size: 10px;
  font-weight: 700;
  color: #fff;
  background: var(--tg-theme-destructive-text-color, #ff3b30);
  border-radius: 8px;
  padding: 0 4px;
}

/* ===== Lightweight Animations ===== */
@keyframes fadeSlideUp {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}



/* Tab content transition */
[v-show] {
  transition: opacity .15s ease;
}

/* Button press effect */
.tg-button-full:active:not(:disabled),
.tab-item:active {
  transform: scale(0.97);
  transition: transform .1s ease;
}

/* Badge subtle bounce on appear */
.tg-badge {
  transition: transform .15s ease, opacity .15s ease;
}

/* Smooth skeleton pulse */
.tg-skeleton-bar {
  border-radius: 8px;
}

/* Section hover/touch feedback */
.tg-cell {
  transition: background-color .12s ease;
}


/* ===== Progressive Reveal ===== */
.tab-bar {
  opacity: 0;
  transform: translateY(6px);
}
.reveal-in {
  opacity: 1 !important;
  transform: translateY(0) !important;
  transition: opacity .12s ease-out, transform .12s ease-out;
}

/* Remove old section-level animation (replaced by progressive reveal) */
</style>
