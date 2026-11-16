<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { finishSignIn, finishSignOut } from '../auth/session';

const props = defineProps<{ kind: 'login' | 'logout' }>();
const router = useRouter();
const error = ref('');
onMounted(async () => {
  try {
    if (props.kind === 'login') await router.replace(await finishSignIn());
    else { await finishSignOut(); await router.replace('/auth/login'); }
  } catch (reason) { error.value = reason instanceof Error ? reason.message : '无法完成认证回调。'; }
});
</script>

<template>
  <div class="content auth-page">
    <div class="eyebrow">AUTHENTICATION</div>
    <h1>验证<span>会话</span></h1>
    <section class="state-card" :role="error ? 'alert' : 'status'">
      <template v-if="error"><strong>认证回调失败</strong><p>{{ error }}</p><RouterLink class="primary-link" to="/auth/login">返回登录页</RouterLink></template>
      <template v-else>正在处理身份提供方的回调，请稍候…</template>
    </section>
  </div>
</template>
