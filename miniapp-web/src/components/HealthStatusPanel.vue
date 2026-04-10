<script setup>
import { computed } from 'vue';
import { formatHealthTimestamp, formatUptimeSeconds } from '../lib/health';

const props = defineProps({
  health: { type: Object, default: null },
  error: { type: String, default: '' },
});

const statusText = computed(() => {
  const status = props.health?.status;
  if (status === 'ok') return '正常';
  if (status === 'degraded') return '降级';
  if (status === 'error') return '故障';
  return '未知';
});

const statusClass = computed(() => {
  const status = props.health?.status;
  if (status === 'ok') return 'perm-true';
  if (status === 'degraded') return 'tg-hint';
  if (status === 'error') return 'perm-false';
  return '';
});
</script>

<template>
  <div class="tg-section-header">运行状态</div>
  <section class="tg-section">
    <div v-if="error" class="tg-cell">
      <span class="tg-destructive">{{ error }}</span>
    </div>
    <template v-else-if="health">
      <div class="tg-cell tg-cell-row">
        <span class="tg-cell-label">服务状态</span>
        <span :class="['tg-cell-value', statusClass]">{{ statusText }}</span>
      </div>
      <div class="tg-cell tg-cell-row">
        <span class="tg-cell-label">运行时长</span>
        <span class="tg-cell-value">{{ formatUptimeSeconds(health.uptime) }}</span>
      </div>
      <div class="tg-cell tg-cell-row">
        <span class="tg-cell-label">Redis</span>
        <span :class="['tg-cell-value', health.checks?.redis?.ok ? 'perm-true' : 'perm-false']">
          {{ health.checks?.redis?.ok ? `${health.checks?.redis?.latency_ms ?? 0}ms` : '异常' }}
        </span>
      </div>
      <div class="tg-cell tg-cell-row">
        <span class="tg-cell-label">SQLite</span>
        <span :class="['tg-cell-value', health.checks?.sqlite?.ok ? 'perm-true' : 'perm-false']">
          {{ health.checks?.sqlite?.ok ? '正常' : '异常' }}
        </span>
      </div>
      <div class="tg-cell tg-cell-row">
        <span class="tg-cell-label">更新时间</span>
        <span class="tg-cell-value">{{ formatHealthTimestamp(health.checks?.timestamp) }}</span>
      </div>
    </template>
    <div v-else class="tg-cell">
      <span class="tg-hint">暂无状态数据。</span>
    </div>
  </section>
</template>
