<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import type { ProjectAssetRecord, ProjectRecord } from '@forgekit/contracts';
import { listAssets } from '@forgekit/asset-core';
import { getProject } from '../api/projects';
import { listProjectAssets, planProjectAsset } from '../api/project-assets';

const route = useRoute();
const project = ref<ProjectRecord | null>(null);
const error = ref('');
const loading = ref(true);
const assets = ref<ProjectAssetRecord[]>([]);
const assetsError = ref('');
const assetsLoading = ref(false);
const planning = ref('');
const planMessage = ref('');
const catalog = listAssets().filter((asset) => asset.target.includes('vue-web'));

async function refreshAssets(slug: string): Promise<void> {
  assetsLoading.value = true;
  assetsError.value = '';
  try { assets.value = await listProjectAssets(slug); }
  catch (reason) { assetsError.value = reason instanceof Error ? reason.message : '资产计划加载失败。'; }
  finally { assetsLoading.value = false; }
}

async function planAsset(assetId: string): Promise<void> {
  if (!project.value || planning.value) return;
  planning.value = assetId;
  planMessage.value = '';
  assetsError.value = '';
  try {
    await planProjectAsset(project.value.slug, assetId);
    await refreshAssets(project.value.slug);
    planMessage.value = '资产安装计划已登记，尚未修改项目源码。';
  } catch (reason) { assetsError.value = reason instanceof Error ? reason.message : '登记失败。'; }
  finally { planning.value = ''; }
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = '';
  project.value = null;
  assets.value = [];
  planMessage.value = '';
  try {
    project.value = await getProject(String(route.params.slug));
    await refreshAssets(project.value.slug);
  }
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
    <section v-if="project" class="project-assets-panel">
      <div class="section-toolbar"><span>项目资产计划</span><button class="subtle-button" :disabled="assetsLoading" @click="refreshAssets(project.slug)">刷新</button></div>
      <p class="asset-help">这里登记准备集成的公共资产及其版本。<strong>登记不等于安装成功</strong>；实际文件修改仍需通过 CLI 执行并校验。</p>
      <p v-if="assetsError" class="form-error" role="alert">{{ assetsError }}</p>
      <p v-if="planMessage" class="form-success" role="status">{{ planMessage }}</p>
      <div v-if="assetsLoading" class="state-card" role="status">正在加载资产计划…</div>
      <div v-else-if="!assets.length" class="state-card compact-state">尚未登记额外资产安装计划。</div>
      <div v-else class="project-assets-list">
        <div v-for="item in assets" :key="item.id"><strong>{{ item.assetId }}</strong><small>v{{ item.version }}</small><span class="asset-tag" :class="{ verified: item.status === 'applied' }">{{ item.status === 'planned' ? '待执行' : '已确认安装' }}</span></div>
      </div>
      <h3>可选公共资产</h3>
      <div v-for="item in catalog" :key="item.id" class="asset-option-row">
        <div><strong>{{ item.name }}</strong><small>{{ item.description }} · v{{ item.version }}</small></div>
        <button class="subtle-button" :disabled="!!planning || assetsLoading || assets.some((asset) => asset.assetId === item.id)" @click="planAsset(item.id)">{{ planning === item.id ? '正在登记…' : assets.some((asset) => asset.assetId === item.id) ? '已登记' : '登记安装计划' }}</button>
      </div>
      <p class="asset-help">当前仅提供已实现安装器的官方主题资产；用户中心、大屏等资产仍在规划中。</p>
    </section>
  </div>
</template>
