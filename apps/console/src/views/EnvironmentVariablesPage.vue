<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
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
import { EnvironmentNameSchema, VariableInputSchema, VariableNameSchema, type EnvironmentVariable } from '@forgekit/contracts';
import { useBuildProjectAccess } from '../composables/useBuildProjectAccess';
import { listEnvironments, listEnvironmentVariables, saveEnvironmentVariable, removeEnvironmentVariable } from '../api/environment-variables';
import { ProjectApiError } from '../api/projects';
const route = useRoute();
const slug = computed(() => String(route.params.slug ?? ''));
const { project, accessVerified, loading, error: accessError, canRun } = useBuildProjectAccess(slug);
const environment = ref('preview'), environments = ref<string[]>(['preview', 'production']);
const rows = ref<EnvironmentVariable[]>([]), error = ref(''), busy = ref(false), fetching = ref(false), editing = ref(false);
const form = reactive({ name: '', kind: 'plain' as 'plain' | 'secret', value: '' });
let generation = 0;
function reset() { form.name = ''; form.kind = 'plain'; form.value = ''; editing.value = false; }
function failure(reason: unknown) {
  // Fixed copy: never echo request values or arbitrary transport errors.
  error.value = '环境变量操作失败，请检查权限或稍后重试。';
  if (reason instanceof ProjectApiError && [401, 403, 404].includes(reason.status)) { ++generation; rows.value = []; reset(); project.value = null; }
}
async function refresh() {
  const pid = project.value?.id, env = environment.value, gen = ++generation;
  rows.value = []; reset(); error.value = '';
  if (!pid || !accessVerified.value) return;
  if (!EnvironmentNameSchema.safeParse(env).success) { error.value = '环境名称格式无效。'; return; }
  fetching.value = true;
  try {
    const [next, names] = await Promise.all([listEnvironmentVariables(pid, env), listEnvironments(pid)]);
    if (gen !== generation) return;
    rows.value = next; environments.value = [...new Set([...names.map(row => row.name), env])];
  } catch (reason) { if (gen === generation) failure(reason); }
  finally { if (gen === generation) fetching.value = false; }
}
function edit(row: EnvironmentVariable) {
  editing.value = true; form.name = row.name; form.kind = row.kind; form.value = row.kind === 'plain' ? row.value ?? '' : '';
}
async function save() {
  const pid = project.value?.id, gen = generation, env = environment.value;
  if (!pid || !canRun.value || busy.value) return;
  if (!VariableNameSchema.safeParse(form.name).success || !VariableInputSchema.safeParse({ kind: form.kind, value: form.value }).success) {
    error.value = '请使用大写变量名，值最多 16 KiB；秘密值及其非空行至少 4 个字符。平台保留名不可用。'; return;
  }
  busy.value = true; error.value = '';
  const input = { kind: form.kind, value: form.value }, name = form.name;
  form.value = ''; // Keep no secret in the form while the request is pending.
  try { await saveEnvironmentVariable(pid, env, name, input); if (gen === generation) await refresh(); }
  catch (reason) { if (gen === generation) failure(reason); }
  finally { busy.value = false; }
}
async function remove(name: string) {
  const pid = project.value?.id, gen = generation, env = environment.value;
  if (!pid || !canRun.value || busy.value) return;
  busy.value = true;
  try { await removeEnvironmentVariable(pid, env, name); if (gen === generation) await refresh(); }
  catch (reason) { if (gen === generation) failure(reason); }
  finally { busy.value = false; }
}
watch([() => project.value?.id, accessVerified, environment], () => { void refresh(); }, { immediate: true });
watch(canRun, allowed => { if (!allowed) reset(); });
onBeforeUnmount(() => { ++generation; rows.value = []; reset(); });
</script>
<template>
  <main class="content variables-page">
    <RouterLink :to="`/projects/${slug}`">返回项目</RouterLink>
    <h1>环境变量与秘密值</h1>
    <p>构建默认使用 preview，SSH 部署使用其记录的环境。修改对之后启动的任务生效。</p>
    <ElAlert v-if="accessError || error" :title="accessError || error" type="error" :closable="false" role="alert" />
    <p v-if="loading" role="status">正在检查项目权限…</p>
    <template v-if="project && accessVerified">
      <label for="variable-environment">项目环境</label>
      <ElSelect id="variable-environment" v-model="environment" aria-label="项目环境" filterable allow-create default-first-option :disabled="busy">
        <ElOption v-for="name in environments" :key="name" :label="name" :value="name" />
      </ElSelect>
      <ElButton :disabled="busy || fetching" @click="refresh">刷新</ElButton>
      <p v-if="fetching" role="status">正在加载环境变量…</p>
      <p v-else-if="!rows.length" role="status">此环境尚未设置变量。</p>
      <ul class="variable-list">
        <li v-for="row in rows" :key="row.name">
          <strong>{{ row.name }}</strong> <ElTag>{{ row.kind === 'secret' ? '秘密值（仅可替换）' : '普通变量' }}</ElTag>
          <pre>{{ row.kind === 'secret' ? '••••••' : row.value }}</pre>
          <small>更新于 {{ new Date(row.updatedAt).toLocaleString('zh-CN') }} · 操作人 {{ row.updatedBy }}</small>
          <template v-if="canRun">
            <ElButton :disabled="busy" @click="edit(row)">{{ row.kind === 'secret' ? '替换秘密值' : '编辑' }}</ElButton>
            <ElPopconfirm title="确定删除此变量？" confirm-button-text="删除" cancel-button-text="取消" @confirm="remove(row.name)">
              <template #reference><ElButton :disabled="busy" type="danger">删除</ElButton></template>
            </ElPopconfirm>
          </template>
        </li>
      </ul>
      <ElForm v-if="canRun" label-position="top" @submit.prevent="save">
        <h2>{{ editing ? '替换变量' : '添加变量' }}</h2>
        <ElFormItem label="变量名"><ElInput v-model="form.name" aria-label="变量名" :disabled="editing || busy" placeholder="例如 API_URL" :maxlength="128" /></ElFormItem>
        <ElFormItem label="类型"><ElSelect v-model="form.kind" aria-label="类型" :disabled="busy" @change="form.value = ''"><ElOption label="普通变量（成员可见）" value="plain" /><ElOption label="秘密值（仅写入）" value="secret" /></ElSelect></ElFormItem>
        <p>前端打包可能将变量写入公开文件，请仅向可信代码提供必要值。</p>
        <p>秘密值不能读取。改为普通变量时，必须重新填写可见值。</p>
        <ElFormItem :label="form.kind === 'secret' ? '设置新的秘密值' : '变量值'">
          <ElInput v-model="form.value" aria-label="变量值" :type="form.kind === 'secret' ? 'password' : 'textarea'" autocomplete="new-password" :disabled="busy" :maxlength="16384" />
        </ElFormItem>
        <ElButton type="primary" native-type="submit" :loading="busy">保存</ElButton>
        <ElButton :disabled="busy" @click="reset">取消</ElButton>
      </ElForm>
      <p v-else>当前角色仅可查看普通变量和秘密值名称。</p>
    </template>
  </main>
</template>
<style scoped>
.variables-page { --el-color-primary: var(--brand, #8b5cf6); --el-bg-color: var(--panel, #18181b); --el-fill-color-blank: var(--panel, #18181b); --el-text-color-primary: var(--text, #e4e4e7); --el-text-color-regular: var(--text, #e4e4e7); --el-border-color: var(--line, #3f3f46); min-width: 0; }
.variable-list { padding: 0; list-style: none; }
.variable-list li { padding: 1rem 0; border-bottom: 1px solid var(--line, #3f3f46); overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
small { display: block; margin-bottom: .5rem; }
.el-form { max-width: 42rem; margin-top: 2rem; }
</style>
