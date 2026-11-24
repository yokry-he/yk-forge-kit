<script setup lang="ts">
import TemplateIdentity from '../components/TemplateIdentity.vue';
import { onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import type { ProjectRecord } from '@forgekit/contracts';
import { listProjects } from '../api/projects';

const projects = ref<ProjectRecord[]>([]);
const loading = ref(true);
const error = ref('');

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = '';
  try { projects.value = await listProjects(); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '项目加载失败。'; }
  finally { loading.value = false; }
}
onMounted(refresh);
</script>

<template>
  <div class="content">
    <div class="eyebrow">PROJECTS</div>
    <h1>我的<span>项目</span></h1>
    <p class="intro">统一查看已经登记的项目配置。源码生成仍由本地 CLI 完成。</p>
    <div class="section-toolbar">
      <span>项目记录</span>
      <div><RouterLink class="primary-link" to="/projects/new/beginner">新手模式</RouterLink><button type="button" class="subtle-button" :disabled="loading" @click="refresh">刷新</button><RouterLink class="primary-link" to="/projects/new">＋ 创建项目</RouterLink></div>
    </div>
    <section v-if="loading" class="state-card" role="status">正在加载项目列表…</section>
    <section v-else-if="error" class="state-card" role="alert"><strong>暂时无法加载</strong><p>{{ error }}</p><button class="subtle-button" @click="refresh">重试</button></section>
    <section v-else-if="!projects.length" class="state-card"><strong>这里还没有项目</strong><p>从创建向导选择模板和能力，保存第一条项目记录。</p><RouterLink class="primary-link" to="/projects/new">创建第一个项目</RouterLink></section>
    <div v-else class="project-grid">
      <RouterLink v-for="project in projects" :key="project.id" class="project-card" :to="`/projects/${encodeURIComponent(project.slug)}`">
        <div class="project-card-top"><TemplateIdentity :template="project.template" short /></div>
        <strong>{{ project.name }}</strong>
        <p>{{ project.features.length ? project.features.join(' · ') : '未启用可选能力' }}</p>
        <small>创建于 {{ new Date(project.createdAt).toLocaleString('zh-CN') }}</small>
      </RouterLink>
    </div>
  </div>
</template>
