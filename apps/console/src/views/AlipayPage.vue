<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { ElAlert, ElButton, ElForm, ElFormItem, ElInput, ElSelect, ElOption, ElTag } from 'element-plus';
import 'element-plus/theme-chalk/el-alert.css';
import 'element-plus/theme-chalk/el-button.css';
import 'element-plus/theme-chalk/el-form.css';
import 'element-plus/theme-chalk/el-form-item.css';
import 'element-plus/theme-chalk/el-input.css';
import 'element-plus/theme-chalk/el-select.css';
import 'element-plus/theme-chalk/el-option.css';
import 'element-plus/theme-chalk/el-tag.css';
import { AlipayConfigInputSchema, AlipayJobInputSchema, type Build, type AlipayConfig, type AlipayJob } from '@forgekit/contracts';
import { useBuildProjectAccess } from '../composables/useBuildProjectAccess';
import { getAlipayConfig, saveAlipayConfig, removeAlipayConfig, listAlipayJobs, triggerAlipayJob, getAlipayQr, alipayStatusText } from '../api/alipay';
import { listBuilds, triggerBuild } from '../api/builds';
import { ProjectApiError } from '../api/projects';
import AlipayLogViewer from '../components/alipay/AlipayLogViewer.vue';
const route = useRoute(), router = useRouter();
const slug = computed(() => String(route.params.slug ?? ''));
const { project, accessVerified, loading, error: accessError, canRun } = useBuildProjectAccess(slug);
const config = ref<AlipayConfig | null>(null), builds = ref<Build[]>([]), jobs = ref<AlipayJob[]>([]);
const form = reactive({ appId: '', privateKey: '', toolId: '' });
const input = reactive({ buildId: '', action: 'upload_preview', target: 'dev', version: '1.0.0', description: '' });
const busy = ref(false), fetching = ref(false), error = ref(''), qrUrl = ref('');
const selectedId = computed(() => typeof route.params.jobId === 'string' ? route.params.jobId : '');
const selected = computed(() => jobs.value.find(job => job.id === selectedId.value));
const active = computed(() => jobs.value.some(job => ['queued', 'running'].includes(job.status)));
const readyBuilds = computed(() => builds.value.filter(build => build.target === 'mp-alipay' && build.status === 'succeeded' && build.artifactKey));
let generation = 0, qrGeneration = 0;
function clearQr() { ++qrGeneration; if (qrUrl.value) URL.revokeObjectURL(qrUrl.value); qrUrl.value = ''; }
function clear() { config.value = null; builds.value = []; jobs.value = []; form.privateKey = ''; form.appId = ''; form.toolId = ''; clearQr(); }
function failure(reason: unknown) {
  error.value = reason instanceof ProjectApiError && reason.status === 409 ? '需要成功的支付宝构建、有效配置且项目无进行中任务；更换 AppID / toolId 时请提供新私钥。' : '操作失败，请检查权限、服务配置或稍后重试。';
  if (reason instanceof ProjectApiError && [401, 403, 404].includes(reason.status)) { ++generation; clear(); project.value = null; }
}
async function refresh() {
  const pid = project.value?.id, gen = ++generation;
  form.privateKey = ''; error.value = '';
  if (!pid || !accessVerified.value || project.value?.template !== 'uniapp') { clear(); return; }
  fetching.value = true;
  try {
    const [nextConfig, nextBuilds, nextJobs] = await Promise.all([getAlipayConfig(pid), listBuilds(pid, { limit: 100 }), listAlipayJobs(pid)]);
    if (gen !== generation) return;
    config.value = nextConfig; builds.value = nextBuilds; jobs.value = nextJobs;
    form.appId = nextConfig?.appId ?? ''; form.toolId = nextConfig?.toolId ?? '';
    const preferred = typeof route.query.buildId === 'string' ? route.query.buildId : input.buildId;
    input.buildId = readyBuilds.value.find(build => build.id === preferred)?.id ?? readyBuilds.value[0]?.id ?? '';
  } catch (reason) { if (gen === generation) failure(reason); }
  finally { if (gen === generation) fetching.value = false; }
}
async function mutate(action: () => Promise<unknown>) {
  if (!canRun.value || busy.value) return;
  const gen = generation; busy.value = true; error.value = '';
  try { await action(); if (gen === generation) await refresh(); }
  catch (reason) { if (gen === generation) failure(reason); }
  finally { busy.value = false; }
}
async function save() {
  const pid = project.value?.id; if (!pid) return;
  const parsed = AlipayConfigInputSchema.safeParse({ appId: form.appId, toolId: form.toolId, ...(form.privateKey ? { privateKey: form.privateKey } : {}) });
  if (!parsed.success) { error.value = '请检查 16 位 AppID、toolId 与完整 RSA PEM 私钥。'; return; }
  form.privateKey = '';
  await mutate(() => saveAlipayConfig(pid, parsed.data));
}
async function remove() { const pid = project.value?.id; if (pid) await mutate(() => removeAlipayConfig(pid)); }
async function build() {
  const pid = project.value?.id; if (!pid) return;
  await mutate(async () => {
    const next = await triggerBuild(pid, 'template:uniapp', undefined, 'mp-alipay');
    await router.push({ name: 'project-build', params: { slug: slug.value, buildId: next.id } });
  });
}
async function trigger() {
  const pid = project.value?.id; if (!pid) return;
  const parsed = AlipayJobInputSchema.safeParse(input);
  if (!parsed.success) { error.value = '请选择成功的支付宝构建，填写三段数字版本号（如 1.0.0）与少于 200 字符的描述；仅预览请选择开发版。'; return; }
  const gen = generation;
  await mutate(async () => {
    const next = await triggerAlipayJob(pid, parsed.data);
    if (gen === generation) { jobs.value.unshift(next); await router.push({ name: 'project-alipay', params: { slug: slug.value, jobId: next.id } }); }
  });
}
function status(next: AlipayJob) { if (next.projectId === project.value?.id) jobs.value = jobs.value.map(job => job.id === next.id ? next : job); }
async function loadQr() {
  clearQr(); const gen = qrGeneration, pid = project.value?.id, job = selected.value;
  if (!pid || !job?.hasQrCode || job.status !== 'succeeded') return;
  try { const blob = await getAlipayQr(pid, job.id); if (gen === qrGeneration) qrUrl.value = URL.createObjectURL(blob); }
  catch (reason) { if (gen === qrGeneration) failure(reason); }
}
watch([() => project.value?.id, accessVerified], () => { void refresh(); }, { immediate: true });
watch([selectedId, () => selected.value?.hasQrCode], () => { void loadQr(); });
watch(() => input.action, action => { if (action === 'preview') input.target = 'dev'; });
watch(canRun, allowed => { if (!allowed) form.privateKey = ''; });
watch(slug, () => { ++generation; clear(); }, { flush: 'sync' });
onBeforeUnmount(() => { ++generation; clear(); });
</script>
<template>
  <main class="content alipay-page">
    <RouterLink :to="`/projects/${slug}`">返回项目</RouterLink>
    <h1>支付宝小程序上传与预览</h1>
    <p>上传生成开发版本。可选择上传后设置为体验版（需要相应账号权限）。预览二维码与体验版二维码分别管理。预览二维码请及时扫码，过期后重新创建任务。</p>
    <ElAlert v-if="error || accessError" :title="error || accessError" type="error" :closable="false" role="alert" />
    <p v-if="loading || fetching" role="status">正在加载…</p>
    <template v-if="project && accessVerified && project.template === 'uniapp'">
      <ElButton :disabled="busy || fetching" @click="refresh">刷新</ElButton>
      <p v-if="!canRun">当前角色仅可查看配置、任务、日志和二维码。</p>
      <section aria-label="支付宝配置">
        <h2>项目配置</h2>
        <p>私钥仅写入，保存后不能读取或导出。密钥不要提交到 Git。</p>
        <p v-if="config">已保存 AppID：{{ config.appId }} · 私钥{{ config.hasPrivateKey ? '已配置（仅可替换）' : '未配置' }} · {{ new Date(config.updatedAt).toLocaleString('zh-CN') }}</p>
        <p v-else>尚未配置支付宝 AppID、toolId 与工具私钥。</p>
        <p v-if="config">工具 ID：{{ config.toolId }}</p>
        <p>在支付宝开放平台「工具密钥」管理中配置公钥；私钥只保存在此处。账号需要对应小程序的开发权限。</p>
        <ElForm v-if="canRun" label-position="top" @submit.prevent="save">
          <ElFormItem label="AppID"><ElInput v-model="form.appId" aria-label="AppID" :disabled="busy" :maxlength="16" /></ElFormItem>
          <ElFormItem label="上传私钥（留空保留；首次配置或更换 AppID / toolId 必填）"><ElInput v-model="form.privateKey" aria-label="上传私钥" type="textarea" autocomplete="off" :rows="3" :maxlength="16384" :disabled="busy" /></ElFormItem>
          <ElFormItem label="工具 ID（toolId）"><ElInput v-model="form.toolId" aria-label="toolId" :maxlength="128" :disabled="busy" /></ElFormItem>
          <ElButton native-type="submit" type="primary" :loading="busy">保存配置</ElButton>
          <ElButton :disabled="busy || !config" @click="remove">删除配置与私钥</ElButton>
        </ElForm>
      </section>
      <section aria-label="上传任务">
        <h2>上传 / 预览</h2>
        <p>使用最近 100 次构建中的成功 mp-alipay 制品。每个项目同时执行一个任务。</p>
        <ElButton v-if="canRun" :disabled="busy" @click="build">创建支付宝构建</ElButton>
        <p v-if="!readyBuilds.length">暂无可用的支付宝构建，请先构建并在成功后刷新。</p>
        <ElForm v-if="canRun" label-position="top" @submit.prevent="trigger">
          <ElFormItem label="成功构建"><ElSelect v-model="input.buildId" aria-label="成功构建" :disabled="busy"><ElOption v-for="row in readyBuilds" :key="row.id" :value="row.id" :label="`#${row.number} · ${row.createdAt}`" /></ElSelect></ElFormItem>
          <ElFormItem label="操作"><ElSelect v-model="input.action" aria-label="操作" :disabled="busy"><ElOption value="upload_preview" label="上传并生成预览" /><ElOption value="upload" label="仅上传" /><ElOption value="preview" label="仅生成预览" /></ElSelect></ElFormItem>
          <ElFormItem label="上传版本号（预览版本由官方生成）"><ElInput v-model="input.version" aria-label="版本号" :maxlength="32" :disabled="busy" /></ElFormItem>
          <ElFormItem label="描述"><ElInput v-model="input.description" aria-label="描述" :maxlength="199" :disabled="busy" /></ElFormItem>
          <ElFormItem label="上传目标"><ElSelect v-model="input.target" aria-label="上传目标" :disabled="busy || input.action === 'preview'"><ElOption value="dev" label="开发版本" /><ElOption value="experience" label="上传并设置体验版（需权限）" /></ElSelect></ElFormItem>
          <ElButton native-type="submit" type="primary" :loading="busy" :disabled="active || !config?.hasPrivateKey || !input.buildId">创建任务</ElButton>
        </ElForm>
        <p v-if="!jobs.length">暂无上传或预览任务。</p>
        <ul><li v-for="job in jobs" :key="job.id"><RouterLink :to="{ name: 'project-alipay', params: { slug, jobId: job.id } }">{{ job.input.version }} · {{ job.input.action }} · {{ job.input.target === 'experience' ? '体验版' : '开发版 / 预览' }} · {{ new Date(job.createdAt).toLocaleString('zh-CN') }}</RouterLink> <ElTag>{{ alipayStatusText[job.status] }}</ElTag></li></ul>
      </section>
      <section v-if="selected" aria-label="任务详情">
        <h2>任务详情 <ElTag>{{ alipayStatusText[selected.status] }}</ElTag></h2>
        <dl><dt>创建</dt><dd>{{ selected.createdAt }}</dd><dt>开始</dt><dd>{{ selected.startedAt || '—' }}</dd><dt>结束</dt><dd>{{ selected.finishedAt || '—' }}</dd><dt>错误摘要</dt><dd>{{ selected.errorCode || '—' }}</dd></dl>
        <p v-if="selected.status === 'failed'">请核对 AppID、toolId、工具密钥、账号权限及网络。失败前可能已上传成功，请先在支付宝开放平台检查。</p>
        <img v-if="qrUrl" :src="qrUrl" alt="支付宝小程序预览二维码" width="256" height="256" />
        <AlipayLogViewer :key="`${project.id}:${selected.id}`" :project-id="project.id" :job-id="selected.id" @status="status" @unauthorized="failure(new ProjectApiError('', 401))" @forbidden="failure(new ProjectApiError('', 403))" />
      </section>
    </template>
    <p v-else-if="project && !loading">此功能仅支持 uniapp 项目。</p>
  </main>
</template>
<style scoped>
.alipay-page { --el-color-primary: var(--brand, #8b5cf6); --el-bg-color: var(--panel, #18181b); --el-fill-color-blank: var(--panel, #18181b); --el-text-color-primary: var(--text, #e4e4e7); --el-text-color-regular: var(--text, #e4e4e7); --el-border-color: var(--line, #3f3f46); min-width: 0; }
section { margin: 1.5rem 0; border-top: 1px solid var(--line, #3f3f46); padding-top: 1rem; }
.el-form { max-width: 42rem; } li { margin: .75rem 0; overflow-wrap: anywhere; } dd { margin: 0 0 .5rem; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; background: white; } input[type=number] { color: var(--text); background: var(--panel); border: 1px solid var(--line); padding: .5rem; }
</style>
