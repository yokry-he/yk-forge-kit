<script setup lang="ts">
import { computed } from 'vue';
import type { Build } from '@forgekit/contracts';
import { diagnosisCopy } from './build-diagnosis-copy';

const props = defineProps<{ build: Pick<Build, 'status' | 'diagnosis'> }>();
const emit = defineEmits<{ viewLogs: [seqs: number[]] }>();
const copy = computed(() => diagnosisCopy(props.build.diagnosis?.category));
const seqs = computed(() => props.build.diagnosis?.matchedLogSeqs ?? []);
</script>

<template>
  <section v-if="build.status === 'failed' || build.status === 'timed_out'"
    class="build-detail-card build-diagnosis" aria-label="失败诊断">
    <header class="build-panel-header"><h2>失败诊断：{{ copy.title }}</h2></header>
    <p>{{ copy.cause }}</p>
    <ol><li v-for="step in copy.steps" :key="step">{{ step }}</li></ol>
    <pre v-if="build.diagnosis?.excerpt.length" aria-label="相关日志摘录">{{ build.diagnosis.excerpt.join('\n') }}</pre>
    <button type="button" class="subtle-button" @click="emit('viewLogs', seqs)">
      {{ seqs.length ? '查看相关日志行' : '查看完整日志' }}
    </button>
  </section>
</template>

<style scoped>
.build-diagnosis {
  --diagnosis-text: #e4e4e7;
  --diagnosis-muted: #c4c4cc;
  --diagnosis-bg: #18181b;
  --diagnosis-border: #52525b;
  color: var(--diagnosis-text);
  background: var(--diagnosis-bg);
  border-color: var(--diagnosis-border);
}
:global(html:not(.dark) .build-diagnosis) {
  --diagnosis-text: #18181b;
  --diagnosis-muted: #3f3f46;
  --diagnosis-bg: #fafafa;
  --diagnosis-border: #71717a;
}
.build-diagnosis .build-panel-header h2 { color: var(--diagnosis-text); }
.build-diagnosis p { color: var(--diagnosis-muted); }
.build-diagnosis ol { padding-left: 1.5rem; font-size: .875rem; line-height: 1.8; }
.build-diagnosis pre { white-space: pre-wrap; overflow-wrap: anywhere; font-size: .8125rem; }
.build-diagnosis .subtle-button { color: var(--diagnosis-text); background: var(--diagnosis-bg); border-color: var(--diagnosis-border); }
.build-diagnosis.build-detail-card .subtle-button:hover { color: var(--diagnosis-text); background: var(--diagnosis-bg); border-color: var(--diagnosis-text); }
.build-diagnosis .subtle-button:focus-visible { outline-color: var(--diagnosis-text); }
</style>
