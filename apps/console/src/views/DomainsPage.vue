<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { ElAlert, ElButton, ElForm, ElFormItem, ElInput, ElSelect, ElOption, ElTag, ElPopconfirm } from 'element-plus';
import 'element-plus/theme-chalk/el-alert.css';
import 'element-plus/theme-chalk/el-button.css';
import 'element-plus/theme-chalk/el-form.css';
import 'element-plus/theme-chalk/el-form-item.css';
import 'element-plus/theme-chalk/el-input.css';
import 'element-plus/theme-chalk/el-select.css';
import 'element-plus/theme-chalk/el-option.css';
import 'element-plus/theme-chalk/el-tag.css';
import 'element-plus/theme-chalk/el-popconfirm.css';
import { DomainCreateSchema, type Domain, type DomainOperation, type DeployTarget } from '@forgekit/contracts';
import { useBuildProjectAccess } from '../composables/useBuildProjectAccess';
import { listDeployTargets } from '../api/deploys';
import { createDomain, listDomains, listDomainOperations, getDomainOperation, requestDomainOperation,
  domainStatusText, domainActionText, domainOperationStatusText, domainTlsModeText } from '../api/domains';
import { ProjectApiError } from '../api/projects';
import { clearSession } from '../auth/session';
import DomainLogViewer from '../components/domains/DomainLogViewer.vue';
const route = useRoute(), router = useRouter();
const slug = computed(() => String(route.params.slug ?? ''));
const { project, accessVerified, error: accessError, loading, canRun } = useBuildProjectAccess(slug);
const domains = ref<Domain[]>([]), operations = ref<DomainOperation[]>([]), targets = ref<DeployTarget[]>([]);
const selected = ref<DomainOperation | null>(null), error = ref(''), busy = ref(false);
const form = reactive({ hostname: '', deployTargetId: '' });
let generation = 0, requestVersion = 0, disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
function clear() { domains.value = []; operations.value = []; targets.value = []; selected.value = null; form.hostname = ''; form.deployTargetId = ''; }
async function failure(reason: unknown) {
  error.value = reason instanceof ProjectApiError ? reason.message : '域名服务暂不可用，请重试。';
  if (reason instanceof ProjectApiError && [401, 403, 404].includes(reason.status)) {
    ++generation; clear(); project.value = null;
    if (reason.status === 401) { await clearSession(); await router.replace({ path: '/auth/login', query: { returnTo: route.fullPath } }); }
  }
}
async function refresh() {
  const pid = project.value?.id, gen = generation, version = ++requestVersion;
  if (!pid || !accessVerified.value) return;
  try {
    const [nextDomains, nextOps, nextTargets] = await Promise.all([listDomains(pid), listDomainOperations(pid), listDeployTargets(pid)]);
    if (gen !== generation || version !== requestVersion) return;
    const oid = String(route.params.operationId ?? '');
    const nextSelected = nextOps.find(op => op.id === oid) ?? (oid ? await getDomainOperation(pid, oid) : null);
    if (gen !== generation || version !== requestVersion) return;
    domains.value = nextDomains; operations.value = nextOps; targets.value = nextTargets; selected.value = nextSelected;
    if (!form.deployTargetId) form.deployTargetId = nextTargets.find(target => target.currentReleaseId)?.id ?? '';
  } catch (reason) { if (gen === generation && version === requestVersion) await failure(reason); }
}
async function add() {
  if (!project.value || !canRun.value || busy.value) return;
  const parsed = DomainCreateSchema.safeParse(form);
  if (!parsed.success) { error.value = '请选择已部署的 SSH 目标，并输入有效域名（不含协议、端口、路径或通配符）。'; return; }
  const gen = generation; busy.value = true; error.value = '';
  try { await createDomain(project.value.id, parsed.data); if (gen === generation) { form.hostname = ''; await refresh(); } }
  catch (reason) { if (gen === generation) await failure(reason); }
  finally { if (gen === generation) busy.value = false; }
}
async function run(domain: Domain, action: DomainOperation['action']) {
  if (!project.value || !canRun.value || busy.value) return;
  const gen = generation; busy.value = true; error.value = '';
  try {
    const op = await requestDomainOperation(project.value.id, domain.id, action);
    if (gen === generation) { await router.push({ name: 'project-domains', params: { slug: slug.value, operationId: op.id } }); await refresh(); }
  } catch (reason) { if (gen === generation) await failure(reason); }
  finally { if (gen === generation) busy.value = false; }
}
const targetBusy = (id: string) => operations.value.some(op => op.deployTargetId === id && ['pending', 'running'].includes(op.status));
function status(op: DomainOperation) { selected.value = op; const index = operations.value.findIndex(row => row.id === op.id); if (index >= 0) operations.value[index] = op; }
const time = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未获取';
function schedule() { if (disposed) return; timer = setTimeout(async () => { await refresh(); schedule(); }, 10000); }
watch(() => project.value?.id, () => { ++generation; clear(); busy.value = false; if (project.value) error.value = ''; void refresh(); }, { immediate: true });
watch(accessVerified, verified => { if (verified) void refresh(); });
watch(canRun, allowed => { if (!allowed) { form.hostname = ''; form.deployTargetId = ''; } });
watch(() => route.params.operationId, () => { selected.value = null; void refresh(); });
schedule();
onBeforeUnmount(() => { disposed = true; ++generation; clearTimeout(timer); clear(); });
</script>
<template>
  <main class="content domains-page">
    <RouterLink class="inline-link" :to="{ name: 'project-deployments', params: { slug } }">← 返回 SSH 部署</RouterLink>
    <h1>自定义域名与 HTTPS</h1>
    <p v-if="loading" role="status">正在加载项目权限…</p>
    <ElAlert v-if="accessError || error" :title="accessError || error" type="error" :closable="false" role="alert" />
    <template v-if="project && accessVerified">
      <section class="summary" aria-label="域名管理">
        <ElButton :disabled="busy" @click="refresh">刷新</ElButton>
        <p>先通过 SSH 发布站点。将域名的所有 A/AAAA 指向目标主机，再添加下方 TXT 所有权记录，最后验证并启用 HTTPS。</p>
        <p>Caddy 自动续期；平台每天检查一次，也可手动刷新。检查失败后保留历史证书，HTTPS 可用性未确认；曾取得证书且仍保留声明的绑定会继续每日检查。请留意检查时间及错误。</p>
        <ElForm v-if="canRun" label-position="top" @submit.prevent="add">
          <ElFormItem label="已部署的 SSH 目标">
            <ElSelect v-model="form.deployTargetId" aria-label="部署目标" :disabled="busy">
              <ElOption v-for="target in targets.filter(row => row.currentReleaseId)" :key="target.id" :label="target.name" :value="target.id" />
            </ElSelect>
          </ElFormItem>
          <ElFormItem label="自定义域名"><ElInput v-model="form.hostname" aria-label="自定义域名" placeholder="www.example.com" :disabled="busy" /></ElFormItem>
          <ElButton native-type="submit" type="primary" :loading="busy" :disabled="!form.deployTargetId">添加域名</ElButton>
        </ElForm>
        <p v-if="!domains.length">尚未绑定域名。</p>
        <article v-for="domain in domains" :key="domain.id" class="domain-row">
          <h2>{{ domain.hostname }} <ElTag>{{ domainStatusText[domain.status] }}</ElTag></h2>
          <p>{{ targets.find(target => target.id === domain.deployTargetId)?.name || '已删除目标' }} · {{ domainTlsModeText[domain.tlsMode] }}</p>
          <p v-if="domain.status !== 'revoked'">A/AAAA 指向：{{ targets.find(target => target.id === domain.deployTargetId)?.host }}（主机名需使用其解析后的 IP 地址）</p>
          <dl v-if="domain.status !== 'revoked'">
            <dt>TXT 记录名称</dt><dd><code>{{ domain.verificationName }}</code></dd>
            <dt>TXT 记录值</dt><dd><code>{{ domain.verificationValue }}</code></dd>
          </dl>
          <p>证书到期：{{ time(domain.certificateExpiresAt) }} · 最近检查：{{ time(domain.lastCheckedAt) }}</p>
          <p v-if="domain.certificateFingerprint">证书 SHA-256：<code>{{ domain.certificateFingerprint }}</code></p>
          <p v-if="domain.errorCode" role="alert">最近错误：{{ domain.errorCode }}；请查看操作日志。</p>
          <a v-if="domain.status === 'active'" class="inline-link" :href="`https://${domain.hostname}`" target="_blank" rel="noopener noreferrer">打开 HTTPS 站点</a>
          <div v-if="canRun && domain.status !== 'revoked'" class="actions">
            <ElButton :disabled="busy || targetBusy(domain.deployTargetId)" @click="run(domain, 'verify')">验证并启用 HTTPS</ElButton>
            <ElButton v-if="domain.verifiedAt" :disabled="busy || targetBusy(domain.deployTargetId)" @click="run(domain, 'refresh')">刷新证书状态</ElButton>
            <ElPopconfirm title="移除域名路由？成功后释放绑定，不吊销 CA 证书。" confirm-button-text="移除" cancel-button-text="取消" @confirm="run(domain, 'remove')">
              <template #reference><ElButton type="danger" :disabled="busy || targetBusy(domain.deployTargetId)">移除域名</ElButton></template>
            </ElPopconfirm>
          </div>
        </article>
      </section>
      <section class="summary" aria-label="域名操作历史">
        <h2>操作历史</h2><p v-if="!operations.length">暂无操作记录。</p>
        <article v-for="op in operations" :key="op.id" class="operation-row">
          <RouterLink class="inline-link" :to="{ name: 'project-domains', params: { slug, operationId: op.id } }">{{ domainActionText[op.action] }} · {{ domains.find(row => row.id === op.domainId)?.hostname || op.domainId }}</RouterLink>
          <p>{{ domainOperationStatusText[op.status] }} · {{ time(op.createdAt) }} · {{ op.errorCode }}</p>
        </article>
      </section>
      <section v-if="selected" class="summary" aria-label="域名操作详情">
        <h2>{{ domainActionText[selected.action] }} · {{ domainOperationStatusText[selected.status] }}</h2><p>{{ selected.id }}</p>
        <DomainLogViewer :key="`${project.id}:${selected.id}`" :project-id="project.id" :operation-id="selected.id" @status="status" @end="refresh"
          @unauthorized="failure(new ProjectApiError('登录已失效。', 401))" @forbidden="failure(new ProjectApiError('项目访问权限已撤销。', 403))" />
      </section>
    </template>
  </main>
</template>
<style scoped>
.domains-page { --el-color-primary: var(--brand, #8b5cf6); --el-bg-color: var(--panel, #18181b); --el-fill-color-blank: var(--panel, #18181b); --el-text-color-primary: var(--text, #e4e4e7); --el-text-color-regular: var(--text, #e4e4e7); --el-border-color: var(--line, #3f3f46); }
.summary { margin-block: 1.5rem; }
.domain-row, .operation-row { border-top: 1px solid var(--line, #3f3f46); padding: 1rem 0; overflow-wrap: anywhere; }
.el-form { max-width: 720px; margin-block: 1.5rem; }
.actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1rem; }
dd { margin: .4rem 0 1rem; }
</style>
