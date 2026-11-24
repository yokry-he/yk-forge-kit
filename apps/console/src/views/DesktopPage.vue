<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useBuildProjectAccess } from '../composables/useBuildProjectAccess';
import TemplateIdentity from '../components/TemplateIdentity.vue';
// Serve the existing repository guide as a standalone asset in dev and production builds.
import desktopGuideUrl from '../../../../docs/zh-CN/templates/tauri-desktop.md?url';

const route = useRoute();
const slug = computed(() => String(route.params.slug ?? ''));
const { project, accessVerified, loading, error } = useBuildProjectAccess(slug);
</script>

<template>
  <div class="content desktop-page">
    <RouterLink class="inline-link" :to="{ name: 'project-detail', params: { slug } }">← 返回项目</RouterLink>
    <h1>桌面打包</h1>
    <p v-if="loading" role="status">正在验证项目权限…</p>
    <p v-if="error" class="state-card" role="alert">{{ error }}</p>
    <section v-if="project && accessVerified && project.template === 'tauri-desktop'" class="panel" aria-labelledby="desktop-setup-title">
      <TemplateIdentity :template="project.template" />
      <h2 id="desktop-setup-title">在线桌面打包即将推出</h2>
      <p>请先使用模板自带的 CLI 在本地打包。准备好 Rust 与目标系统的开发依赖后，在已生成的项目目录执行：</p>
      <pre class="command"><code>pnpm install
pnpm tauri build</code></pre>
      <p>安装包在目标系统上构建；Windows / macOS 也可使用生成项目中的构建工作流。控制台的前端构建不生成原生安装包。</p>
      <a class="primary-link" :href="desktopGuideUrl" target="_blank" rel="noopener noreferrer">查看 Tauri 桌面模板指南 ↗</a>
    </section>
    <p v-else-if="project && accessVerified" class="state-card">此页面适用于 Tauri 桌面项目，请返回项目查看可用功能。</p>
  </div>
</template>

<style scoped>
.desktop-page h2 { margin-top: 24px; }
.desktop-page .panel { min-height: 0; margin-top: 30px; }
.desktop-page .command code { white-space: pre-wrap; }
</style>
