import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef, type Ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import type { ProjectMembersResponse, ProjectRecord } from '@forgekit/contracts';
import { listProjectMembers } from '../api/project-members';
import { getProject, ProjectApiError } from '../api/projects';
import { authSession, clearSession, oidcEnabled } from '../auth/session';

export function useBuildProjectAccess(slug: Readonly<Ref<string>>): {
  project: Ref<ProjectRecord | null>;
  members: Ref<ProjectMembersResponse | null>;
  loading: Ref<boolean>;
  error: Ref<string>;
  accessVerified: Ref<boolean>;
  canRun: ComputedRef<boolean>;
  canCancel: ComputedRef<boolean>;
  refresh: () => Promise<void>;
} {
  const project = ref<ProjectRecord | null>(null);
  const members = ref<ProjectMembersResponse | null>(null);
  const loading = ref(false);
  const error = ref('');
  const accessVerified = ref(false);

  const router = useRouter();
  const route = useRoute();

  let generation = 0;
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let isMounted = false;

  function clearSensitiveData(): void {
    project.value = null;
    members.value = null;
    accessVerified.value = false;
  }

  async function handleUnauthorized(): Promise<void> {
    clearSensitiveData();
    error.value = '登录状态已失效，请重新登录。';

    try { await clearSession(); }
    catch { error.value = '本机登录状态清理失败，请重新登录。'; }
    await router.replace({ path: '/auth/login', query: { returnTo: route.fullPath } });
  }

  async function refresh(): Promise<void> {
    const currentGeneration = ++generation;
    const currentSlug = slug.value;

    loading.value = true;
    error.value = '';
    accessVerified.value = false;
    members.value = null;

    try {
      const nextProject = await getProject(currentSlug);
      if (currentGeneration !== generation || slug.value !== currentSlug) return;
      project.value = nextProject;

      if (!oidcEnabled) {
        members.value = null;
        accessVerified.value = true;
        return;
      }

      const nextMembers = await listProjectMembers(currentSlug);
      if (currentGeneration !== generation || slug.value !== currentSlug) return;
      members.value = nextMembers;

      const role = nextMembers.currentRole;
      accessVerified.value = role === 'owner' || role === 'editor' || role === 'viewer';
    } catch (reason) {
      if (currentGeneration !== generation || slug.value !== currentSlug) return;

      if (reason instanceof ProjectApiError && reason.status === 401) {
        await handleUnauthorized();
        return;
      }

      if (reason instanceof ProjectApiError && (reason.status === 403 || reason.status === 404)) {
        clearSensitiveData();
        error.value = reason.message || '项目访问受限。';
        return;
      }

      error.value = reason instanceof Error ? reason.message : '项目权限加载失败。';
      accessVerified.value = false;
    } finally {
      if (currentGeneration === generation && slug.value === currentSlug) {
        loading.value = false;
      }
    }
  }

  function handleFocus(): void {
    void refresh();
  }

  function handleVisibilityChange(): void {
    if (document.visibilityState === 'visible') {
      void refresh();
    }
  }

  onMounted(() => {
    isMounted = true;
    void refresh();
    intervalId = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refresh();
      }
    }, 60_000);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);
  });

  onBeforeUnmount(() => {
    isMounted = false;
    generation += 1;
    if (intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
    window.removeEventListener('focus', handleFocus);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  });

  watch(authSession, (next, previous) => {
    if (oidcEnabled && previous && !next) { ++generation; clearSensitiveData(); }
  }, { flush: 'sync' });

  watch(slug, (newSlug, oldSlug) => {
    if (newSlug === oldSlug) return;
    generation += 1;
    project.value = null;
    members.value = null;
    error.value = '';
    loading.value = false;
    accessVerified.value = false;
    if (isMounted) {
      void refresh();
    }
  }, { flush: 'sync' });

  const canRun = computed<boolean>(() => {
    if (!oidcEnabled || !accessVerified.value) return false;
    const role = members.value?.currentRole;
    return role === 'owner' || role === 'editor';
  });

  const canCancel = computed<boolean>(() => {
    if (!oidcEnabled || !accessVerified.value) return false;
    const role = members.value?.currentRole;
    return role === 'owner' || role === 'editor';
  });

  return {
    project,
    members,
    loading,
    error,
    accessVerified,
    canRun,
    canCancel,
    refresh,
  };
}
