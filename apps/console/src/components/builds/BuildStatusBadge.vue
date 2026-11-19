<script setup lang="ts">
import { computed } from 'vue';
import type { BuildStatus } from '@forgekit/contracts';

const props = defineProps<{
  status: BuildStatus;
}>();

const statusLabels: Record<BuildStatus, string> = {
  queued: '排队中',
  running: '构建中',
  succeeded: '成功',
  failed: '失败',
  canceled: '已取消',
  timed_out: '已超时',
};

const label = computed(() => statusLabels[props.status]);
</script>

<template>
  <span class="build-status-badge" :class="`build-status-badge--${status}`">
    {{ label }}
  </span>
</template>

<style scoped>
.build-status-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.15rem 0.6rem;
  border-radius: 999px;
  font-size: 0.85rem;
  line-height: 1.4;
  white-space: nowrap;
  border: 1px solid transparent;
}

.build-status-badge--queued {
  color: var(--build-status-queued-color, #fbbf24);
  background-color: var(--build-status-queued-bg, rgba(251, 191, 36, 0.1));
  border-color: var(--build-status-queued-border, rgba(251, 191, 36, 0.3));
}

.build-status-badge--running {
  color: var(--build-status-running-color, #38bdf8);
  background-color: var(--build-status-running-bg, rgba(56, 189, 248, 0.1));
  border-color: var(--build-status-running-border, rgba(56, 189, 248, 0.3));
}

.build-status-badge--succeeded {
  color: var(--build-status-succeeded-color, #34d399);
  background-color: var(--build-status-succeeded-bg, rgba(52, 211, 153, 0.1));
  border-color: var(--build-status-succeeded-border, rgba(52, 211, 153, 0.3));
}

.build-status-badge--failed {
  color: var(--build-status-failed-color, #f87171);
  background-color: var(--build-status-failed-bg, rgba(248, 113, 113, 0.1));
  border-color: var(--build-status-failed-border, rgba(248, 113, 113, 0.3));
}

.build-status-badge--canceled {
  color: var(--build-status-canceled-color, #9ca3af);
  background-color: var(--build-status-canceled-bg, rgba(156, 163, 175, 0.1));
  border-color: var(--build-status-canceled-border, rgba(156, 163, 175, 0.3));
}

.build-status-badge--timed_out {
  color: var(--build-status-timed-out-color, #fb923c);
  background-color: var(--build-status-timed-out-bg, rgba(251, 146, 60, 0.1));
  border-color: var(--build-status-timed-out-border, rgba(251, 146, 60, 0.3));
}
</style>
