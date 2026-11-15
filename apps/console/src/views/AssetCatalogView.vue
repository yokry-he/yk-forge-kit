<script setup lang="ts">
import { computed, ref } from 'vue';
import { emptyAssetLock, listAssets, planAssetInstall } from '@forgekit/asset-core';

const assets = listAssets();
const query = ref('');
const target = ref('all');
const selectedId = ref(assets[0]?.id ?? '');
const directory = ref('/path/to/my-app');
const message = ref('');

const filtered = computed(() => assets.filter((asset) => {
  const searchable = [asset.id, asset.name, asset.description, ...asset.provides].join(' ').toLowerCase();
  return searchable.includes(query.value.trim().toLowerCase()) &&
    (target.value === 'all' || asset.target.includes(target.value as 'vue-web'));
}));
const selected = computed(() => filtered.value.find((asset) => asset.id === selectedId.value) ?? filtered.value[0] ?? null);
const examplePlan = computed(() => {
  if (!selected.value) return null;
  return planAssetInstall(selected.value.id, 'vue-web', {
    'src/style.css': 'body { margin: 0; }\n',
    'src/forgekit/theme.css': null,
  }, emptyAssetLock());
});
function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}
const cliCommand = computed(() => selected.value
  ? `node packages/cli/dist/index.js asset plan ${selected.value.id} --dir ${shellQuote(directory.value.trim() || '/path/to/my-app')}`
  : '');
const installCommand = computed(() => cliCommand.value.replace(' asset plan ', ' asset add '));

async function copy(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); message.value = '命令已复制'; }
  catch { message.value = '复制失败，请手动选择命令'; }
}
</script>

<template>
  <div class="content assets-page">
    <div class="eyebrow">ASSET REGISTRY</div>
    <h1>可组合的<span>项目资产</span></h1>
    <p class="intro">浏览经过验证的能力模块，了解依赖与变更范围，再决定是否加入项目。</p>

    <div class="asset-toolbar">
      <label class="sr-only" for="asset-search">搜索资产</label>
      <input id="asset-search" v-model="query" type="search" placeholder="搜索名称、能力或资产 ID" />
      <label class="sr-only" for="asset-target">目标平台</label>
      <select id="asset-target" v-model="target"><option value="all">全部平台</option><option value="vue-web">Vue Web</option></select>
    </div>

    <div class="asset-layout">
      <section class="catalog" aria-label="可用资产">
        <div class="catalog-meta"><strong>官方资产</strong><span>{{ filtered.length }} 项可用</span></div>
        <button v-for="asset in filtered" :key="asset.id" class="asset-card" :class="{ picked: selected?.id === asset.id }" @click="selectedId = asset.id">
          <div class="asset-icon">◈</div>
          <div class="asset-card-content"><div class="asset-title">{{ asset.name }} <small>v{{ asset.version }}</small></div><p>{{ asset.description }}</p><span class="asset-tag">Vue Web</span><span class="asset-tag verified">官方内置</span></div>
        </button>
        <div v-if="!filtered.length" class="asset-empty">没有找到匹配的资产。试试其他关键词或平台。</div>
        <div class="roadmap"><strong>计划中的业务资产</strong><p>用户中心 · 权限管理 · 数据大屏 · 文件管理</p><small>尚未开放，具体实现以之后的版本为准。</small></div>
      </section>

      <section v-if="selected" class="asset-detail" aria-label="资产详情">
        <div class="detail-top"><span class="asset-tag verified">官方内置</span><span>v{{ selected.version }}</span></div>
        <h2>{{ selected.name }}</h2><p class="detail-desc">{{ selected.description }}</p>
        <dl class="asset-facts">
          <div><dt>资产 ID</dt><dd><code>{{ selected.id }}</code></dd></div>
          <div><dt>兼容平台</dt><dd>{{ selected.target.join(', ') }}</dd></div>
          <div><dt>提供能力</dt><dd>{{ selected.provides.join(', ') }}</dd></div>
          <div><dt>依赖资产</dt><dd>{{ selected.dependencies.length ? selected.dependencies.join(', ') : '无' }}</dd></div>
        </dl>
        <h3>安装变更预览 <small>示例项目</small></h3>
        <div class="change-list"><div v-for="change in examplePlan?.changes" :key="change.path"><span :class="change.action">{{ change.action === 'create' ? '+' : '~' }}</span><code>{{ change.path }}</code></div><div><span class="create">+</span><code>.forgekit/assets.lock.json</code></div></div>
        <p class="asset-help">这是示例文件清单；针对真实项目，请先运行下方的 plan 命令，检查实际变更后再安装。</p>
        <label for="project-dir">本地项目路径</label>
        <input id="project-dir" v-model="directory" spellcheck="false" />
        <div class="asset-actions"><button @click="copy(cliCommand)">复制预览命令</button><button class="primary-action" @click="copy(installCommand)">复制安装命令</button></div>
        <p class="asset-feedback" role="status">{{ message || '命令需要在 ForgeKit 仓库根目录构建 CLI 后执行；浏览器不会直接修改本地文件。' }}</p>
      </section>
      <div v-else class="asset-detail asset-empty">请选择资产查看详情。</div>
    </div>
  </div>
</template>
