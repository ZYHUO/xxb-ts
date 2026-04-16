<script setup>
import { computed, reactive } from 'vue';

const props = defineProps({
  modelRouting: { type: Object, default: null },
  busy: { type: Boolean, default: false },
  validationResult: { type: Object, default: null },
});

const emit = defineEmits(['validate-provider']);

const providerForm = reactive({
  endpoint: '',
  model: '',
  apiKey: '',
  apiFormat: 'openai',
  stream: false,
});

const usageRows = computed(() =>
  Object.entries(props.modelRouting?.effective ?? {}).map(([usage, config]) => ({
    usage,
    label: config?.label ?? '',
    backups: Array.isArray(config?.backups) ? config.backups : [],
    timeout: config?.timeout,
    maxTokens: config?.maxTokens,
    temperature: config?.temperature,
  })),
);

const providerRows = computed(() =>
  Object.entries(props.modelRouting?.providers ?? {}).map(([label, provider]) => ({
    label,
    endpoint: provider?.endpoint ?? '',
    model: provider?.model ?? '',
    apiFormat: provider?.api_format ?? 'openai',
    stream: Boolean(provider?.stream),
  })),
);

function formatUsage(row) {
  const parts = [`${row.label || '未配置'}`];
  if (row.backups.length) parts.push(`备援: ${row.backups.join(', ')}`);
  if (Number.isFinite(row.timeout)) parts.push(`超时 ${row.timeout}ms`);
  if (Number.isFinite(row.maxTokens)) parts.push(`maxTokens ${row.maxTokens}`);
  if (row.temperature !== undefined) parts.push(`temp ${row.temperature}`);
  return parts.join(' · ');
}

function onValidateProvider() {
  emit('validate-provider', {
    provider: {
      endpoint: providerForm.endpoint.trim(),
      model: providerForm.model.trim(),
      api_key: providerForm.apiKey,
      api_format: providerForm.apiFormat,
      stream: providerForm.stream,
    },
  });
}
</script>

<template>
  <div class="tg-section-header">模型路由（环境变量只读）</div>
  <div class="tg-section-footer mr-hint">
    运行时改路由已移除；此处仅展示当前生效配置，并保留 Provider 连通性验证。
  </div>

  <section class="tg-section">
    <div class="tg-cell tg-cell-multi mr-row" v-for="row in usageRows" :key="`usage-${row.usage}`">
      <div class="tg-cell-row">
        <span class="tg-cell-label">{{ row.usage }}</span>
        <span class="tg-cell-value">{{ row.label || '未配置' }}</span>
      </div>
      <span class="tg-cell-subtitle">{{ formatUsage(row) }}</span>
    </div>
    <div v-if="usageRows.length === 0" class="tg-cell tg-cell-center">
      <span class="tg-hint">未读取到 usage 路由。</span>
    </div>
  </section>

  <div class="tg-section-header">已加载 Providers</div>
  <section class="tg-section">
    <div class="tg-cell tg-cell-multi mr-row" v-for="row in providerRows" :key="`provider-${row.label}`">
      <div class="tg-cell-row">
        <span class="tg-cell-label">{{ row.label }}</span>
        <span class="tg-cell-value">{{ row.model || '未配置 model' }}</span>
      </div>
      <span class="tg-cell-subtitle">{{ row.endpoint }}</span>
      <span class="tg-cell-subtitle">{{ row.apiFormat }}<template v-if="row.stream"> · stream</template></span>
    </div>
    <div v-if="providerRows.length === 0" class="tg-cell tg-cell-center">
      <span class="tg-hint">未读取到 provider 配置。</span>
    </div>
  </section>

  <div class="tg-section-header">验证 Provider</div>
  <div class="tg-section-footer mr-hint">仅用于连通性检查，不会保存任何配置。</div>
  <section class="tg-section">
    <label class="tg-cell tg-cell-input mr-cell">
      <span class="tg-cell-label">Endpoint</span>
      <input v-model="providerForm.endpoint" class="mr-input" type="text" placeholder="https://.../v1" />
    </label>
    <label class="tg-cell tg-cell-input mr-cell">
      <span class="tg-cell-label">Model</span>
      <input v-model="providerForm.model" class="mr-input" type="text" placeholder="gpt-4o-mini" />
    </label>
    <label class="tg-cell tg-cell-input mr-cell">
      <span class="tg-cell-label">API Key</span>
      <input v-model="providerForm.apiKey" class="mr-input" type="password" placeholder="仅用于本次验证" />
    </label>
    <label class="tg-cell tg-cell-row mr-toggle">
      <span class="tg-cell-label">API 格式</span>
      <select v-model="providerForm.apiFormat" class="mr-select">
        <option value="openai">openai-compatible</option>
        <option value="claude">claude</option>
      </select>
    </label>
    <label class="tg-cell tg-cell-row mr-toggle">
      <span class="tg-cell-label">SSE stream</span>
      <input v-model="providerForm.stream" type="checkbox" />
    </label>
    <div class="tg-cell tg-cell-center">
      <button class="tg-button tg-button-plain" :disabled="busy" @click="onValidateProvider">
        {{ busy ? '处理中…' : '验证连通性' }}
      </button>
    </div>
    <div v-if="validationResult" :class="['mr-validation', validationResult.ok ? 'mr-validation-ok' : 'mr-validation-fail']">
      <strong>{{ validationResult.ok ? '验证通过' : '验证失败' }}</strong>
      <span v-if="validationResult.httpCode"> · HTTP {{ validationResult.httpCode }}</span>
      <span v-if="validationResult.latencyMs"> · {{ validationResult.latencyMs }}ms</span>
      <div v-if="validationResult.detail" class="mr-validation-detail">{{ validationResult.detail }}</div>
    </div>
  </section>
</template>

<style scoped>
.mr-hint {
  margin-top: -2px;
}

.mr-row {
  gap: 4px;
}

.mr-cell {
  gap: 10px;
}

.mr-toggle {
  justify-content: space-between;
}

.mr-input,
.mr-select {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  font-size: 15px;
  text-align: right;
  color: var(--tg-theme-text-color, #000000);
}

.mr-select {
  appearance: none;
}

.mr-input::placeholder {
  color: var(--tg-theme-hint-color, #8e8e93);
  opacity: 0.7;
}

.mr-validation {
  margin: 12px 14px 4px;
  padding: 12px 14px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.45;
}

.mr-validation-ok {
  background: color-mix(in srgb, var(--tg-theme-button-color, #2ea6ff) 14%, transparent);
  color: var(--tg-theme-text-color, #000000);
}

.mr-validation-fail {
  background: color-mix(in srgb, #ff3b30 14%, transparent);
  color: var(--tg-theme-text-color, #000000);
}

.mr-validation-detail {
  margin-top: 6px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
