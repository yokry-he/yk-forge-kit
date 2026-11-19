<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router';
import type { HealthResponse } from '@forgekit/contracts';
import { authSession, oidcEnabled, restoreSession } from './auth/session';
import { requiresOidcProjectAccess } from './auth/return-path';

const route = useRoute();
const router = useRouter();
const apiOnline = ref(false);
const pageName = computed(() => route.path.startsWith('/auth/') ? '用户中心' : route.path === '/assets' ? '资产中心' : route.path === '/projects/new' ? '创建项目' : route.path === '/projects' ? '项目列表' : route.name === 'project-builds' ? '构建记录' : route.name === 'project-build' ? '构建详情' : '项目详情');

// A token may expire while the user is already viewing a project page.
watch(authSession, (next, previous) => {
  if (oidcEnabled && previous && !next && requiresOidcProjectAccess(route.path)) {
    void router.replace({ path: '/auth/login', query: { returnTo: route.fullPath } });
  }
});

onMounted(async () => {
  try { await restoreSession(); } catch { /* Login screen remains available if restore fails. */ }
  try {
    const response = await fetch('/api/v1/health', { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return;
    const health = await response.json() as HealthResponse;
    apiOnline.value = health.status === 'ok';
  } catch { /* Local planning views remain usable without the API. */ }
});
</script>

<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="brand"><span>◆</span> YKForgeKit <small>WORKSPACE</small></div>
      <div class="menu-title">工作空间</div>
      <RouterLink to="/projects/new" class="menu" active-class="active">◈　创建项目</RouterLink>
      <RouterLink to="/projects" class="menu" active-class="active">▦　项目列表</RouterLink>
      <RouterLink to="/assets" class="menu" active-class="active">◫　资产中心</RouterLink>
      <RouterLink to="/auth/login" class="menu" active-class="active">◇　用户中心 <small>{{ authSession ? '已登录' : oidcEnabled ? '登录' : '本机模式' }}</small></RouterLink>
      <div class="side-status">{{ apiOnline ? '● 基础 API 已连接' : '○ 本地规划模式' }}</div>
    </aside>
    <main class="main">
      <header class="topbar">工作空间 <span>/ {{ pageName }}</span><b>EARLY ACCESS</b></header>
      <RouterView />
    </main>
  </div>
</template>
