<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { createProjectPlan, listProjectTemplates, type ProjectFeature, type ProjectTemplateId } from '@forgekit/project-core';
import { RouterLink } from 'vue-router';
import { saveProject } from '../api/projects';

const step = ref(1);
const name = ref('my-forge-app');
const templates = listProjectTemplates();
const templateId = ref<ProjectTemplateId>(templates[0]!.id);
const template = computed(() => templates.find((item) => item.id === templateId.value) ?? templates[0]!);
const features = ref<ProjectFeature[]>([...template.value.defaultFeatures]);
const copyStatus = ref('');
const saving = ref(false);
const saveError = ref('');
const savedSlug = ref('');
watch([name, features, templateId], () => { savedSlug.value = ''; saveError.value = ''; });
const options = computed(() => template.value.features);
function selectTemplate(id: ProjectTemplateId): void {
  if (id === templateId.value) return;
  templateId.value = id;
  features.value = [...template.value.defaultFeatures];
}
const plan = computed(() => {
  try { return createProjectPlan({ name: name.value.trim(), template: templateId.value, features: features.value }); }
  catch { return null; }
});
const command = computed(() => plan.value ? `node packages/cli/dist/index.js create ${plan.value.options.name} --template ${plan.value.options.template} --features ${plan.value.options.features.join(',') || 'none'}` : '');
function toggle(id: ProjectFeature): void {
  savedSlug.value = '';
  features.value = features.value.includes(id) ? features.value.filter((x) => x !== id) : [...features.value, id];
}
async function save(): Promise<void> {
  if (!plan.value || saving.value) return;
  saving.value = true;
  saveError.value = '';
  savedSlug.value = '';
  try { savedSlug.value = (await saveProject(plan.value.options)).slug; }
  catch (reason) { saveError.value = reason instanceof Error ? reason.message : '保存失败，请稍后重试。'; }
  finally { saving.value = false; }
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
          <div class="template-list" role="radiogroup" aria-label="项目模板">
            <button v-for="item in templates" :key="item.id" type="button" class="template" role="radio" :aria-checked="item.id === templateId" :class="{ selected: item.id === templateId }" @click="selectTemplate(item.id)">
              <div class="vue-mark">V</div><div><strong>{{ item.name }}</strong><small>{{ item.stack.join(' · ') }}</small><small>{{ item.description }}</small></div><span v-if="item.id === templateId">✓ 已选择</span>
            </button>
          </div>
          <div class="coming">计划支持：内容站 / 官网（Nuxt）、小程序与移动 App（uni-app）、桌面应用（Tauri 2）。</div>
        </section>

        <section v-else-if="step === 2" class="panel">
          <h2>选择基础能力</h2><p>按需集成，生成后仍可在源码中修改。</p>
          <p v-if="template.builtIn.length" class="built-in">模板内置：{{ template.builtIn.join('、') }}</p>
          <p v-if="!options.length" class="coming">该模板没有可选能力。</p>
          <label v-for="item in options" :key="item.id" class="choice" :class="{ checked: features.includes(item.id) }">
            <input type="checkbox" :checked="features.includes(item.id)" @change="toggle(item.id)" />
            <span><strong>{{ item.label }}</strong><small>{{ item.detail }}</small></span>
          </label>
          <div class="coming">用户中心、权限管理与数据大屏将在资产系统中提供，目前尚未实现。</div>
        </section>

        <section v-else class="panel">
          <h2>确认项目配置</h2><p>可先将配置保存至 MySQL。保存记录不会自动生成本机源码。</p>
          <div class="summary">
            <div><span>名称</span><strong>{{ name }}</strong></div>
            <div><span>模板</span><strong>{{ template.name }}</strong></div>
            <div><span>能力</span><strong>{{ features.join('、') || '无' }}</strong></div>
            <div><span>文件数</span><strong>{{ plan?.files.length }}</strong></div>
          </div>
          <label>本地创建命令</label>
          <div class="command"><code>{{ command }}</code><button @click="copy">复制</button></div>
          <small role="status">{{ copyStatus || '需要先构建并连接本仓库 CLI；此操作不会直接写入浏览器所在设备。' }}</small>
          <div class="save-record">
            <button class="save-button" type="button" :disabled="saving || !!savedSlug || !plan" @click="save">{{ saving ? '正在保存…' : savedSlug ? '项目配置已保存' : '保存项目配置到 MySQL' }}</button>
            <p v-if="saveError" class="form-error" role="alert">{{ saveError }}</p>
            <p v-if="savedSlug" class="form-success" role="status">项目记录已保存。<RouterLink :to="`/projects/${encodeURIComponent(savedSlug)}`">查看项目详情 →</RouterLink></p>
            <small v-if="!savedSlug && !saveError">需要后端 API 已连接，并完成数据库迁移。</small>
          </div>
          <details><summary>查看即将生成的文件</summary><ul><li v-for="file in plan?.files" :key="file">{{ file }}</li></ul></details>
        </section>
        <div class="actions"><button v-if="step > 1" class="back" @click="step--">上一步</button><span></span><button v-if="step < 3" :disabled="step === 1 && !plan" @click="step++">继续 →</button><button v-else @click="step = 1; copyStatus = ''">创建另一个项目</button></div>
  </div>
</template>
