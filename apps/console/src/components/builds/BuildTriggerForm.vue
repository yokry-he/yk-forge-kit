<script setup lang="ts">
import { ref, onBeforeUnmount, watch } from 'vue';
import { EnvironmentNameSchema, type Build } from '@forgekit/contracts';
import { triggerBuild } from '../../api/builds';
import { ProjectApiError } from '../../api/projects';

const props = defineProps<{
  projectId: string;
  canRun: boolean;
  initialSourceRef?: string;
  initialTarget?: 'h5' | 'mp-weixin' | 'mp-alipay';
}>();

const emit = defineEmits<{
  created: [build: Build];
  unauthorized: [];
  forbidden: [];
}>();

const sourceRef = ref(props.initialSourceRef ?? '');
const environmentName = ref('');
const target = ref<'h5' | 'mp-weixin' | 'mp-alipay'>(props.initialTarget ?? 'h5');
const submitting = ref(false);
const error = ref('');

let epoch = 0;
onBeforeUnmount(() => { ++epoch; });
watch(() => props.projectId, () => { ++epoch; submitting.value = false; error.value = ''; sourceRef.value = props.initialSourceRef ?? ''; environmentName.value = ''; target.value = props.initialTarget ?? 'h5'; });
async function submitBuild(): Promise<void> {
  if (!props.canRun || submitting.value) {
    return;
  }

  const trimmed = sourceRef.value.trim();
  if (trimmed.length < 1 || trimmed.length > 1024) {
    error.value = '请输入 1 到 1024 个字符的不可变来源。';
    return;
  }

  const environment = environmentName.value.trim();
  if (environment && !EnvironmentNameSchema.safeParse(environment).success) { error.value = '请输入有效的环境名称。'; return; }
  const current = ++epoch;
  submitting.value = true;
  error.value = '';

  try {
    const build = (target.value === 'mp-weixin' || target.value === 'mp-alipay') && trimmed === 'template:uniapp'
      ? await triggerBuild(props.projectId, trimmed, environment || undefined, target.value)
      : await triggerBuild(props.projectId, trimmed, ...(environment ? [environment] : []));
    if (current === epoch) emit('created', build);
  } catch (reason) {
    if (current !== epoch) return;
    if (reason instanceof ProjectApiError && reason.status === 401) {
      emit('unauthorized');
      return;
    }
    if (reason instanceof ProjectApiError && reason.status === 403) emit('forbidden');
    error.value = '构建触发失败，请稍后重试。';
  } finally {
    if (current === epoch) submitting.value = false;
  }
}
</script>

<template>
  <form class="build-trigger-form" @submit.prevent="submitBuild">
    <div class="build-trigger-form__field">
      <label for="build-source-ref" class="build-trigger-form__label">
        不可变来源
      </label>
      <input
        id="build-source-ref"
        v-model="sourceRef"
        class="build-trigger-form__input"
        type="text"
        name="sourceRef"
        placeholder="例如 template:vue-web"
        :disabled="!canRun || submitting"
        maxlength="1024"
        autocomplete="off"
      />
      <p class="build-trigger-form__hint">
        请输入来源键。当前 Docker Runner 仅支持与项目模板匹配的 template:vue-web、template:vue-admin、template:uniapp 或 template:nuxt-site；尚不支持 Git 或源码快照。
      </p>
    </div>

    <div class="build-trigger-form__field">
      <label for="build-environment" class="build-trigger-form__label">构建环境（默认 preview）</label>
      <input id="build-environment" v-model="environmentName" class="build-trigger-form__input" placeholder="preview" maxlength="64" :disabled="!canRun || submitting" />
    </div>
    <div v-if="sourceRef === 'template:uniapp'" class="build-trigger-form__field">
      <label for="build-target">构建目标</label>
      <select id="build-target" v-model="target" :disabled="!canRun || submitting"><option value="h5">H5</option><option value="mp-weixin">微信小程序</option><option value="mp-alipay">支付宝小程序</option></select>
    </div>
    <div v-if="error" class="build-trigger-form__error" role="alert">
      {{ error }}
    </div>

    <button
      type="submit"
      class="build-trigger-form__submit"
      :disabled="!canRun || submitting"
    >
      <span v-if="submitting" role="status">触发中…</span>
      <span v-else>触发构建</span>
    </button>
  </form>
</template>

<style scoped>
.build-trigger-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  max-width: 40rem;
  margin: 1rem 0;
}

.build-trigger-form__field {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.build-trigger-form__label {
  font-weight: 600;
}

.build-trigger-form__input {
  background: var(--build-surface, #18181b);
  border: 1px solid var(--build-border, #3f3f46);
  border-radius: 0.25rem;
  color: var(--build-text, #e4e4e7);
  padding: 0.5rem 0.75rem;
  font-size: 0.875rem;
  width: 100%;
}

.build-trigger-form__input:focus {
  outline: 2px solid var(--build-accent, #8b5cf6);
  outline-offset: 2px;
}

.build-trigger-form__input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.build-trigger-form__hint {
  font-size: 0.75rem;
  color: var(--build-muted, #a1a1aa);
  margin: 0;
}

.build-trigger-form__error {
  background: rgba(239, 68, 68, 0.1);
  border: 1px solid rgba(239, 68, 68, 0.3);
  color: #fca5a5;
  padding: 0.5rem 0.75rem;
  border-radius: 0.25rem;
  font-size: 0.875rem;
}

.build-trigger-form__submit {
  align-self: flex-start;
  background: var(--build-accent, #8b5cf6);
  border: none;
  border-radius: 0.25rem;
  color: white;
  cursor: pointer;
  font-weight: 500;
  padding: 0.5rem 1rem;
  transition: background 0.2s;
}

.build-trigger-form__submit:hover:not(:disabled) {
  background: var(--build-accent-hover, #7c3aed);
}

.build-trigger-form__submit:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.build-trigger-form__submit:focus-visible {
  outline: 2px solid var(--build-secondary, #22d3ee);
  outline-offset: 2px;
}
</style>
