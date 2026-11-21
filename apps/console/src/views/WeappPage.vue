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
import { WeappConfigInputSchema, WeappJobInputSchema, type Build, type WeappConfig, type WeappJob } from '@forgekit/contracts';
import { useBuildProjectAccess } from '../composables/useBuildProjectAccess';
import { getWeappConfig, saveWeappConfig, removeWeappConfig, listWeappJobs, triggerWeappJob, getWeappQr, weappStatusText } from '../api/weapp';
import { listBuilds, triggerBuild } from '../api/builds';
import { ProjectApiError } from '../api/projects';
import WeappLogViewer from '../components/weapp/WeappLogViewer.vue';
const route = useRoute(), router = useRouter();
const slug = computed(() => String(route.params.slug ?? ''));
const { project, accessVerified, loading, error: accessError, canRun } = useBuildProjectAccess(slug);
const config = ref<WeappConfig | null>(null), builds = ref<Build[]>([]), jobs = ref<WeappJob[]>([]);
const form = reactive({ appId: '', privateKey: '', ipWhitelistNote: '' });
const input = reactive({ buildId: '', action: 'upload_preview', target: 'dev', version: '1.0.0', description: '', robot: 1 });
const busy = ref(false), fetching = ref(false), error = ref(''), qrUrl = ref('');
const selectedId = computed(() => typeof route.params.jobId === 'string' ? route.params.jobId : '');
const selected = computed(() => jobs.value.find(job => job.id === selectedId.value));
const active = computed(() => jobs.value.some(job => ['queued', 'running'].includes(job.status)));
const readyBuilds = computed(() => builds.value.filter(build => build.target === 'mp-weixin' && build.status === 'succeeded' && build.artifactKey));
let generation = 0, qrGeneration = 0;
function clearQr() { ++qrGeneration; if (qrUrl.value) URL.revokeObjectURL(qrUrl.value); qrUrl.value = ''; }
function clear() { config.value = null; builds.value = []; jobs.value = []; form.privateKey = ''; form.appId = ''; form.ipWhitelistNote = ''; clearQr(); }
function failure(reason: unknown) {
  error.value = reason instanceof ProjectApiError && reason.status === 409 ? '需要成功的微信构建、有效配置且项目无进行中任务；更换 AppID 时请提供新私钥。' : '操作失败，请检查权限、服务配置或稍后重试。';
  if (reason instanceof ProjectApiError && [401, 403, 404].includes(reason.status)) { ++generation; clear(); project.value = null; }
}
async function refresh() {
  const pid = project.value?.id, gen = ++generation;
  form.privateKey = ''; error.value = '';
  if (!pid || !accessVerified.value || project.value?.template !== 'uniapp') { clear(); return; }
  fetching.value = true;
  try {
    const [nextConfig, nextBuilds, nextJobs] = await Promise.all([getWeappConfig(pid), listBuilds(pid, { limit: 100 }), listWeappJobs(pid)]);
    if (gen !== generation) return;
    config.value = nextConfig; builds.value = nextBuilds; jobs.value = nextJobs;
    form.appId = nextConfig?.appId ?? ''; form.ipWhitelistNote = nextConfig?.ipWhitelistNote ?? '';
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
  const parsed = WeappConfigInputSchema.safeParse({ appId: form.appId, ipWhitelistNote: form.ipWhitelistNote, ...(form.privateKey ? { privateKey: form.privateKey } : {}) });
  if (!parsed.success) { error.value = '请检查 AppID、私钥和白名单备注长度。'; return; }
  form.privateKey = '';
  await mutate(() => saveWeappConfig(pid, parsed.data));
}
async function remove() { const pid = project.value?.id; if (pid) await mutate(() => removeWeappConfig(pid)); }
async function build() {
  const pid = project.value?.id; if (!pid) return;
  await mutate(async () => {
    const next = await triggerBuild(pid, 'template:uniapp', undefined, 'mp-weixin');
    await router.push({ name: 'project-build', params: { slug: slug.value, buildId: next.id } });
  });
}
async function trigger() {
  const pid = project.value?.id; if (!pid) return;
  const parsed = WeappJobInputSchema.safeParse(input);
  if (!parsed.success) { error.value = '请选择成功的微信构建，填写有效版本号和 1–30 的机器人序号。'; return; }
  const gen = generation;
  await mutate(async () => {
    const next = await triggerWeappJob(pid, parsed.data);
    if (gen === generation) { jobs.value.unshift(next); await router.push({ name: 'project-weapp', params: { slug: slug.value, jobId: next.id } }); }
  });
}
function status(next: WeappJob) { if (next.projectId === project.value?.id) jobs.value = jobs.value.map(job => job.id === next.id ? next : job); }
async function loadQr() {
  clearQr(); const gen = qrGeneration, pid = project.value?.id, job = selected.value;
  if (!pid || !job?.hasQrCode || job.status !== 'succeeded') return;
  try { const blob = await getWeappQr(pid, job.id); if (gen === qrGeneration) qrUrl.value = URL.createObjectURL(blob); }
  catch (reason) { if (gen === qrGeneration) failure(reason); }
}
watch([() => project.value?.id, accessVerified], () => { void refresh(); }, { immediate: true });
watch([selectedId, () => selected.value?.hasQrCode], () => { void loadQr(); });
watch(canRun, allowed => { if (!allowed) form.privateKey = ''; });
watch(slug, () => { ++generation; clear(); }, { flush: 'sync' });
onBeforeUnmount(() => { ++generation; clear(); });
</script>
<template>
  <main class="content weapp-page">
    <RouterLink :to="`/projects/${slug}`">返回项目</RouterLink>
    <h1>微信小程序上传与预览</h1>
    <p>上传生成开发版本。体验版本请在微信公众平台「版本管理」中手动选择。预览二维码请及时扫码，过期后重新创建任务。</p>
    <ElAlert v-if="error || accessError" :title="error || accessError" type="error" :closable="false" role="alert" />
    <p v-if="loading || fetching" role="status">正在加载…</p>
    <template v-if="project && accessVerified && project.template === 'uniapp'">
      <ElButton :disabled="busy || fetching" @click="refresh">刷新</ElButton>
      <p v-if="!canRun">当前角色仅可查看配置、任务、日志和二维码。</p>
      <section aria-label="微信配置">
        <h2>项目配置</h2>
        <p>私钥仅写入，保存后不能读取或导出。密钥不要提交到 Git。</p>
        <p v-if="config">已保存 AppID：{{ config.appId }} · 私钥{{ config.hasPrivateKey ? '已配置（仅可替换）' : '未配置' }} · {{ new Date(config.updatedAt).toLocaleString('zh-CN') }}</p>
        <p v-else>尚未配置微信 AppID 与上传私钥。</p>
        <p>请向部署人员确认上传出口 IP，并在微信公众平台设置 IP 白名单。备注仅供人工记录，不会修改微信后台。</p>
        <p v-if="config?.ipWhitelistNote">白名单备注：{{ config.ipWhitelistNote }}</p>
        <ElForm v-if="canRun" label-position="top" @submit.prevent="save">
          <ElFormItem label="AppID"><ElInput v-model="form.appId" aria-label="AppID" :disabled="busy" :maxlength="18" /></ElFormItem>
          <ElFormItem label="上传私钥（留空保留；首次配置或更换 AppID 必填）"><ElInput v-model="form.privateKey" aria-label="上传私钥" type="textarea" autocomplete="off" :rows="3" :maxlength="16384" :disabled="busy" /></ElFormItem>
          <ElFormItem label="IP 白名单备注"><ElInput v-model="form.ipWhitelistNote" aria-label="IP 白名单备注" type="textarea" :maxlength="1000" :disabled="busy" /></ElFormItem>
          <ElButton native-type="submit" type="primary" :loading="busy">保存配置</ElButton>
          <ElButton :disabled="busy || !config" @click="remove">删除配置与私钥</ElButton>
        </ElForm>
      </section>
      <section aria-label="上传任务">
        <h2>上传 / 预览</h2>
        <p>使用最近 100 次构建中的成功 mp-weixin 制品。每个项目同时执行一个任务。</p>
        <ElButton v-if="canRun" :disabled="busy" @click="build">创建微信构建</ElButton>
        <p v-if="!readyBuilds.length">暂无可用的微信构建，请先构建并在成功后刷新。</p>
        <ElForm v-if="canRun" label-position="top" @submit.prevent="trigger">
          <ElFormItem label="成功构建"><ElSelect v-model="input.buildId" aria-label="成功构建" :disabled="busy"><ElOption v-for="row in readyBuilds" :key="row.id" :value="row.id" :label="`#${row.number} · ${row.createdAt}`" /></ElSelect></ElFormItem>
          <ElFormItem label="操作"><ElSelect v-model="input.action" aria-label="操作" :disabled="busy"><ElOption value="upload_preview" label="上传开发版并生成预览" /><ElOption value="upload" label="仅上传开发版" /><ElOption value="preview" label="仅生成预览" /></ElSelect></ElFormItem>
          <ElFormItem label="版本号"><ElInput v-model="input.version" aria-label="版本号" :maxlength="64" :disabled="busy" /></ElFormItem>
          <ElFormItem label="描述"><ElInput v-model="input.description" aria-label="描述" :maxlength="500" :disabled="busy" /></ElFormItem>
          <ElFormItem label="机器人序号（1–30）"><input v-model.number="input.robot" aria-label="机器人序号" type="number" min="1" max="30" :disabled="busy" /></ElFormItem>
          <ElButton native-type="submit" type="primary" :loading="busy" :disabled="active || !config?.hasPrivateKey || !input.buildId">创建任务</ElButton>
        </ElForm>
        <p v-if="!jobs.length">暂无上传或预览任务。</p>
        <ul><li v-for="job in jobs" :key="job.id"><RouterLink :to="{ name: 'project-weapp', params: { slug, jobId: job.id } }">{{ job.input.version }} · {{ job.input.action }} · {{ new Date(job.createdAt).toLocaleString('zh-CN') }}</RouterLink> <ElTag>{{ weappStatusText[job.status] }}</ElTag></li></ul>
      </section>
      <section v-if="selected" aria-label="任务详情">
        <h2>任务详情 <ElTag>{{ weappStatusText[selected.status] }}</ElTag></h2>
        <dl><dt>创建</dt><dd>{{ selected.createdAt }}</dd><dt>开始</dt><dd>{{ selected.startedAt || '—' }}</dd><dt>结束</dt><dd>{{ selected.finishedAt || '—' }}</dd><dt>错误摘要</dt><dd>{{ selected.errorCode || '—' }}</dd></dl>
        <p v-if="selected.status === 'failed'">请核对 AppID、上传密钥、IP 白名单及网络。失败前可能已上传成功，请先在微信公众平台检查。</p>
        <img v-if="qrUrl" :src="qrUrl" alt="微信小程序预览二维码" width="256" height="256" />
        <WeappLogViewer :key="`${project.id}:${selected.id}`" :project-id="project.id" :job-id="selected.id" @status="status" @unauthorized="failure(new ProjectApiError('', 401))" @forbidden="failure(new ProjectApiError('', 403))" />
      </section>
    </template>
    <p v-else-if="project && !loading">此功能仅支持 uniapp 项目。</p>
  </main>
</template>
<style scoped>
.weapp-page { --el-color-primary: var(--brand, #8b5cf6); --el-bg-color: var(--panel, #18181b); --el-fill-color-blank: var(--panel, #18181b); --el-text-color-primary: var(--text, #e4e4e7); --el-text-color-regular: var(--text, #e4e4e7); --el-border-color: var(--line, #3f3f46); min-width: 0; }
section { margin: 1.5rem 0; border-top: 1px solid var(--line, #3f3f46); padding-top: 1rem; }
.el-form { max-width: 42rem; } li { margin: .75rem 0; overflow-wrap: anywhere; } dd { margin: 0 0 .5rem; overflow-wrap: anywhere; }
img { max-width: 100%; height: auto; background: white; } input[type=number] { color: var(--text); background: var(--panel); border: 1px solid var(--line); padding: .5rem; }
</style>
