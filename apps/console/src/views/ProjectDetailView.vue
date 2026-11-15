<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import type { ProjectRecord } from '@forgekit/contracts';
import { getProject } from '../api/projects';

const route = useRoute();
const project = ref<ProjectRecord | null>(null);
const error = ref('');
const loading = ref(true);

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = '';
  project.value = null;
  try { project.value = await getProject(String(route.params.slug)); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '项目读取失败。'; }
  finally { loading.value = false; }
}
onMounted(refresh);
watch(() => route.params.slug, refresh);
</script>

<template>
  <div class="content">
    <div class="eyebrow">PROJECT DETAILS</div>
    <h1>项目<span>详情</span></h1>
    <p class="intro"><RouterLink class="inline-link" to="/projects">← 返回项目列表</RouterLink></p>
    <section v-if="loading" class="state-card" role="status">正在读取项目配置…</section>
    <section v-else-if="error" class="state-card" role="alert"><strong>无法读取项目</strong><p>{{ error }}</p><button class="subtle-button" @click="refresh">重试</button></section>
    <section v-else-if="project" class="panel project-detail-panel">
      <div class="project-card-top"><span class="project-mark">V</span><span class="asset-tag verified">已保存元数据</span></div>
      <h2>{{ project.name }}</h2>
      <div class="summary">
        <div><span>项目 ID</span><strong>{{ project.id }}</strong></div>
        <div><span>模板</span><strong>{{ project.template }}</strong></div>
        <div><span>可选能力</span><strong>{{ project.features.join('、') || '无' }}</strong></div>
        <div><span>创建时间</span><strong>{{ new Date(project.createdAt).toLocaleString('zh-CN') }}</strong></div>
      </div>
      <div class="coming">此页面展示数据库中的项目配置，不代表已经在本机生成源码。源码创建仍需使用 CLI。</div>
    </section>
  </div>
</template>
