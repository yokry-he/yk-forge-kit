<script setup lang="ts">
import { defineAsyncComponent, computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import type { Build, BuildStreamEnd } from '@forgekit/contracts';
import { getBuild, cancelBuild as cancelBuildApi } from '../api/builds';
import { ProjectApiError } from '../api/projects';
import { clearSession, oidcEnabled } from '../auth/session';
import { useBuildProjectAccess } from '../composables/useBuildProjectAccess';
import BuildStatusBadge from '../components/builds/BuildStatusBadge.vue';
import BuildTriggerForm from '../components/builds/BuildTriggerForm.vue';
import BuildLogViewer from '../components/builds/BuildLogViewer.vue';
import PreviewLinkPanel from '../components/builds/PreviewLinkPanel.vue';

const BuildDeployPanel = defineAsyncComponent(() => import('../components/deploys/BuildDeployPanel.vue').then(module => module.default));

const route = useRoute();
const router = useRouter();

const slug = computed(() => String(route.params.slug ?? ''));
const buildId = computed(() => String(route.params.buildId ?? ''));

const {
  project,
  loading: accessLoading,
  error: accessError,
  canRun,
  canCancel,
  refresh: refreshAccess,
} = useBuildProjectAccess(slug);

const build = ref<Build | null>(null);
const buildLoading = ref(false);
const buildError = ref('');
const readDenied = ref('');
const canceling = ref(false);
const cancelError = ref('');
const showTriggerForm = ref(false);

const now = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | undefined;

const isActiveBuild = computed(
  () => build.value?.status === 'queued' || build.value?.status === 'running',
);

const duration = computed(() => {
  if (!build.value?.startedAt) return '—';
  const start = new Date(build.value.startedAt).getTime();
  if (Number.isNaN(start)) return '—';

  const finishedAt = build.value.finishedAt;
  let end: number;
  if (finishedAt) {
    end = new Date(finishedAt).getTime();
    if (Number.isNaN(end)) return '—';
  } else if (isActiveBuild.value) {
    end = now.value;
  } else {
    return '—';
  }

  if (end < start) return '—';
  return formatDurationMs(end - start);
});

let generation = 0;

function formatTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds} 秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours} 小时 ${remainingMinutes} 分`;
}

async function loadBuild(): Promise<void> {
  const currentProjectId = project.value?.id;
  const currentBuildId = buildId.value;
  if (!currentProjectId || !currentBuildId) return;

  const epoch = ++generation;
  buildLoading.value = true;
  buildError.value = '';

  try {
    const data = await getBuild(currentProjectId, currentBuildId);
    if (epoch !== generation) return;

    if (data.projectId !== currentProjectId || data.id !== currentBuildId) {
      buildError.value = '构建不属于当前项目。';
      build.value = null;
      return;
    }

    build.value = data;
  } catch (reason) {
    if (epoch !== generation) return;

    if (reason instanceof ProjectApiError) {
      if (reason.status === 401) {
        await handleUnauthorized();
        return;
      }
      if (reason.status === 403 || reason.status === 404) {
        handleForbidden();
        return;
      }
      if (reason.status === 429) {
        buildError.value = '请求过于频繁，请稍后重试。';
      } else if (reason.status >= 500) {
        buildError.value = '服务暂时不可用，请稍后重试。';
      } else {
        buildError.value = reason.message;
      }
    } else {
      buildError.value = reason instanceof Error ? reason.message : '加载构建失败。';
    }
  } finally {
    if (epoch === generation) buildLoading.value = false;
  }
}

function handleBuildStatus(updated: Build): void {
  if (build.value && updated.id === build.value.id && updated.projectId === project.value?.id) {
    build.value = updated;
  }
}

function handleBuildEnd(event: BuildStreamEnd): void {
  if (build.value && event.buildId === build.value.id) {
    build.value = { ...build.value, status: event.status };
  }
}

async function handleUnauthorized(): Promise<void> {
  ++generation; build.value = null; project.value = null;
  try { await clearSession(); }
  catch { buildError.value = '本机登录状态清理失败，请重新登录。'; }
  await router.replace({ path: '/auth/login', query: { returnTo: route.fullPath } });
}

function handleForbidden(): void {
  ++generation; build.value = null; project.value = null;
  readDenied.value = '无权访问构建或构建不存在。';
}

async function handleCancel(): Promise<void> {
  if (!project.value || !build.value || !canCancel.value || canceling.value || !isActiveBuild.value) return;
  const epoch = generation;
  const pid = project.value.id, bid = build.value.id;

  canceling.value = true;
  cancelError.value = '';

  try {
    const updated = await cancelBuildApi(pid, bid);
    if (epoch !== generation) return;
    if (updated.projectId === pid && updated.id === bid) {
      build.value = updated;
    } else {
      cancelError.value = '返回的构建不属于当前项目。';
    }
  } catch (reason) {
    if (epoch !== generation) return;
    if (reason instanceof ProjectApiError) {
      if (reason.status === 409) {
        await loadBuild();
      } else if (reason.status === 401) {
        await handleUnauthorized();
      } else if (reason.status === 403 || reason.status === 404) {
        cancelError.value = '无权取消构建，可能权限已变更。';
        await refreshAccess();
      } else if (reason.status === 429) {
        cancelError.value = '请求过于频繁，请稍后重试。';
      } else if (reason.status >= 500) {
        cancelError.value = '服务暂时不可用，请稍后重试。';
      } else {
        cancelError.value = reason.message;
      }
    } else {
      cancelError.value = reason instanceof Error ? reason.message : '取消构建失败。';
    }
  } finally {
    if (project.value?.id === pid && buildId.value === bid) canceling.value = false;
  }
}

function handleBuildCreated(newBuild: Build): void {
  if (!project.value) return;
  void router.push({
    name: 'project-build',
    params: { slug: slug.value, buildId: newBuild.id },
  });
}

watch(
  [() => project.value?.id, buildId],
  ([pid, bid], old) => {
    ++generation; canceling.value = false;
    if (!pid || !bid) {
      build.value = null;
      buildError.value = '';
      return;
    }

    if (!old || old[0] !== pid || old[1] !== bid) {
      build.value = null;
      buildError.value = '';
      cancelError.value = '';
      showTriggerForm.value = false;
    }

    readDenied.value = ''; void loadBuild();
  },
  { immediate: true, flush: 'sync' },
);

watch(slug, () => { readDenied.value = ''; }, { flush: 'sync' });

onMounted(() => {
  nowTimer = setInterval(() => {
    now.value = Date.now();
  }, 1000);
});

onUnmounted(() => {
  ++generation;
  if (nowTimer) clearInterval(nowTimer);
});
</script>

<template>
  <div class="content build-detail-page">
    <p class="eyebrow">构建详情</p>

    <div v-if="accessLoading" class="state-card" role="status">
      正在验证项目访问权限…
    </div>
    <div v-else-if="accessError" class="state-card" role="alert">
      {{ accessError }}
    </div>

    <div v-if="readDenied" class="state-card" role="alert">{{ readDenied }} <button type="button" class="subtle-button" @click="refreshAccess">重试</button></div>
    <template v-if="project && !accessError && !readDenied">
      <div class="section-toolbar">
        <RouterLink
          :to="{ name: 'project-builds', params: { slug: project.slug } }"
          class="inline-link"
        >
          ← 返回构建列表
        </RouterLink>
        <button type="button" class="subtle-button" @click="loadBuild">刷新构建</button>
      </div>

      <div v-if="buildLoading" class="state-card" role="status">
        正在加载构建详情…
      </div>
      <div v-else-if="buildError" class="state-card" role="alert">
        {{ buildError }}
        <button type="button" class="subtle-button" @click="loadBuild">重试</button>
      </div>

      <template v-else-if="build">
        <section class="build-summary summary">
          <h1>
            <BuildStatusBadge :status="build.status" />
            构建 #{{ build.number }}
          </h1>

          <dl class="build-meta">
            <dt>项目</dt>
            <dd>{{ project.name }}</dd>
            <dt>来源引用</dt>
            <dd>{{ build.sourceRef }}</dd>
            <dt>构建目标</dt>
            <dd>{{ build.target || 'h5' }}</dd>
            <dt>模板</dt>
            <dd>{{ build.template }}</dd>
            <dt>触发时间</dt>
            <dd>{{ formatTime(build.queuedAt) }}</dd>
            <dt>开始时间</dt>
            <dd>{{ formatTime(build.startedAt) }}</dd>
            <dt>结束时间</dt>
            <dd>{{ formatTime(build.finishedAt) }}</dd>
            <dt>耗时</dt>
            <dd>{{ duration }}</dd>
            <dt>退出码</dt>
            <dd>{{ build.exitCode !== null ? String(build.exitCode) : '—' }}</dd>
            <dt>错误信息</dt>
            <dd>{{ build.errorMessage || '—' }}</dd>
          </dl>
        </section>

        <section v-if="isActiveBuild && canCancel" class="build-actions">
          <button
            type="button"
            class="subtle-button"
            :disabled="canceling"
            @click="handleCancel"
          >
            {{ canceling ? '正在取消…' : '取消构建' }}
          </button>
          <p v-if="cancelError" role="alert">{{ cancelError }}</p>
        </section>

        <p v-if="!oidcEnabled" role="status">本机模式仅支持查看构建</p>
        <section class="build-actions">
          <button
            v-if="!showTriggerForm"
            type="button"
            class="subtle-button"
            @click="showTriggerForm = true"
          >
            再次构建
          </button>
          <div v-else>
            <BuildTriggerForm
              :project-id="project.id"
              :can-run="canRun"
              :initial-source-ref="build.sourceRef"
              :initial-target="build.target"
              @created="handleBuildCreated"
              @unauthorized="handleUnauthorized"
              @forbidden="refreshAccess"
            />
            <button
              type="button"
              class="subtle-button"
              @click="showTriggerForm = false"
            >
              取消再次构建
            </button>
          </div>
        </section>

        <RouterLink v-if="build.target === 'mp-weixin' && build.status === 'succeeded'" :to="{ name: 'project-weapp', params: { slug: project.slug }, query: { buildId: build.id } }">微信上传与预览</RouterLink>
        <BuildDeployPanel v-if="build.target !== 'mp-weixin' && build.status === 'succeeded' && oidcEnabled" :key="`deploy:${project.id}:${build.id}`"
          :project-id="project.id" :slug="project.slug" :build-id="build.id" :can-manage="canRun"
          @unauthorized="handleUnauthorized" @forbidden="handleForbidden" />
        <PreviewLinkPanel v-if="build.target !== 'mp-weixin' && build.status === 'succeeded' && oidcEnabled"
          :key="`preview:${project.id}:${build.id}`" :project-id="project.id" :build-id="build.id" :can-manage="canRun"
          @unauthorized="handleUnauthorized" @forbidden="refreshAccess" />
        <BuildLogViewer
          :key="`${project.id}:${build.id}`"
          :project-id="project.id"
          :build-id="build.id"
          @status="handleBuildStatus"
          @end="handleBuildEnd"
          @unauthorized="handleUnauthorized"
          @forbidden="handleForbidden"
        />
      </template>
      <div v-else class="state-card" role="alert">未找到构建记录。</div>
    </template>

    <div v-else-if="!accessLoading && !readDenied && !accessError" class="state-card" role="alert">项目不存在或无法访问。</div>
  </div>
</template>
