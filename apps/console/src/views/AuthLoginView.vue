<script setup lang="ts">
import { ref } from 'vue';
import { RouterLink } from 'vue-router';
import { useRouter } from 'vue-router';
import { authBusy, authSession, oidcEnabled, startSignIn, startSignOut } from '../auth/session';
import { redeemInvitation } from '../api/invitations';

const error = ref('');
const pending = ref(false);
const inviteCode = ref('');
const redeeming = ref(false);
const redeemError = ref('');
const router = useRouter();
async function submit(): Promise<void> {
  error.value = '';
  pending.value = true;
  try { if (authSession.value) await startSignOut(); else await startSignIn(); }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '登录服务不可用。'; }
  finally { pending.value = false; }
}
async function redeem(): Promise<void> {
  if (!authSession.value || redeeming.value) return;
  redeemError.value = '';
  redeeming.value = true;
  try {
    const result = await redeemInvitation(inviteCode.value.trim());
    inviteCode.value = '';
    await router.push(`/projects/${encodeURIComponent(result.projectSlug)}`);
  } catch (reason) { redeemError.value = reason instanceof Error ? reason.message : '邀请码兑换失败。'; }
  finally { redeeming.value = false; }
}
</script>

<template>
  <div class="content auth-page">
    <div class="eyebrow">ACCOUNT & ACCESS</div>
    <h1>用户<span>中心</span></h1>
    <p class="intro">使用统一身份登录，后续可管理项目成员、资产权限与 CLI 设备授权。</p>
    <section class="panel auth-panel">
      <h2>{{ authSession ? '当前会话' : '账号登录' }}</h2>
      <template v-if="!oidcEnabled"><p>当前为本机开发模式，尚未配置 OIDC 身份提供方。</p><div class="coming">本机模式仅用于开发。正式部署前需配置可信的 OIDC Authority、公开 Client ID 和 API Audience。</div></template>
      <template v-else>
        <p v-if="authBusy">正在恢复会话…</p>
        <div v-else-if="authSession" class="account-info"><strong>{{ authSession.displayName }}</strong><small>Subject：{{ authSession.subject }}</small></div>
        <p v-else>点击按钮将跳转到身份提供方完成授权码 + PKCE 登录。</p>
        <button class="auth-button" :disabled="pending || authBusy" @click="submit">{{ pending ? '正在跳转…' : authSession ? '退出登录' : '前往登录' }}</button>
      </template>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <RouterLink class="inline-link" to="/projects">返回工作空间 →</RouterLink>
    </section>
    <section v-if="oidcEnabled && authSession" class="panel auth-panel invite-redeem">
      <h2>加入受邀项目</h2>
      <p>粘贴项目 Owner 发给你的一次性邀请码。只有当前登录的 OIDC 身份能够兑换。</p>
      <label for="invite-code">邀请码</label>
      <input id="invite-code" v-model.trim="inviteCode" type="text" maxlength="43" autocomplete="off" spellcheck="false" placeholder="粘贴 43 位邀请码" />
      <button class="auth-button" :disabled="redeeming || inviteCode.length !== 43" @click="redeem">{{ redeeming ? '正在兑换…' : '兑换并加入项目' }}</button>
      <p v-if="redeemError" class="form-error" role="alert">{{ redeemError }}</p>
    </section>
  </div>
</template>
