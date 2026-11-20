<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { ElButton, ElInput, ElInputNumber, ElForm, ElFormItem, ElAlert, ElTag, ElPopconfirm } from 'element-plus';
import 'element-plus/theme-chalk/el-button.css';
import 'element-plus/theme-chalk/el-input.css';
import 'element-plus/theme-chalk/el-input-number.css';
import 'element-plus/theme-chalk/el-form.css';
import 'element-plus/theme-chalk/el-form-item.css';
import 'element-plus/theme-chalk/el-alert.css';
import 'element-plus/theme-chalk/el-tag.css';
import 'element-plus/theme-chalk/el-popconfirm.css';
import type { Deployment, DeployTarget } from '@forgekit/contracts';
import { DeployTargetCreateSchema, DeployTargetUpdateSchema, deployIsActive } from '@forgekit/contracts';
import { useBuildProjectAccess } from '../composables/useBuildProjectAccess';
import { listDeployTargets, saveDeployTarget, removeDeployTarget, listDeployments, getDeployment, rollbackDeployment, deployStatusText } from '../api/deploys';
import { ProjectApiError } from '../api/projects';
import { clearSession } from '../auth/session';
import DeployLogViewer from '../components/deploys/DeployLogViewer.vue';
const route = useRoute(), router = useRouter();
const slug = computed(() => String(route.params.slug ?? ''));
const { project, accessVerified, error: accessError, loading, canRun } = useBuildProjectAccess(slug);
const targets = ref<DeployTarget[]>([]), jobs = ref<Deployment[]>([]), selected = ref<Deployment | null>(null);
const error = ref(''), busy = ref(false), editing = ref<string | null>(null), formVisible = ref(false);
const defaults = () => ({ name: '', host: '', port: 22, username: 'deploy', hostKey: '', basePath: '/srv/forgekit', retention: 5, privateKey: '' });
const form = reactive(defaults());
let disposed = false, requestVersion = 0;
let generation = 0, refreshTimer: ReturnType<typeof setTimeout> | undefined;
function clearForm() { Object.assign(form, defaults()); editing.value = null; formVisible.value = false; }
function clearData() { targets.value = []; jobs.value = []; selected.value = null; clearForm(); }
async function failure(reason: unknown) {
  error.value = reason instanceof ProjectApiError ? reason.message : '部署服务暂不可用，请重试。';
  if (reason instanceof ProjectApiError && [401, 403, 404].includes(reason.status)) {
    ++generation; clearData(); project.value = null;
    if (reason.status === 401) { await clearSession(); await router.replace({ path: '/auth/login', query: { returnTo: route.fullPath } }); }
  }
}
async function refresh() {
  const pid = project.value?.id, gen = generation, request = ++requestVersion;
  if (!pid || !accessVerified.value) return;
  try {
    const [nextTargets, nextJobs] = await Promise.all([listDeployTargets(pid), listDeployments(pid)]);
    if (gen !== generation || request !== requestVersion) return;
    targets.value = nextTargets; jobs.value = nextJobs;
    const id = String(route.params.deploymentId ?? '');
    const next = nextJobs.find(job => job.id === id) ?? (id ? await getDeployment(pid, id) : null);
    if (gen === generation && request === requestVersion) selected.value = next;
  } catch (reason) { if (gen === generation && request === requestVersion) await failure(reason); }
}
function edit(target?: DeployTarget) {
  clearForm(); editing.value = target?.id ?? null;
  if (target) Object.assign(form, { name: target.name, host: target.host ?? '', port: target.port ?? 22, username: target.username ?? '',
    hostKey: target.hostKey ?? '', basePath: target.basePath ?? '', retention: target.retention });
  formVisible.value = true;
}
const immutableConnection = computed(() => !!editing.value && jobs.value.some(job => job.deployTargetId === editing.value));
async function save() {
  if (!project.value || !canRun.value || busy.value) return;
  error.value = '';
  const input = { ...form, ...(editing.value && !form.privateKey ? { privateKey: undefined } : {}) };
  const parsed = (editing.value ? DeployTargetUpdateSchema : DeployTargetCreateSchema).safeParse(input);
  if (!parsed.success) { error.value = '请核对名称、主机、端口、非 root 账号、主机公钥、部署目录和专用私钥。'; return; }
  const gen = generation; busy.value = true;
  try {
    await saveDeployTarget(project.value.id, editing.value ?? undefined, parsed.data);
    if (gen === generation) { clearForm(); await refresh(); }
  } catch (reason) { if (gen === generation) await failure(reason); }
  finally { if (gen === generation) busy.value = false; }
}
async function remove(target: DeployTarget) {
  if (!project.value || !canRun.value || busy.value) return;
  const gen = generation; busy.value = true; error.value = '';
  try { await removeDeployTarget(project.value.id, target.id); if (gen === generation) await refresh(); }
  catch (reason) { if (gen === generation) await failure(reason); }
  finally { if (gen === generation) busy.value = false; }
}
async function rollback(job: Deployment) {
  if (!project.value || !canRun.value || busy.value) return;
  const gen = generation; busy.value = true; error.value = '';
  try {
    const next = await rollbackDeployment(project.value.id, job.id);
    if (gen === generation) await router.push({ name: 'project-deployments', params: { slug: slug.value, deploymentId: next.id } });
  } catch (reason) { if (gen === generation) await failure(reason); }
  finally { if (gen === generation) busy.value = false; }
}
const activeTarget = (id: string) => jobs.value.some(job => job.deployTargetId === id && deployIsActive(job.status));
function status(next: Deployment) { selected.value = next; const index = jobs.value.findIndex(job => job.id === next.id); if (index >= 0) jobs.value[index] = next; }
function schedule() { if (disposed) return; refreshTimer = setTimeout(async () => { await refresh(); schedule(); }, 10000); }
watch(() => project.value?.id, () => { ++generation; clearData(); busy.value = false; if (project.value) error.value = ''; void refresh(); }, { immediate: true });
watch(accessVerified, verified => { if (verified) void refresh(); });
watch(canRun, allowed => { if (!allowed) clearForm(); });
watch(() => route.params.deploymentId, () => { selected.value = null; void refresh(); });
schedule();
onBeforeUnmount(() => { disposed = true; ++generation; clearTimeout(refreshTimer); clearForm(); });
</script>
<template>
  <main class="content deploy-page">
    <RouterLink class="inline-link" :to="{ name: 'project-detail', params: { slug } }">← 返回项目</RouterLink>
    <h1>SSH 部署</h1>
    <RouterLink v-if="project && accessVerified" class="inline-link" :to="{ name: 'project-domains', params: { slug } }">管理自定义域名与 HTTPS</RouterLink>
    <p v-if="loading" role="status">正在加载项目权限…</p>
    <ElAlert v-if="accessError || error" :title="accessError || error" type="error" :closable="false" role="alert" />
    <template v-if="project && accessVerified">
      <section class="summary" aria-label="部署目标">
        <h2>部署目标</h2>
        <ElButton v-if="canRun" :disabled="busy" @click="edit()">添加目标</ElButton>
        <ElButton :disabled="busy" @click="refresh">刷新</ElButton>
        <p>使用专用非 root 账号，主机公钥必须通过可信渠道核对。每个目标使用独立发布目录。</p>
        <ElForm v-if="formVisible && canRun" label-position="top" @submit.prevent="save">
          <ElFormItem label="名称"><ElInput v-model="form.name" aria-label="名称" :disabled="busy" /></ElFormItem>
          <ElFormItem label="主机 IPv4 或域名"><ElInput v-model="form.host" aria-label="主机" :disabled="busy || immutableConnection" /></ElFormItem>
          <ElFormItem label="SSH 端口"><ElInputNumber v-model="form.port" aria-label="SSH 端口" :min="1" :max="65535" :disabled="busy || immutableConnection" /></ElFormItem>
          <ElFormItem label="SSH 用户"><ElInput v-model="form.username" aria-label="SSH 用户" :disabled="busy || immutableConnection" /></ElFormItem>
          <ElFormItem label="主机公钥（类型与 Base64，不含主机名和注释）"><ElInput v-model="form.hostKey" aria-label="主机公钥" type="textarea" :disabled="busy" /></ElFormItem>
          <ElFormItem label="部署基础目录"><ElInput v-model="form.basePath" aria-label="部署基础目录" :disabled="busy || immutableConnection" /></ElFormItem>
          <p v-if="immutableConnection">已有部署记录的目标不能迁移主机、账号或目录；迁移时请添加新目标。</p>
          <ElFormItem label="保留版本数"><ElInputNumber v-model="form.retention" aria-label="保留版本数" :min="1" :max="50" :disabled="busy" /></ElFormItem>
          <ElFormItem :label="editing ? 'SSH 私钥（留空保持原密钥）' : '专用无口令 SSH 私钥'">
            <ElInput v-model="form.privateKey" aria-label="SSH 私钥" type="textarea" :rows="4" autocomplete="off" :disabled="busy" />
          </ElFormItem>
          <ElButton native-type="submit" type="primary" :loading="busy">保存目标</ElButton>
          <ElButton :disabled="busy" @click="clearForm">取消</ElButton>
        </ElForm>
        <p v-if="!targets.length">尚未添加部署目标。</p>
        <article v-for="target in targets" :key="target.id" class="deploy-row">
          <div><strong>{{ target.name }}</strong><p>{{ target.username }}@{{ target.host }}:{{ target.port }} · 保留 {{ target.retention }} 个版本</p>
            <small>当前版本（数据库记录）：{{ target.currentReleaseId || '尚未部署' }}</small></div>
          <template v-if="canRun">
            <ElButton :disabled="busy || activeTarget(target.id)" @click="edit(target)">编辑</ElButton>
            <ElPopconfirm title="删除目标并销毁保存的私钥？远端文件将保留。" confirm-button-text="删除" cancel-button-text="取消" @confirm="remove(target)">
              <template #reference><ElButton type="danger" :disabled="busy || activeTarget(target.id)">删除</ElButton></template>
            </ElPopconfirm>
          </template>
        </article>
      </section>
      <section class="summary" aria-label="部署历史">
        <h2>部署历史</h2><p>从成功构建的详情页选择目标即可部署。显示最近 100 个任务。</p>
        <p>切换后发生故障时，数据库记录可能与主机不一致；核对主机后，可再次回滚到记录为当前的保留版本。</p>
        <RouterLink class="inline-link" :to="{ name: 'project-builds', params: { slug } }">查看构建</RouterLink>
        <p v-if="!jobs.length">暂无部署记录。</p>
        <article v-for="job in jobs" :key="job.id" class="deploy-row">
          <div><RouterLink class="inline-link" :to="{ name: 'project-deployments', params: { slug, deploymentId: job.id } }">{{ job.action === 'rollback' ? '回滚' : '发布' }} {{ job.releaseId }}</RouterLink>
            <p><ElTag>{{ deployStatusText[job.status] }}</ElTag> · {{ new Date(job.createdAt).toLocaleString('zh-CN') }}</p>
            <small>{{ targets.find(target => target.id === job.deployTargetId)?.name || '已删除目标' }} · {{ job.errorMessage }}</small></div>
          <ElPopconfirm v-if="canRun && job.retained && job.status === 'succeeded' && job.action === 'deploy' && targets.some(target => target.id === job.deployTargetId)"
            title="确认切换到这个保留版本？" confirm-button-text="回滚" cancel-button-text="取消" @confirm="rollback(job)">
            <template #reference><ElButton :disabled="busy || activeTarget(job.deployTargetId)">回滚到此版本</ElButton></template>
          </ElPopconfirm>
        </article>
      </section>
      <section v-if="selected" class="summary" aria-label="部署详情">
        <h2>部署日志 · {{ deployStatusText[selected.status] }}</h2><p>{{ selected.id }}</p>
        <DeployLogViewer :key="`${project.id}:${selected.id}`" :project-id="project.id" :deployment-id="selected.id"
          @status="status" @end="refresh" @unauthorized="failure(new ProjectApiError('登录已失效。', 401))"
          @forbidden="failure(new ProjectApiError('项目访问权限已撤销。', 403))" />
      </section>
    </template>
  </main>
</template>
<style scoped>
.deploy-page { --el-color-primary: var(--brand, #8b5cf6); --el-bg-color: var(--panel, #18181b); --el-fill-color-blank: var(--panel, #18181b); --el-text-color-primary: var(--text, #e4e4e7); --el-text-color-regular: var(--text, #e4e4e7); --el-border-color: var(--line, #3f3f46); }
.deploy-row { display: flex; align-items: center; flex-wrap: wrap; gap: 1rem; border-top: 1px solid var(--line, #3f3f46); padding: 1rem 0; overflow-wrap: anywhere; }
.deploy-row > div { flex: 1; min-width: 200px; }
.el-form { max-width: 720px; margin-block: 1.5rem; }
.summary { margin-block: 1.5rem; }
</style>
