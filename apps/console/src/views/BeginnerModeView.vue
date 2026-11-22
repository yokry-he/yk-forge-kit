<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { BeginnerNameSchema, DEFAULT_AI_CONFIG, beginnerDefaults, beginnerPlatforms, type BeginnerPlatform, type BeginnerResult, type BeginnerTemplate } from '@forgekit/contracts';
import { getProjectTemplate, listProjectTemplates } from '@forgekit/project-core';
import { saveProject } from '../api/projects';
import { classifyNeed, getBeginnerConfig, saveBeginnerConfig, deleteBeginnerConfig } from '../api/beginner';

const router = useRouter();
const step = ref(1), description = ref(''), busy = ref(false), error = ref('');
const result = ref<BeginnerResult>();
const templateId = ref<BeginnerTemplate>('vue-web'), name = ref(''), platforms = ref<BeginnerPlatform[]>(['web']);
const corrected = ref(false);
const templates = listProjectTemplates();
const allowed = computed(() => beginnerPlatforms[templateId.value]);
const valid = computed(() => BeginnerNameSchema.safeParse(name.value).success && platforms.value.length > 0 && platforms.value.every(p => allowed.value.includes(p)));
const uncertain = computed(() => result.value?.lowConfidence || corrected.value);
let active = true;
onUnmounted(() => { active = false; apiKey.value = ''; });
async function classify() {
  if (busy.value || !description.value.trim()) return;
  busy.value = true; error.value = '';
  try {
    const suggestion = await classifyNeed(description.value.trim());
    if (!active) return;
    result.value = suggestion; templateId.value = suggestion.templateId; name.value = suggestion.name;
    platforms.value = [...suggestion.platforms]; corrected.value = false; step.value = 2;
  } catch { if (active) error.value = '暂时无法推荐，请稍后重试或使用手动创建。'; }
  finally { if (active) busy.value = false; }
}
function changeTemplate() {
  platforms.value = [...beginnerDefaults[templateId.value]];
  corrected.value = true;
}
async function create() {
  if (busy.value || !valid.value) return;
  busy.value = true; error.value = '';
  try {
    const project = await saveProject({ name: name.value, template: templateId.value,
      features: [...(getProjectTemplate(templateId.value)?.defaultFeatures ?? [])], platforms: [...platforms.value] });
    if (active) await router.push(`/projects/${encodeURIComponent(project.slug)}`);
  } catch { if (active) error.value = '创建失败，请检查项目名是否重复、登录和后端连接后重试。'; }
  finally { if (active) busy.value = false; }
}
const configured = ref(false), configBusy = ref(false), configReady = ref(false), configError = ref(''), configStatus = ref('');
const provider = ref<string>(DEFAULT_AI_CONFIG.provider), baseUrl = ref<string>(DEFAULT_AI_CONFIG.baseUrl), model = ref<string>(DEFAULT_AI_CONFIG.model), apiKey = ref('');
async function loadConfig() {
  configError.value = ''; configReady.value = false;
  try {
    const config = await getBeginnerConfig();
    if (!active) return;
    configured.value = config.configured;
    provider.value = config.provider ?? DEFAULT_AI_CONFIG.provider; baseUrl.value = config.baseUrl ?? DEFAULT_AI_CONFIG.baseUrl;
    model.value = config.model ?? DEFAULT_AI_CONFIG.model; configReady.value = true;
  } catch { if (active) configError.value = 'AI 配置暂不可用；仍可尝试关键词推荐。'; }
}
onMounted(loadConfig);
async function updateConfig(remove = false) {
  if (configBusy.value) return;
  configBusy.value = true; configError.value = ''; configStatus.value = '';
  try {
    if (remove) {
      await deleteBeginnerConfig();
      if (active) { configured.value = false; provider.value = DEFAULT_AI_CONFIG.provider; baseUrl.value = DEFAULT_AI_CONFIG.baseUrl; model.value = DEFAULT_AI_CONFIG.model; }
    } else {
      const saved = await saveBeginnerConfig({ provider: provider.value, baseUrl: baseUrl.value, model: model.value, apiKey: apiKey.value });
      if (active) configured.value = saved.configured;
    }
    if (active) configStatus.value = remove ? 'AI 配置已删除，将使用关键词推荐。' : 'AI 配置已保存。';
  } catch { if (active) configError.value = 'AI 配置操作失败，请检查填写内容后重试。'; }
  finally { apiKey.value = ''; if (active) configBusy.value = false; }
}
</script>

<template>
  <div class="content beginner-mode">
    <div class="eyebrow">NEW PROJECT</div>
    <h1>新手<span>模式</span></h1>
    <p class="intro">用一句中文或英文说出需求，确认建议后创建项目配置。</p>
    <RouterLink class="primary-link" to="/projects/new">手动选择模板 →</RouterLink>
    <div class="steps" aria-label="新手模式步骤">
      <div v-for="(label, i) in ['一句话需求', '确认推荐', '创建项目']" :key="label" :class="{ selected: step === i + 1, done: step > i + 1 }" :aria-current="step === i + 1 ? 'step' : undefined"><em>{{ i + 1 }}</em>{{ label }}</div>
    </div>
    <form v-if="step === 1" class="panel" @submit.prevent="classify">
      <h2>你想做什么？</h2>
      <label for="beginner-need">一句话需求 / What would you like to build?</label>
      <textarea id="beginner-need" v-model="description" required maxlength="2000" rows="4" :disabled="busy" placeholder="例如：帮我做一个公司官网，能发文章" aria-describedby="need-help" />
      <small id="need-help">支持中文或英文，最多 2000 字。不配置 AI 也能按关键词推荐。</small>
      <div class="actions"><button type="submit" :disabled="busy || !description.trim()">{{ busy ? '正在推荐…' : '推荐模板 →' }}</button></div>
    </form>
    <section v-else-if="step === 2" class="panel" aria-labelledby="suggestion-heading">
      <h2 id="suggestion-heading">确认或调整推荐</h2>
      <p>推荐来源：{{ result?.source === 'ai' ? 'AI' : '关键词' }}（{{ result?.source }}）</p>
      <p v-if="uncertain" class="warning" role="status">把握不大，请确认</p>
      <ul v-if="result?.warnings?.length"><li v-for="warning in result.warnings" :key="warning">{{ warning }}</li></ul>
      <label for="beginner-template">项目模板</label>
      <select id="beginner-template" v-model="templateId" @change="changeTemplate"><option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}（{{ t.id }}）</option></select>
      <label for="beginner-name">项目名称</label>
      <input id="beginner-name" v-model="name" maxlength="60" autocomplete="off" spellcheck="false" aria-describedby="beginner-name-help" />
      <small id="beginner-name-help">小写字母开头，可包含数字和中划线，最多 60 位。</small>
      <fieldset><legend>兼容的目标平台（至少选一项）</legend>
        <label v-for="platform in allowed" :key="platform" class="choice"><input v-model="platforms" type="checkbox" :value="platform" />{{ platform }}</label>
      </fieldset>
      <small>平台会保存在项目配置中；构建、签名与发布需要后续单独配置。</small>
      <div class="actions"><button type="button" class="back" @click="step = 1">上一步</button><button type="button" :disabled="!valid" @click="step = 3">继续 →</button></div>
    </section>
    <section v-else class="panel" aria-labelledby="create-heading">
      <h2 id="create-heading">创建项目</h2>
      <div class="summary"><div><span>名称</span><strong>{{ name }}</strong></div><div><span>模板</span><strong>{{ getProjectTemplate(templateId)?.name ?? templateId }}</strong></div><div><span>目标平台</span><strong>{{ platforms.join('、') }}</strong></div></div>
      <p>保存项目配置，成功后打开项目详情。源码生成由现有本地 CLI 完成。</p>
      <div class="actions"><button type="button" class="back" :disabled="busy" @click="step = 2">上一步</button><button type="button" :disabled="busy || !valid" @click="create">{{ busy ? '正在创建…' : '创建项目配置' }}</button></div>
    </section>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <details class="panel ai-config"><summary>AI 配置（可选，自备 API Key）</summary>
      <p role="status">{{ configured ? '已配置（仅可替换）' : '未配置，使用关键词推荐' }}</p>
      <form v-if="configReady" @submit.prevent="updateConfig()">
        <fieldset :disabled="configBusy"><legend>OpenAI 兼容服务</legend>
          <label for="ai-provider">提供商</label><input id="ai-provider" v-model="provider" required maxlength="64" />
          <label for="ai-url">Base URL</label><input id="ai-url" v-model="baseUrl" type="url" required maxlength="512" />
          <label for="ai-model">模型</label><input id="ai-model" v-model="model" required maxlength="128" />
          <label for="ai-key">API Key（只写）</label><input id="ai-key" v-model="apiKey" type="password" autocomplete="new-password" maxlength="4096" :required="!configured" :placeholder="configured ? '目标未变时可留空' : '输入你的 API Key'" aria-describedby="ai-key-help" />
          <small id="ai-key-help">保存后无法读回。更换服务地址、提供商或模型时须填写新密钥。启用后，需求会发送给你配置的公网服务，建议使用 HTTPS。</small>
          <div class="actions"><button type="submit" :disabled="configBusy">保存 AI 配置</button><button v-if="configured" type="button" class="back" :disabled="configBusy" @click="updateConfig(true)">删除 AI 配置</button></div>
        </fieldset>
      </form>
      <p v-if="configError" role="alert">{{ configError }} <button v-if="!configReady" type="button" class="subtle-button" @click="loadConfig">重试</button></p>
      <p v-if="configStatus" role="status">{{ configStatus }}</p>
    </details>
  </div>
</template>

<style scoped>
.beginner-mode textarea, .beginner-mode select { width: 100%; padding: 12px; font: inherit; color: inherit; background: var(--el-bg-color, #111116); border: 1px solid var(--el-border-color, #44444d); border-radius: 9px; }
.beginner-mode :is(textarea, select):focus-visible { outline: 2px solid var(--el-color-primary, #22d3ee); outline-offset: 3px; }
.beginner-mode fieldset { min-width: 0; margin-top: 20px; border: 1px solid var(--el-border-color, #44444d); border-radius: 9px; padding: 14px; }
.beginner-mode .choice { display: flex; gap: 12px; align-items: center; }
.beginner-mode .choice input { width: auto; }
.beginner-mode .ai-config { display: block; }
.beginner-mode .ai-config summary { cursor: pointer; }
</style>
