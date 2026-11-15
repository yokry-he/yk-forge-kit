<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { HealthResponse } from '@forgekit/contracts';

const health = ref<HealthResponse | null>(null);
const error = ref('');

onMounted(async () => {
  try {
    const response = await fetch('/api/v1/health');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    health.value = (await response.json()) as HealthResponse;
  } catch {
    error.value = 'API 尚未连接，请确认服务已启动。';
  }
});
</script>

<template>
  <main class="shell">
    <div class="eyebrow">ForgeKit · Developer Workspace</div>
    <h1>让创造到发布，<span>自然衔接。</span></h1>
    <p>跨端项目、可组合资产与发布流水线，将在这里逐步汇聚。</p>
    <section class="panel" aria-label="系统状态">
      <div><strong>平台基础服务</strong><small>首个工程里程碑</small></div>
      <span v-if="health" class="status success">API 已连接 · {{ health.status }}</span>
      <span v-else-if="error" class="status warning">{{ error }}</span>
      <span v-else class="status">正在检查 API…</span>
    </section>
    <p class="footnote">目前仅提供工程骨架和健康检查，项目创建等业务功能尚未实现。</p>
  </main>
</template>
