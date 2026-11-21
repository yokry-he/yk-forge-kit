<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { ElAlert, ElButton, ElForm, ElFormItem, ElInput, ElInputNumber, ElSelect, ElOption } from 'element-plus';
import 'element-plus/theme-chalk/el-alert.css';
import 'element-plus/theme-chalk/el-button.css';
import 'element-plus/theme-chalk/el-form.css';
import 'element-plus/theme-chalk/el-form-item.css';
import 'element-plus/theme-chalk/el-input.css';
import 'element-plus/theme-chalk/el-input-number.css';
import 'element-plus/theme-chalk/el-select.css';
import 'element-plus/theme-chalk/el-option.css';
import { RuntimeLogInputSchema, type Domain, type DeployTarget, type RuntimeLogSession } from '@forgekit/contracts';
import { useBuildProjectAccess } from '../composables/useBuildProjectAccess';
import { listDomains } from '../api/domains';
import { listDeployTargets } from '../api/deploys';
import { createRuntimeSession, cancelRuntimeSession } from '../api/runtime-logs';
import { ProjectApiError } from '../api/projects';
import { clearSession } from '../auth/session';
import RuntimeLogViewer from '../components/runtime/RuntimeLogViewer.vue';
const route = useRoute(), router = useRouter(), slug = computed(() => String(route.params.slug ?? ''));
const { project, accessVerified, loading, error: accessError } = useBuildProjectAccess(slug);
const domains = ref<Domain[]>([]), targets = ref<DeployTarget[]>([]), selected = ref<RuntimeLogSession | null>(null);
const error = ref(''), busy = ref(false);
const form = reactive({ domainId: '', source: 'caddy-access', lines: 200, level: 'all', windowMinutes: 0, keyword: '' });
let generation = 0;
async function denied(status: number) {
  ++generation; selected.value = null; domains.value = []; targets.value = []; form.domainId = ''; project.value = null;
  error.value = '项目访问权限已失效。';
  if (status === 401) { await clearSession(); await router.replace({ path: '/auth/login', query: { returnTo: route.fullPath } }); }
}
async function failure(reason: unknown) {
  error.value = reason instanceof ProjectApiError ? reason.message : '运行日志服务暂不可用，请重试。';
  if (reason instanceof ProjectApiError && [401, 403, 404].includes(reason.status)) await denied(reason.status);
}
async function start() {
  if (!project.value || !accessVerified.value || busy.value) return;
  const parsed = RuntimeLogInputSchema.safeParse(form);
  if (!parsed.success) { error.value = '请选择站点，行数为 1–1000，关键词最多 200 字且不含控制字符。'; return; }
  const gen = generation, pid = project.value.id;
  busy.value = true; error.value = '';
  try {
    const previous = selected.value; selected.value = null;
    if (previous) await cancelRuntimeSession(pid, previous.id);
    const next = await createRuntimeSession(pid, parsed.data);
    if (gen !== generation) { await cancelRuntimeSession(pid, next.id); return; }
    selected.value = next;
  } catch (reason) { if (gen === generation) await failure(reason); }
  finally { if (gen === generation) busy.value = false; }
}
watch([() => project.value?.id, accessVerified], async ([pid, verified], previous) => {
  const gen = ++generation; busy.value = false;
  if (pid !== previous?.[0] || !verified) { selected.value = null; domains.value = []; targets.value = []; form.domainId = ''; }
  if (!pid || !verified) return;
  try {
    const [sites, hosts] = await Promise.all([listDomains(pid), listDeployTargets(pid)]);
    if (gen !== generation) return;
    domains.value = sites.filter(site => site.verifiedAt && site.status !== 'revoked'); targets.value = hosts;
    form.domainId ||= domains.value[0]?.id ?? '';
  } catch (reason) { if (gen === generation) await failure(reason); }
}, { immediate: true });
onBeforeUnmount(() => { ++generation; });
</script>
<template>
  <main class="content">
    <RouterLink class="inline-link" :to="{ name: 'project-domains', params: { slug } }">← 返回域名与 HTTPS</RouterLink>
    <h1>运行日志</h1>
    <p v-if="loading" role="status">正在加载项目权限…</p>
    <ElAlert v-if="accessError || error" :title="accessError || error" type="error" :closable="false" role="alert" />
    <template v-if="project && accessVerified">
      <p>查看已部署站点的最近日志并实时跟随。每次最多 60 秒、1 MiB；日志按当前项目秘密值脱敏，短期缓冲保留至会话到期后 10 分钟。</p>
      <ElForm label-position="top" @submit.prevent="start">
        <ElFormItem label="主机 / 站点"><ElSelect v-model="form.domainId" aria-label="主机与站点">
          <ElOption v-for="site in domains" :key="site.id" :value="site.id" :label="`${targets.find(t => t.id === site.deployTargetId)?.name || '部署目标'} / ${site.hostname}`" />
        </ElSelect></ElFormItem>
        <ElFormItem label="日志来源"><ElSelect v-model="form.source" aria-label="日志来源">
          <ElOption label="Caddy 访问日志" value="caddy-access" /><ElOption label="Caddy 请求错误日志" value="caddy-error" />
        </ElSelect></ElFormItem>
        <ElFormItem label="最近行数"><ElInputNumber v-model="form.lines" aria-label="最近行数" :min="1" :max="1000" :precision="0" /></ElFormItem>
        <ElFormItem label="级别"><ElSelect v-model="form.level" aria-label="日志级别">
          <ElOption label="全部级别" value="all" /><ElOption v-for="level in ['debug', 'info', 'warn', 'error', 'fatal', 'panic']" :key="level" :label="level" :value="level" />
        </ElSelect></ElFormItem>
        <ElFormItem label="时间窗口"><ElSelect v-model="form.windowMinutes" aria-label="时间窗口">
          <ElOption label="不限制时间" :value="0" /><ElOption v-for="minutes in [5, 15, 60]" :key="minutes" :label="`最近 ${minutes} 分钟起`" :value="minutes" />
        </ElSelect></ElFormItem>
        <ElFormItem label="关键词（区分大小写的文本匹配）"><ElInput v-model="form.keyword" aria-label="关键词" :maxlength="200" /></ElFormItem>
        <ElButton native-type="submit" type="primary" :loading="busy" :disabled="!form.domainId">开始查看</ElButton>
      </ElForm>
      <p v-if="!domains.length">暂无可查看的站点，请先完成 SSH 部署和域名验证。</p>
      <p>筛选在最近行数之后应用，不扫描历史文件。空日志或缺少文件时，请先按文档重新验证域名或刷新证书状态以启用日志配置。</p>
      <RuntimeLogViewer v-if="selected" :key="selected.id" :project-id="project.id" :session-id="selected.id" @denied="denied" />
    </template>
  </main>
</template>
