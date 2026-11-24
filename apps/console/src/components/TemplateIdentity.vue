<script setup lang="ts">
import { computed } from 'vue';
import { getTemplateVisual } from '../utils/template-visuals';

const props = defineProps<{ template: string; short?: boolean }>();
const visual = computed(() => getTemplateVisual(props.template));
</script>

<template>
  <span class="template-identity" :data-template="visual.id" :style="{ '--template-color': visual.color, '--template-background': visual.background }">
    <span class="template-mark" aria-hidden="true">{{ visual.icon }}</span>
    <span class="template-label">{{ short ? visual.shortName : visual.label }}</span>
  </span>
</template>

<style scoped>
.template-identity { display: inline-flex; gap: 12px; align-items: center; min-width: 0; color: var(--template-color); }
.template-mark { display: inline-grid; place-items: center; flex: 0 0 40px; width: 40px; height: 40px; border-radius: 10px; color: var(--template-color); background: var(--template-background); font-size: 24px; font-weight: 800; }
.template-label { font-size: 13px; overflow-wrap: anywhere; }
</style>
