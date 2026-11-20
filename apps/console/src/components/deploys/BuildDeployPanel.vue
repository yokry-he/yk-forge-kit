<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { ElButton, ElSelect, ElOption } from 'element-plus';
import 'element-plus/theme-chalk/el-button.css';
import 'element-plus/theme-chalk/el-select.css';
import 'element-plus/theme-chalk/el-option.css';
import type { DeployTarget } from '@forgekit/contracts';
import { listDeployTargets, triggerDeployment } from '../../api/deploys';
import { ProjectApiError } from '../../api/projects';
const props = defineProps<{ projectId: string; slug: string; buildId: string; canManage: boolean }>();
const emit = defineEmits<{ unauthorized: []; forbidden: [] }>();
const router = useRouter();
const targets = ref<DeployTarget[]>([]), selected = ref(''), busy = ref(false), error = ref('');
let generation = 0;
watch(() => [props.projectId, props.buildId], async () => {
  const gen = ++generation; targets.value = []; selected.value = ''; error.value = ''; busy.value = false;
  try { const result = await listDeployTargets(props.projectId); if (gen === generation) targets.value = result; }
  catch (reason) { if (gen === generation) failure(reason); }
}, { immediate: true });
onBeforeUnmount(() => { ++generation; });
function failure(reason: unknown) {
  error.value = reason instanceof ProjectApiError ? reason.message : '部署请求失败，请重试。';
  if (reason instanceof ProjectApiError && reason.status === 401) emit('unauthorized');
  if (reason instanceof ProjectApiError && [403, 404].includes(reason.status)) emit('forbidden');
}
async function deploy() {
  if (!props.canManage || busy.value || !selected.value) return;
  const gen = generation; busy.value = true; error.value = '';
  try {
    const job = await triggerDeployment(props.projectId, props.buildId, selected.value);
    if (gen === generation) await router.push({ name: 'project-deployments', params: { slug: props.slug, deploymentId: job.id } });
  } catch (reason) { if (gen === generation) failure(reason); }
  finally { if (gen === generation) busy.value = false; }
}
</script>
<template>
  <section class="summary" aria-label="SSH 部署">
    <h2>部署到自有 Linux 主机</h2>
    <p><RouterLink class="inline-link" :to="{ name: 'project-deployments', params: { slug } }">管理部署目标与历史</RouterLink></p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="canManage">
      <ElSelect v-model="selected" aria-label="部署目标" placeholder="选择部署目标" :disabled="busy">
        <ElOption v-for="target in targets" :key="target.id" :label="target.name" :value="target.id" />
      </ElSelect>
      <ElButton :disabled="!selected" :loading="busy" type="primary" @click="deploy">部署此构建</ElButton>
      <p v-if="!targets.length">尚未添加部署目标，请先添加专用 SSH 账号和主机公钥。</p>
    </template>
    <p v-else>仅项目所有者和编辑者可发起部署。</p>
  </section>
</template>
