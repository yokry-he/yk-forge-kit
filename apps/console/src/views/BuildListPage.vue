<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import type { Build } from '@forgekit/contracts';
import { listBuilds, getBuild } from '../api/builds';
import { ProjectApiError } from '../api/projects';
import { clearSession, oidcEnabled } from '../auth/session';
import { useBuildProjectAccess } from '../composables/useBuildProjectAccess';
import BuildStatusBadge from '../components/builds/BuildStatusBadge.vue';
import BuildTriggerForm from '../components/builds/BuildTriggerForm.vue';

const route = useRoute();
const router = useRouter();

const slug = computed(() => route.params.slug as string);
const {
  project,
  loading: accessLoading,
  error: accessError,
  canRun,
  refresh: refreshAccess,
} = useBuildProjectAccess(slug);

const builds = ref<Build[]>([]);
const loadingBuilds = ref(false);
const loadingMore = ref(false);
const buildError = ref('');
const readDenied = ref('');
const loadMoreError = ref('');
const hasMore = ref(false);
const pageSize = 50;

let generation = 0;
let pendingBuildLoad = true;
let activeRefreshRequest: symbol | undefined;
let loadMoreRequest: symbol | undefined;
let activeRefreshTimer: ReturnType<typeof setInterval> | undefined;

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return dateTimeFormatter.format(date);
}

function formatDuration(build: Build): string {
  if (!build.startedAt) return '—';
  const start = Date.parse(build.startedAt);
  const end = build.finishedAt ? Date.parse(build.finishedAt) : Date.now();
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = seconds % 60;
  return `${minutes}分${remainSeconds}秒`;
}

async function handleUnauthorized(): Promise<void> {
  resetForSlugChange(); project.value = null;
  try { await clearSession(); }
  catch { buildError.value = '本机登录状态清理失败，请重新登录。'; }
  await router.replace({ path: '/auth/login', query: { returnTo: route.fullPath } });
}

function handleApiError(error: ProjectApiError): void {
  if (error.status === 401) {
    buildError.value = '登录已过期，请重新登录。';
    void handleUnauthorized();
  } else if (error.status === 403 || error.status === 404) {
    resetForSlugChange(); project.value = null;
    readDenied.value = '没有权限访问该项目的构建记录。';
  } else if (error.status === 429) {
    buildError.value = '请求过于频繁，请稍后重试。';
  } else if (error.status === 503) {
    buildError.value = '服务暂时不可用，请稍后重试。';
  } else {
    buildError.value = error.message;
  }
}

function replaceGeneration(): number {
  ++generation;
  activeRefreshRequest = undefined;
  loadMoreRequest = undefined;
  loadingBuilds.value = false;
  loadingMore.value = false;
  return generation;
}

async function loadFirstPage(): Promise<void> {
  const gen = replaceGeneration();
  loadingBuilds.value = true;
  buildError.value = '';
  loadMoreError.value = '';
  readDenied.value = '';
  try {
    const projectId = project.value?.id;
    if (!projectId) throw new Error('项目数据未加载');
    const result = await listBuilds(projectId, { limit: pageSize });
    if (gen !== generation) return;
    builds.value = [...new Map(result.map((build) => [build.id, build])).values()].sort((a, b) => b.number - a.number);
    hasMore.value = result.length >= pageSize;
  } catch (error) {
    if (gen !== generation) return;
    if (error instanceof ProjectApiError) {
      handleApiError(error);
    } else {
      buildError.value = error instanceof Error ? `构建加载失败：${error.message}` : '构建列表加载失败。';
    }
  } finally {
    if (gen === generation) {
      loadingBuilds.value = false;
    }
  }
}

async function loadMore(): Promise<void> {
  if (loadingMore.value || !hasMore.value || builds.value.length === 0) return;
  const gen = generation;
  const request = Symbol('loadMore');
  loadMoreRequest = request;
  loadingMore.value = true;
  loadMoreError.value = '';
  const lastBuild = builds.value[builds.value.length - 1];
  if (!lastBuild) {
    loadMoreRequest = undefined;
    loadingMore.value = false;
    return;
  }
  try {
    const projectId = project.value?.id;
    if (!projectId) throw new Error('项目数据未加载');
    const older = await listBuilds(projectId, {
      beforeNumber: lastBuild.number,
      limit: pageSize,
    });
    if (gen !== generation) return;
    const existingIds = new Set(builds.value.map((build) => build.id));
    const newBuilds = older.filter((build) => { if (existingIds.has(build.id)) return false; existingIds.add(build.id); return true; });
    builds.value = [...builds.value, ...newBuilds].sort((a, b) => b.number - a.number);
    hasMore.value = older.length >= pageSize;
  } catch (error) {
    if (gen !== generation) return;
    if (error instanceof ProjectApiError) {
      if (error.status === 401) {
        loadMoreError.value = '登录已过期，请重新登录。';
        void handleUnauthorized();
      } else if (error.status === 403 || error.status === 404) {
        handleApiError(error);
      } else {
        loadMoreError.value = error.message;
      }
    } else {
      loadMoreError.value = error instanceof Error ? error.message : '加载更多构建失败。';
    }
  } finally {
    if (loadMoreRequest === request) {
      loadMoreRequest = undefined;
      loadingMore.value = false;
    }
  }
}

function stopActiveRefresh(): void {
  if (activeRefreshTimer) {
    clearInterval(activeRefreshTimer);
    activeRefreshTimer = undefined;
  }
}

function startActiveRefresh(): void {
  stopActiveRefresh();
  activeRefreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') {
      void refreshActiveBuilds();
    }
  }, 5000);
}

async function refreshActiveBuilds(): Promise<void> {
  const gen = generation;
  const projectId = project.value?.id;
  if (!projectId || activeRefreshRequest) return;
  const activeBuilds = builds.value.filter(
    (build) => build.status === 'queued' || build.status === 'running',
  );
  if (activeBuilds.length === 0) return;

  const request = Symbol('activeRefresh');
  activeRefreshRequest = request;
  try {
    const results = await Promise.allSettled(
      activeBuilds.map((build) => getBuild(projectId, build.id)),
    );
    if (gen !== generation) return;

    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        const updated = result.value;
        const index = builds.value.findIndex((build) => build.id === updated.id);
        if (index !== -1) {
          builds.value[index] = updated;
        }
      } else {
        const reason = result.reason;
        if (reason instanceof ProjectApiError) {
          if ([401, 403, 404].includes(reason.status)) handleApiError(reason);
        }
      }
    });
  } finally {
    if (activeRefreshRequest === request) activeRefreshRequest = undefined;
  }
}

function resetForSlugChange(): void {
  replaceGeneration();
  builds.value = [];
  hasMore.value = false;
  buildError.value = '';
  loadMoreError.value = '';
  pendingBuildLoad = true;
  stopActiveRefresh();
}

async function refreshAll(): Promise<void> {
  await refreshAccess();
  if (project.value && !accessError.value) {
    await loadFirstPage();
  }
}

function onBuildCreated(build: Build): void {
  const currentProject = project.value;
  if (!currentProject) return;
  void router.push({
    name: 'project-build',
    params: { slug: currentProject.slug, buildId: build.id },
  });
}

watch(
  project,
  (newProject) => {
    if (!newProject) { resetForSlugChange(); return; }
    if (newProject && pendingBuildLoad) {
      pendingBuildLoad = false;
      void loadFirstPage();
      startActiveRefresh();
    }
  },
  { immediate: true },
);

watch(slug, () => {
  readDenied.value = ''; resetForSlugChange();
}, { flush: 'sync' });

onUnmounted(() => {
  ++generation; stopActiveRefresh();
});
</script>

<template>
  <div class="content build-list-page">
    <p v-if="accessLoading" class="state-card" role="status">正在加载项目权限...</p>
    <div v-else-if="accessError" class="state-card" role="alert">
      <p>{{ accessError }}</p>
      <button type="button" class="subtle-button" @click="refreshAccess">重试</button>
    </div>

    <div v-if="readDenied" class="state-card" role="alert">{{ readDenied }} <button type="button" class="subtle-button" @click="refreshAll">重试</button></div>
    <template v-if="project && !accessError && !readDenied">
      <div class="intro">
        <p class="eyebrow">项目</p>
        <h1>{{ project.name }}</h1>
        <p>构建记录</p>
        <RouterLink
          :to="{ name: 'project-detail', params: { slug: project.slug } }"
          class="primary-link"
        >
          返回项目
        </RouterLink>
      </div>

      <section class="section-toolbar">
        <button type="button" class="subtle-button" @click="refreshAll">刷新</button>
      </section>

      <p v-if="!oidcEnabled" role="status">本机模式仅支持查看构建</p>
      <BuildTriggerForm
        :project-id="project.id"
        :can-run="canRun"
        @created="onBuildCreated"
        @unauthorized="handleUnauthorized"
        @forbidden="refreshAccess"
      />

      <section>
        <h2>构建记录</h2>

        <p v-if="loadingBuilds" class="state-card" role="status">正在加载构建记录...</p>

        <div v-else-if="buildError" class="state-card" role="alert">
          <p>{{ buildError }}</p>
          <button type="button" class="subtle-button" @click="loadFirstPage">重试</button>
        </div>

        <template v-else>
          <table class="build-table">
            <thead>
              <tr>
                <th scope="col">构建号</th>
                <th scope="col">状态</th>
                <th scope="col">来源</th>
                <th scope="col">触发时间</th>
                <th scope="col">耗时</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="builds.length === 0">
                <td colspan="5" class="empty-state">暂无构建记录。</td>
              </tr>
              <tr v-for="build in builds" :key="build.id">
                <td>
                  <RouterLink
                    :to="{ name: 'project-build', params: { slug: project.slug, buildId: build.id } }"
                    class="inline-link"
                  >
                    #{{ build.number }}
                  </RouterLink>
                </td>
                <td><BuildStatusBadge :status="build.status" /></td>
                <td class="source-ref">{{ build.sourceRef }}</td>
                <td>{{ formatTime(build.queuedAt) }}</td>
                <td>{{ formatDuration(build) }}</td>
              </tr>
            </tbody>
          </table>

          <div v-if="loadMoreError" class="error-text" role="alert">{{ loadMoreError }}</div>

          <button
            v-if="hasMore"
            type="button"
            class="subtle-button"
            :disabled="loadingMore"
            @click="loadMore"
          >
            {{ loadingMore ? '加载中...' : '加载更多' }}
          </button>
        </template>
      </section>
    </template>
  </div>
</template>
