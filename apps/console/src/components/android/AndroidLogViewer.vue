<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from 'vue';
import type { AndroidJob, BuildLogChunk, AndroidStreamEnd } from '@forgekit/contracts';
import { useAndroidLogStream } from '../../composables/useAndroidLogStream';

const props = defineProps<{ projectId: string; jobId: string }>();
const emit = defineEmits<{
  status: [job: AndroidJob];
  end: [event: AndroidStreamEnd];
  unauthorized: [];
  forbidden: [];
}>();

const projectIdRef = toRef(props, 'projectId');
const jobIdRef = toRef(props, 'jobId');

const {
  chunks,
  state,
  error,
  truncated,
  job,
  end,
  accessError,
  reconnect,
} = useAndroidLogStream(projectIdRef, jobIdRef);

const autoScroll = ref(true);
const logContainer = ref<HTMLElement | null>(null);

watch(() => chunks.value.at(-1)?.seq ?? 0, async () => {
  if (autoScroll.value) {
    await nextTick();
    if (logContainer.value) logContainer.value.scrollTop = logContainer.value.scrollHeight;
  }
}, { immediate: true });

watch(accessError, (err) => {
  if (err === 401) {
    emit('unauthorized');
  } else if (err === 403 || err === 404) {
    emit('forbidden');
  }
});

watch(job, (b) => {
  if (b) emit('status', b);
});

watch(end, (e) => {
  if (e) emit('end', e);
});

const stateText = computed(() => {
  switch (state.value) {
    case 'connecting':
      return '连接中…';
    case 'connected':
      return '已连接';
    case 'reconnecting':
      return '重新连接中…';
    case 'ended':
      return '已结束';
    case 'error':
      return '连接错误';
    case 'closed':
      return '已关闭';
    default:
      return '';
  }
});

const reconnectLabel = computed(() => {
  if (state.value === 'ended') return '刷新日志';
  if (state.value === 'error' || state.value === 'closed') return '重新连接';
  return '刷新日志';
});

function streamLabel(stream: BuildLogChunk['stream']): string {
  switch (stream) {
    case 'stdout':
      return '标准输出';
    case 'stderr':
      return '标准错误';
    case 'system':
      return '系统';
    default:
      return stream;
  }
}

function formatTime(ts: string): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
</script>

<template>
  <section class="build-log-viewer" aria-label="Android 打包任务日志">
    <div class="build-log-toolbar">
      <span class="build-log-status" role="status">{{ stateText }}</span>
      <span v-if="error" class="build-log-error" role="alert">{{ error }}</span>
      <label class="build-log-autoscroll">
        <input v-model="autoScroll" type="checkbox" />
        自动滚动
      </label>
      <button
        type="button"
        class="build-log-reconnect"
        :disabled="state === 'connecting' || state === 'reconnecting'"
        @click="reconnect"
      >
        {{ reconnectLabel }}
      </button>
    </div>

    <div v-if="truncated" class="build-log-truncated" role="status">仅显示最近日志</div>

    <div
      ref="logContainer"
      class="build-log-container"
      tabindex="0"
      role="region"
      aria-label="Android 打包任务日志内容"
    >
      <pre v-if="chunks.length > 0" class="build-log-list"><span
        v-for="chunk in chunks" :key="chunk.seq"
        class="build-log-entry" :class="`build-log-${chunk.stream}`"
        :title="`${streamLabel(chunk.stream)} · ${formatTime(chunk.ts)}`"
        role="group" :aria-label="streamLabel(chunk.stream)"
      >{{ chunk.content }}</span></pre>
      <p v-else class="build-log-empty">暂无日志。</p>
    </div>
  </section>
</template>

<style scoped>
.build-log-viewer {
  --build-log-bg: #09090b;
  --build-log-panel: #18181b;
  --build-log-accent: #8b5cf6;
  --build-log-cyan: #22d3ee;
  --build-log-stdout: #d4d4d8;
  --build-log-stderr: #f87171;
  --build-log-system: #22d3ee;
  margin-top: 1.5rem;
  font-family: inherit;
}

.build-log-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

.build-log-status {
  font-weight: 500;
  color: var(--build-log-cyan);
}

.build-log-error {
  color: var(--build-log-stderr);
}

.build-log-autoscroll {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  margin-left: auto;
}

.build-log-reconnect {
  background: var(--build-log-panel);
  color: #e4e4e7;
  border: 1px solid #3f3f46;
  border-radius: 0.375rem;
  padding: 0.25rem 0.75rem;
  cursor: pointer;
}

.build-log-reconnect:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.build-log-truncated {
  background: #27272a;
  color: #a1a1aa;
  padding: 0.375rem 0.75rem;
  margin-bottom: 0.5rem;
  border-radius: 0.25rem;
}

.build-log-container {
  background: var(--build-log-bg);
  border: 1px solid #27272a;
  border-radius: 0.5rem;
  padding: 0.75rem;
  max-height: 600px;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  font-size: 0.875rem;
  line-height: 1.5;
  outline: none;
}

.build-log-container:focus-visible {
  border-color: var(--build-log-accent);
  box-shadow: 0 0 0 2px rgba(139, 92, 246, 0.4);
}

.build-log-list {
  list-style: none;
  margin: 0;
  padding: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
}

.build-log-entry {
  display: inline;
}

.build-log-stream {
  display: inline-block;
  min-width: 4rem;
  font-weight: 600;
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

.build-log-time {
  color: #71717a;
  margin-left: 0.5rem;
  font-size: 0.75rem;
}

.build-log-content {
  margin: 0.25rem 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
}

.build-log-stdout {
  color: var(--build-log-stdout);
}

.build-log-stderr {
  color: var(--build-log-stderr);
}

.build-log-system {
  color: var(--build-log-system);
  background-color: rgba(34, 211, 238, 0.08);
  border-radius: 0.25rem;

}

.build-log-empty {
  color: #71717a;
  margin: 1rem 0;
  text-align: center;
}
</style>
