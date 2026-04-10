<script setup>
import { computed, reactive, watch } from 'vue';

const props = defineProps({
  modelRouting: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  validationResult: { type: Object, default: null },
});

const emit = defineEmits(['save-routing', 'upsert-provider', 'validate-provider']);

const form = reactive({
  replyMain: '',
  backup1: '',
  backup2: '',
  backup3: '',
  allowlistReviewLabel: '',
});

const providerForm = reactive({
  label: '',
  endpoint: '',
  model: '',
  apiKey: '',
});

const providerOptions = computed(() =>
  Object.entries(props.modelRouting?.providers ?? {}).map(([label, provider]) => ({
    label,
    ...provider,
  }))
);
const providerMap = computed(() => {
  const out = {};
  for (const p of providerOptions.value) out[p.label] = p;
  return out;
});
const picker = reactive({
  open: false,
  field: '',
  title: '',
  allowEmpty: false,
  endpoint: '',
});

watch(
  () => props.modelRouting,
  (next) => {
    if (!next) return;
    form.replyMain = next.effective?.reply?.label ?? 'reply';
    const backups = next.effective?.reply?.backups ?? ['reply_pro'];
    form.backup1 = backups[0] ?? '';
    form.backup2 = backups[1] ?? '';
    form.backup3 = backups[2] ?? '';
    form.allowlistReviewLabel = next.effective?.allowlist_review?.label ?? 'allowlist_review';
  },
  { immediate: true, deep: true }
);

function onSaveRouting() {
  emit('save-routing', {
    usage: {
      reply: {
        label: form.replyMain,
        backups: [form.backup1, form.backup2, form.backup3].filter(Boolean),
      },
      allowlist_review: {
        label: form.allowlistReviewLabel,
      },
    },
  });
}

function providerText(label) {
  if (!label) return '不启用';
  const p = providerMap.value[label];
  if (!p) return label;
  return `${p.label} · ${p.model}`;
}

function openPicker(field, options = {}) {
  const { allowEmpty = false, title = '选择模型' } = options;
  picker.open = true;
  picker.field = field;
  picker.title = title;
  picker.allowEmpty = allowEmpty;
  picker.endpoint = '';
}

function closePicker() {
  picker.open = false;
  picker.field = '';
  picker.title = '';
  picker.allowEmpty = false;
  picker.endpoint = '';
}

function selectEndpoint(endpoint) {
  picker.endpoint = endpoint;
}

function applyPickerValue(value) {
  if (!picker.field) return;
  form[picker.field] = value;
  closePicker();
}

const endpointGroups = computed(() => {
  const map = {};
  for (const p of providerOptions.value) {
    const endpoint = p.endpoint || '(empty)';
    if (!map[endpoint]) map[endpoint] = [];
    map[endpoint].push(p);
  }
  return Object.entries(map).map(([endpoint, providers]) => ({ endpoint, providers }));
});
const pickerModels = computed(() => {
  if (!picker.endpoint) return [];
  const group = endpointGroups.value.find((g) => g.endpoint === picker.endpoint);
  if (!group) return [];
  return group.providers.map((p) => ({ id: p.label, model: p.model, endpoint: p.endpoint }));
});

function onUpsertProvider() {
  emit('upsert-provider', {
    label: providerForm.label.trim(),
    provider: {
      endpoint: providerForm.endpoint.trim(),
      model: providerForm.model.trim(),
      api_key: providerForm.apiKey,
    },
  });
  providerForm.apiKey = '';
}

function onValidateProvider() {
  emit('validate-provider', {
    provider: {
      endpoint: providerForm.endpoint.trim(),
      model: providerForm.model.trim(),
      api_key: providerForm.apiKey,
    },
  });
}
</script>

<template>
  <div class="tg-section-header">模型路由配置（仅管理员）</div>
  <div class="tg-section-footer mr-hint">主/备模型与 AI 审核模型都可在这里调整。</div>
  <section class="tg-section">
    <button class="tg-cell tg-cell-row mr-picker" @click="openPicker('replyMain', { title: '选择 Main 模型' })">
      <span class="tg-cell-label">Main</span>
      <span class="tg-cell-value mr-picker-value">{{ providerText(form.replyMain) }}</span>
    </button>

    <button class="tg-cell tg-cell-row mr-picker" @click="openPicker('backup1', { allowEmpty: true, title: '选择 Backup 1' })">
      <span class="tg-cell-label">Backup 1</span>
      <span class="tg-cell-value mr-picker-value">{{ providerText(form.backup1) }}</span>
    </button>

    <button class="tg-cell tg-cell-row mr-picker" @click="openPicker('backup2', { allowEmpty: true, title: '选择 Backup 2' })">
      <span class="tg-cell-label">Backup 2</span>
      <span class="tg-cell-value mr-picker-value">{{ providerText(form.backup2) }}</span>
    </button>

    <button class="tg-cell tg-cell-row mr-picker" @click="openPicker('backup3', { allowEmpty: true, title: '选择 Backup 3' })">
      <span class="tg-cell-label">Backup 3</span>
      <span class="tg-cell-value mr-picker-value">{{ providerText(form.backup3) }}</span>
    </button>

    <button class="tg-cell tg-cell-row mr-picker" @click="openPicker('allowlistReviewLabel', { title: '选择 AI 审核模型' })">
      <span class="tg-cell-label">AI审核</span>
      <span class="tg-cell-value mr-picker-value">{{ providerText(form.allowlistReviewLabel) }}</span>
    </button>
    <div class="tg-cell tg-cell-center">
      <button class="tg-button tg-button-primary" :disabled="busy" @click="onSaveRouting">
        {{ busy ? '保存中…' : '保存路由' }}
      </button>
    </div>
  </section>

  <div class="tg-section-header">新增/更新 Provider</div>
  <div class="tg-section-footer mr-hint">API Key 仅写入，不会在页面回显。</div>
  <section class="tg-section">
    <label class="tg-cell tg-cell-input mr-cell">
      <span class="tg-cell-label">Label</span>
      <input v-model="providerForm.label" class="mr-input" type="text" placeholder="例如 openrouter_flash" />
    </label>
    <label class="tg-cell tg-cell-input mr-cell">
      <span class="tg-cell-label">Endpoint</span>
      <input v-model="providerForm.endpoint" class="mr-input" type="text" placeholder="https://.../chat/completions" />
    </label>
    <label class="tg-cell tg-cell-input mr-cell">
      <span class="tg-cell-label">Model</span>
      <input v-model="providerForm.model" class="mr-input" type="text" placeholder="gpt-5.4 / gemini-2.5-flash..." />
    </label>
    <label class="tg-cell tg-cell-input mr-cell">
      <span class="tg-cell-label">API Key</span>
      <input v-model="providerForm.apiKey" class="mr-input" type="password" placeholder="仅写入，不回显" />
    </label>
    <div class="tg-cell tg-cell-center">
      <button class="tg-button tg-button-plain" :disabled="busy" @click="onValidateProvider">
        {{ busy ? '处理中…' : '先验证可用性' }}
      </button>
    </div>
    <div class="tg-cell tg-cell-center">
      <button class="tg-button tg-button-secondary" :disabled="busy" @click="onUpsertProvider">
        {{ busy ? '处理中…' : '保存 Provider' }}
      </button>
    </div>
    <div v-if="validationResult" :class="['mr-validation', validationResult.ok ? 'mr-validation-ok' : 'mr-validation-fail']">
      <strong>{{ validationResult.ok ? '验证通过' : '验证失败' }}</strong>
      <span v-if="validationResult.httpCode"> · HTTP {{ validationResult.httpCode }}</span>
      <span v-if="validationResult.latencyMs"> · {{ validationResult.latencyMs }}ms</span>
      <div v-if="validationResult.detail" class="mr-validation-detail">{{ validationResult.detail }}</div>
    </div>
  </section>

  <div v-if="picker.open" class="mr-overlay" @click.self="closePicker">
    <div class="mr-sheet">
      <div class="mr-sheet-head">
        <strong>{{ picker.title }}</strong>
        <button class="mr-close" @click="closePicker">关闭</button>
      </div>
      <div v-if="!picker.endpoint" class="mr-sheet-body">
        <button
          v-if="picker.allowEmpty"
          class="mr-opt"
          @click="applyPickerValue('')"
        >不启用</button>
        <button
          v-for="g in endpointGroups"
          :key="`ep-${g.endpoint}`"
          class="mr-opt"
          @click="selectEndpoint(g.endpoint)"
        >
          <span class="mr-opt-main">{{ g.endpoint }}</span>
          <span class="mr-opt-sub">{{ g.providers.length }} 个模型</span>
        </button>
      </div>
      <div v-else class="mr-sheet-body">
        <button class="mr-back" @click="picker.endpoint = ''">‹ 返回 API 地址</button>
        <button
          v-for="m in pickerModels"
          :key="`m-${m.id}`"
          class="mr-opt"
          @click="applyPickerValue(m.id)"
        >
          <span class="mr-opt-main">{{ m.model }}</span>
          <span class="mr-opt-sub">{{ m.id }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mr-hint {
  margin-top: -2px;
}

.mr-cell {
  gap: 10px;
}

.mr-picker {
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.mr-picker:active {
  background: color-mix(in srgb, var(--tg-theme-hint-color, #8e8e93) 8%, transparent);
}

.mr-picker-value {
  max-width: 64%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mr-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 15px;
  text-align: right;
  color: var(--tg-theme-text-color, #000000);
}

.mr-input::placeholder {
  color: var(--tg-theme-hint-color, #8e8e93);
  opacity: 0.7;
}

.mr-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  z-index: 1200;
  display: flex;
  align-items: flex-end;
}

.mr-sheet {
  width: 100%;
  max-height: 72vh;
  background: var(--tg-theme-bg-color, #ffffff);
  border-top-left-radius: 14px;
  border-top-right-radius: 14px;
  overflow: hidden;
}

.mr-sheet-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  border-bottom: 0.5px solid var(--tg-theme-section-separator-color, rgba(0, 0, 0, 0.08));
}

.mr-close {
  border: none;
  background: transparent;
  color: var(--tg-theme-link-color, #007aff);
  font-size: 14px;
}

.mr-sheet-body {
  max-height: calc(72vh - 52px);
  overflow: auto;
  padding-bottom: 12px;
}

.mr-opt {
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  padding: 12px 16px;
  border-bottom: 0.5px solid var(--tg-theme-section-separator-color, rgba(0, 0, 0, 0.08));
}

.mr-opt-main {
  display: block;
  font-size: 15px;
  color: var(--tg-theme-text-color, #000);
}

.mr-opt-sub {
  display: block;
  margin-top: 2px;
  font-size: 12px;
  color: var(--tg-theme-hint-color, #8e8e93);
  word-break: break-all;
}

.mr-back {
  border: none;
  background: transparent;
  color: var(--tg-theme-link-color, #007aff);
  padding: 10px 16px;
  font-size: 14px;
}

.mr-validation {
  margin: 8px 12px 12px;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.45;
}

.mr-validation-ok {
  background: color-mix(in srgb, #34c759 14%, var(--tg-theme-bg-color, #fff));
  color: #248a3d;
}

.mr-validation-fail {
  background: color-mix(in srgb, var(--tg-theme-destructive-text-color, #ff3b30) 12%, var(--tg-theme-bg-color, #fff));
  color: var(--tg-theme-destructive-text-color, #ff3b30);
}

.mr-validation-detail {
  margin-top: 4px;
  word-break: break-word;
}
</style>
