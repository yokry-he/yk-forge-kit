<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { ElAlert, ElButton, ElForm, ElFormItem, ElInput, ElSelect, ElOption } from 'element-plus';
import 'element-plus/theme-chalk/el-alert.css';
import 'element-plus/theme-chalk/el-button.css';
import 'element-plus/theme-chalk/el-form.css';
import 'element-plus/theme-chalk/el-form-item.css';
import 'element-plus/theme-chalk/el-input.css';
import 'element-plus/theme-chalk/el-select.css';
import 'element-plus/theme-chalk/el-option.css';
import { AndroidConfigInputSchema, AndroidJobInputSchema, type AndroidConfig, type AndroidJob } from '@forgekit/contracts';
import { useBuildProjectAccess } from '../composables/useBuildProjectAccess';
import { getAndroidConfig, saveAndroidConfig, removeAndroidConfig, listAndroidJobs, triggerAndroidJob, cancelAndroidJob, downloadAndroidArtifact, androidStatusText } from '../api/android';
import { ProjectApiError } from '../api/projects';
import AndroidLogViewer from '../components/android/AndroidLogViewer.vue';
const route = useRoute(), router = useRouter();
const slug = computed(() => String(route.params.slug ?? ''));
const { project, accessVerified, loading, error: accessError, canRun } = useBuildProjectAccess(slug);
const config = ref<AndroidConfig | null>(null), jobs = ref<AndroidJob[]>([]);
const form = reactive({ packageName: '', appId: '', appKey: '', versionName: '1.0.0', versionCode: '1' });
const signing = reactive({ keystore: '', alias: '', storePassword: '', keyPassword: '' });
const input = reactive({ buildType: 'debug', kind: 'apk' });
const busy = ref(false), fetching = ref(false), error = ref('');
const fileInput = ref<HTMLInputElement | null>(null);
const selectedId = computed(() => typeof route.params.jobId === 'string' ? route.params.jobId : '');
const selected = computed(() => jobs.value.find(job => job.id === selectedId.value));
const active = computed(() => jobs.value.some(job => ['queued', 'running'].includes(job.status)));
let generation = 0, fileGeneration = 0;
function clearSigning() { ++fileGeneration; Object.assign(signing, { keystore: '', alias: '', storePassword: '', keyPassword: '' }); if (fileInput.value) fileInput.value.value = ''; }
function clear() { config.value = null; jobs.value = []; clearSigning(); Object.assign(form, { packageName: '', appId: '', appKey: '', versionName: '1.0.0', versionCode: '1' }); }
function failure(reason: unknown) {
  error.value = reason instanceof ProjectApiError && reason.status === 409 ? '任务进行中时不能修改配置；release 需要签名，请检查配置后重试。' : '操作失败，请检查输入、权限和 Android 服务配置后重试。';
  if (reason instanceof ProjectApiError && [401, 403, 404].includes(reason.status)) { ++generation; clear(); project.value = null; }
}
async function refresh() {
  const pid = project.value?.id, gen = ++generation;
  clearSigning();
  if (!pid || !accessVerified.value || project.value?.template !== 'uniapp') { fetching.value = false; clear(); return; }
  error.value = '';
  fetching.value = true;
  try {
    const [nextConfig, nextJobs] = await Promise.all([getAndroidConfig(pid), listAndroidJobs(pid)]);
    if (gen !== generation) return;
    config.value = nextConfig; jobs.value = nextJobs;
    if (nextConfig) Object.assign(form, nextConfig.settings, { versionCode: String(nextConfig.settings.versionCode) });
  } catch (reason) { if (gen === generation) failure(reason); }
  finally { if (gen === generation) fetching.value = false; }
}
async function chooseFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0], gen = ++fileGeneration;
  signing.keystore = '';
  if (!file) return;
  if (file.size > 65536 || file.size < 1) { error.value = '签名文件必须为 1–65536 字节的 JKS 或 PKCS12 文件。'; if (fileInput.value) fileInput.value.value = ''; return; }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (gen !== fileGeneration) { bytes.fill(0); return; }
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  signing.keystore = btoa(binary); bytes.fill(0);
}
async function save() {
  if (!project.value || !canRun.value) return;
  const parsed = AndroidConfigInputSchema.safeParse({ ...form, versionCode: Number(form.versionCode), ...(signing.keystore ? { signing: { ...signing } } : {}) });
  if (!parsed.success) { error.value = '请检查包名、DCloud AppID / AppKey、版本和签名；密码至少 6 个字符，替换签名需同时填写文件、别名及两类密码。'; return; }
  const pid = project.value.id, gen = generation; busy.value = true; error.value = ''; clearSigning();
  try { const result = await saveAndroidConfig(pid, parsed.data); if (gen === generation) config.value = result; }
  catch (reason) { if (gen === generation) failure(reason); }
  finally { busy.value = false; }
}
async function remove() {
  if (!project.value || !canRun.value) return;
  const pid = project.value.id, gen = generation; busy.value = true; clearSigning();
  try { await removeAndroidConfig(pid); if (gen === generation) await refresh(); }
  catch (reason) { if (gen === generation) failure(reason); } finally { busy.value = false; }
}
async function trigger() {
  if (!project.value || !canRun.value) return;
  const parsed = AndroidJobInputSchema.safeParse(input); if (!parsed.success) return;
  const pid = project.value.id, gen = generation; busy.value = true; error.value = ''; clearSigning();
  try {
    const job = await triggerAndroidJob(pid, parsed.data); if (gen !== generation) return;
    jobs.value.unshift(job); await router.push({ name: 'project-android', params: { slug: slug.value, jobId: job.id } });
  } catch (reason) { if (gen === generation) failure(reason); } finally { busy.value = false; }
}
async function cancel() {
  if (!project.value || !selected.value || !canRun.value) return;
  const pid = project.value.id, gen = generation; busy.value = true;
  try { const job = await cancelAndroidJob(pid, selected.value.id); if (gen === generation) status(job); }
  catch (reason) { if (gen === generation) failure(reason); } finally { busy.value = false; }
}
function status(job: AndroidJob) { const index = jobs.value.findIndex(row => row.id === job.id); if (index >= 0) jobs.value[index] = job; }
async function download() {
  if (!project.value || !selected.value?.artifact) return;
  const pid = project.value.id, job = selected.value, gen = generation; busy.value = true;
  try {
    const blob = await downloadAndroidArtifact(pid, job.id); if (gen !== generation) return;
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), v => v.toString(16).padStart(2, '0')).join('');
    if (digest !== job.artifact?.sha256) { error.value = '安装包校验失败，请重新打包。'; return; }
    if (gen !== generation) return;
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = `${job.settings.packageName}-${job.settings.versionName}-${job.input.buildType}.${job.input.kind}`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (reason) { if (gen === generation) failure(reason); } finally { busy.value = false; }
}
watch([() => project.value?.id, accessVerified], () => { void refresh(); }, { immediate: true });
watch(slug, () => { ++generation; clear(); });
onBeforeUnmount(() => { ++generation; clear(); });
</script>

<template>
  <main class="content android-page">
    <RouterLink :to="`/projects/${slug}`">返回项目</RouterLink>
    <h1>Android 打包</h1>
    <p v-if="loading" role="status">正在验证项目权限…</p>
    <ElAlert v-if="accessError || error" :title="accessError || error" type="error" :closable="false" role="alert" />
    <template v-if="project && accessVerified">
      <ElAlert v-if="project.template !== 'uniapp'" title="仅 uniapp 项目支持 Android 打包。" type="info" :closable="false" />
      <template v-else>
        <p>使用项目模板生成 App 资源并在自有基础设施离线打包。请先准备匹配的 DCloud 离线 SDK 镜像、AppID 与 AppKey。当前不读取本地修改的源码。</p>
        <ElButton :loading="fetching" @click="refresh">刷新</ElButton>
        <section aria-labelledby="android-config-title">
          <h2 id="android-config-title">应用与签名配置</h2>
          <p v-if="!config && !fetching && !error" class="state-card compact-state" role="status">尚未配置 Android 打包。请先填写包名、DCloud AppID / AppKey 并保存；正式发布还需上传签名。</p>
          <p role="status">发布签名：{{ config?.hasSigning ? '已配置（仅可替换）' : '未配置' }}。Debug 使用镜像生成的调试密钥，需登记对应证书指纹；不能用于正式发布。</p>
          <ElForm label-position="top" @submit.prevent="save">
            <ElFormItem label="Android 包名"><ElInput v-model="form.packageName" aria-label="Android 包名" placeholder="com.example.app" :disabled="!canRun || active" /></ElFormItem>
            <ElFormItem label="DCloud AppID"><ElInput v-model="form.appId" aria-label="DCloud AppID" placeholder="__UNI__XXXXXXX" :disabled="!canRun || active" /></ElFormItem>
            <ElFormItem label="DCloud AppKey（会写入安装包）"><ElInput v-model="form.appKey" aria-label="DCloud AppKey" :disabled="!canRun || active" /></ElFormItem>
            <ElFormItem label="版本名称"><ElInput v-model="form.versionName" aria-label="版本名称" :disabled="!canRun || active" /></ElFormItem>
            <ElFormItem label="版本号（正整数）"><ElInput v-model="form.versionCode" aria-label="版本号" inputmode="numeric" :disabled="!canRun || active" /></ElFormItem>
            <fieldset :disabled="!canRun || active"><legend>上传 / 替换发布签名</legend>
              <p>签名文件限 64 KiB。留空保留原签名；更换包名会清除旧签名。删除配置可移除已存签名。</p>
              <label>Keystore 文件 <input ref="fileInput" type="file" accept=".jks,.keystore,.p12,.pfx" aria-label="Keystore 文件" @change="chooseFile" /></label>
              <ElFormItem label="密钥别名"><ElInput v-model="signing.alias" aria-label="密钥别名" autocomplete="off" :disabled="!canRun || active" /></ElFormItem>
              <ElFormItem label="Keystore 密码"><ElInput v-model="signing.storePassword" aria-label="Keystore 密码" type="password" autocomplete="new-password" :disabled="!canRun || active" /></ElFormItem>
              <ElFormItem label="密钥密码"><ElInput v-model="signing.keyPassword" aria-label="密钥密码" type="password" autocomplete="new-password" :disabled="!canRun || active" /></ElFormItem>
            </fieldset>
            <ElButton native-type="submit" :disabled="!canRun || active || busy" :loading="busy">保存配置</ElButton>
            <ElButton :disabled="!canRun || active || busy || !config" @click="remove">删除配置与签名</ElButton>
          </ElForm>
        </section>
        <section aria-labelledby="android-trigger-title"><h2 id="android-trigger-title">创建打包任务</h2>
          <ElForm label-position="top" @submit.prevent="trigger">
            <ElFormItem label="构建类型"><ElSelect v-model="input.buildType" aria-label="构建类型"><ElOption label="Debug 调试包" value="debug" /><ElOption label="Release 发布包" value="release" /></ElSelect></ElFormItem>
            <ElFormItem label="安装包格式"><ElSelect v-model="input.kind" aria-label="安装包格式"><ElOption label="APK" value="apk" /><ElOption label="AAB" value="aab" /></ElSelect></ElFormItem>
            <ElButton native-type="submit" :loading="busy" :disabled="!canRun || busy || active || !config || (input.buildType === 'release' && !config.hasSigning)">开始打包</ElButton>
          </ElForm>
        </section>
        <section aria-label="打包历史"><h2>打包历史</h2><p v-if="!jobs.length">暂无打包任务。</p>
          <ul><li v-for="job in jobs" :key="job.id"><RouterLink :to="{ name: 'project-android', params: { slug, jobId: job.id } }">{{ job.settings.packageName }} · {{ job.settings.versionName }} · {{ job.input.buildType }} / {{ job.input.kind.toUpperCase() }} · {{ androidStatusText[job.status] }}</RouterLink></li></ul>
        </section>
        <section v-if="selected" aria-label="打包任务详情"><h2>打包任务详情</h2>
          <p>{{ selected.settings.packageName }} · {{ selected.settings.versionName }} ({{ selected.settings.versionCode }}) · {{ selected.input.buildType }} · {{ selected.input.kind.toUpperCase() }} · {{ androidStatusText[selected.status] }}</p>
          <p v-if="selected.errorCode" role="status">{{ selected.errorCode === 'android_cancel_requested' ? '正在取消并清理容器…' : '任务未完成，请检查日志与配置后重新打包。' }}</p>
          <ElButton v-if="['queued', 'running'].includes(selected.status)" :disabled="!canRun || busy" @click="cancel">取消任务</ElButton>
          <template v-if="selected.status === 'succeeded' && selected.artifact"><p class="checksum">SHA-256：{{ selected.artifact.sha256 }} · {{ selected.artifact.size }} 字节</p><ElButton :loading="busy" @click="download">校验并下载安装包</ElButton></template>
          <AndroidLogViewer :key="selected.id" :project-id="project.id" :job-id="selected.id" @status="status" @end="refresh" @unauthorized="failure(new ProjectApiError('', 401))" @forbidden="failure(new ProjectApiError('', 403))" />
        </section>
        <p v-else-if="selectedId">任务不在最近 100 条历史中，请刷新或返回列表。</p>
      </template>
    </template>
  </main>
</template>

<style scoped>
.android-page { min-width: 0; }
.el-form { max-width: 42rem; }
section { margin-top: 24px; }
fieldset { padding: 16px; margin-bottom: 16px; border: 1px solid var(--el-border-color); }
.checksum { overflow-wrap: anywhere; }
li { margin-block: 8px; }
</style>
