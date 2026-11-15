<script setup lang="ts">
import { computed, ref } from 'vue';
import { createProjectPlan, type ProjectFeature } from '@forgekit/project-core';

const step = ref(1);
const name = ref('my-forge-app');
const features = ref<ProjectFeature[]>(['theme']);
const copyStatus = ref('');
const options: Array<{ id: ProjectFeature; label: string; detail: string }> = [
  { id: 'theme', label: '主题系统', detail: '深色视觉风格与语义设计变量' },
  { id: 'router', label: '页面路由', detail: 'Vue Router 和首页路由' },
  { id: 'pinia', label: '状态管理', detail: 'Pinia 全局状态容器' },
];
const plan = computed(() => {
  try { return createProjectPlan({ name: name.value.trim(), template: 'vue-web', features: features.value }); }
  catch { return null; }
});
const command = computed(() => plan.value ? `node packages/cli/dist/index.js create ${plan.value.options.name} --features ${plan.value.options.features.join(',') || 'none'}` : '');
function toggle(id: ProjectFeature): void {
  features.value = features.value.includes(id) ? features.value.filter((x) => x !== id) : [...features.value, id];
}
async function copy(): Promise<void> {
  try { await navigator.clipboard.writeText(command.value); copyStatus.value = '命令已复制'; }
  catch { copyStatus.value = '复制失败，请手动选中命令'; }
}
</script>

<template>
  <div class="content">
        <div class="eyebrow">NEW PROJECT</div>
        <h1>创建你的下一个<span>项目</span></h1>
        <p class="intro">选择模板和基础能力，生成标准、可维护、可自由修改的源码项目。</p>
        <div class="steps" aria-label="项目创建步骤">
          <div v-for="index in [1, 2, 3]" :key="index" :class="{ selected: step === index, done: step > index }">
            <em>{{ index }}</em>{{ ['基础配置', '选择能力', '确认创建'][index - 1] }}
          </div>
        </div>

        <section v-if="step === 1" class="panel">
          <h2>基础配置</h2><p>给项目一个名称，并选择技术模板。</p>
          <label for="name">项目名称</label>
          <input id="name" v-model="name" autocomplete="off" spellcheck="false" aria-describedby="name-help" />
          <small id="name-help">小写字母开头，可包含数字与中划线，最多 60 位。</small>
          <label>项目模板</label>
          <div class="template"><div class="vue-mark">V</div><div><strong>Vue Web 应用</strong><small>Vue 3 · TypeScript · Vite</small></div><span>✓ 已选择</span></div>
          <div class="coming">计划支持：H5 / 移动 App / 小程序 / 桌面应用。当前仅 Vue Web 可创建。</div>
        </section>

        <section v-else-if="step === 2" class="panel">
          <h2>选择基础能力</h2><p>按需集成，生成后仍可在源码中修改。</p>
          <label v-for="item in options" :key="item.id" class="choice" :class="{ checked: features.includes(item.id) }">
            <input type="checkbox" :checked="features.includes(item.id)" @change="toggle(item.id)" />
            <span><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></span>
          </label>
          <div class="coming">用户中心、权限管理与数据大屏将在资产系统中提供，目前尚未实现。</div>
        </section>

        <section v-else class="panel">
          <h2>确认项目配置</h2><p>确认后通过本地 CLI 生成真实源码。</p>
          <div class="summary">
            <div><span>名称</span><strong>{{ name }}</strong></div>
            <div><span>模板</span><strong>Vue 3 / Vite</strong></div>
            <div><span>能力</span><strong>{{ features.join('、') || '无' }}</strong></div>
            <div><span>文件数</span><strong>{{ plan?.files.length }}</strong></div>
          </div>
          <label>本地创建命令</label>
          <div class="command"><code>{{ command }}</code><button @click="copy">复制</button></div>
          <small role="status">{{ copyStatus || '需要先构建并连接本仓库 CLI；此操作不会直接写入浏览器所在设备。' }}</small>
          <details><summary>查看即将生成的文件</summary><ul><li v-for="file in plan?.files" :key="file">{{ file }}</li></ul></details>
        </section>
        <div class="actions"><button v-if="step > 1" class="back" @click="step--">上一步</button><span></span><button v-if="step < 3" :disabled="step === 1 && !plan" @click="step++">继续 →</button><button v-else @click="step = 1; copyStatus = ''">创建另一个项目</button></div>
  </div>
</template>
