<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { PreviewLink } from '@forgekit/contracts';
import { createPreviewLink, listPreviewLinks, revokePreviewLink } from '../../api/preview-links';
import { ProjectApiError } from '../../api/projects';

const props = defineProps<{ projectId: string; buildId: string; canManage: boolean }>();
const emit = defineEmits<{ unauthorized: []; forbidden: [] }>();
const selectedTtlSeconds = ref(86400);
const justCreatedUrl = ref('');
const createdId = ref('');
const links = ref<PreviewLink[]>([]);
const isLoading = ref(false), isCreating = ref(false);
const revokingId = ref(''), errorMessage = ref(''), copyMessage = ref('');
let generation = 0;
const now = ref(Date.now());
const timer = setInterval(() => { now.value = Date.now(); }, 1000);
const activeLinks = computed(() => links.value.filter(link => !link.revokedAt && Date.parse(link.expiresAt) > now.value));
function dismissCreatedUrl() { justCreatedUrl.value = ''; createdId.value = ''; copyMessage.value = ''; }
function handleError(reason: unknown, fallback: string) {
  if (reason instanceof ProjectApiError) {
    if (reason.status === 401 || reason.status === 403 || reason.status === 404) {
      ++generation; dismissCreatedUrl(); links.value = []; isLoading.value = false; isCreating.value = false; revokingId.value = '';
      if (reason.status === 401) emit('unauthorized'); else emit('forbidden');
    }
    errorMessage.value = reason.status === 429 ? '请求过于频繁，请稍后重试。' : reason.status >= 500 ? '预览服务暂不可用，请稍后重试。' : fallback;
  } else { errorMessage.value = fallback; }
}
async function refreshList() {
  const epoch = generation;
  isLoading.value = true; errorMessage.value = '';
  try {
    const result = await listPreviewLinks(props.projectId, props.buildId);
    if (epoch === generation) links.value = result;
  } catch (reason) { if (epoch === generation) handleError(reason, '获取预览链接失败。'); }
  finally { if (epoch === generation) isLoading.value = false; }
}
async function handleCreate() {
  if (!props.canManage || isCreating.value || isLoading.value || revokingId.value) return;
  const epoch = generation;
  isCreating.value = true; errorMessage.value = ''; dismissCreatedUrl();
  try {
    const result = await createPreviewLink(props.projectId, props.buildId, selectedTtlSeconds.value);
    if (epoch !== generation || !props.canManage) return;
    justCreatedUrl.value = result.url; createdId.value = result.previewLink.id;
    links.value = [result.previewLink, ...links.value];
  } catch (reason) { if (epoch === generation) handleError(reason, '创建预览链接失败。'); }
  finally { if (epoch === generation) isCreating.value = false; }
}
async function handleRevoke(link: PreviewLink) {
  if (!props.canManage || revokingId.value || isLoading.value || isCreating.value) return;
  const epoch = generation;
  revokingId.value = link.id; errorMessage.value = '';
  try {
    await revokePreviewLink(props.projectId, props.buildId, link.id);
    if (epoch !== generation) return;
    links.value = links.value.filter(item => item.id !== link.id);
    if (createdId.value === link.id) dismissCreatedUrl();
  } catch (reason) { if (epoch === generation) handleError(reason, '撤销预览链接失败。'); }
  finally { if (epoch === generation) revokingId.value = ''; }
}
async function copyCreatedUrl() {
  if (!justCreatedUrl.value) return;
  const epoch = generation;
  try { await navigator.clipboard.writeText(justCreatedUrl.value); if (epoch === generation) copyMessage.value = '已复制。'; }
  catch { if (epoch === generation) copyMessage.value = '复制失败，请选中链接手动复制。'; }
}
watch(() => [props.projectId, props.buildId], () => {
  ++generation; dismissCreatedUrl(); links.value = []; isCreating.value = false; revokingId.value = '';
  void refreshList();
}, { immediate: true, flush: 'sync' });
watch(() => props.canManage, allowed => { if (!allowed) { ++generation; dismissCreatedUrl(); isCreating.value = false; revokingId.value = ''; void refreshList(); } }, { flush: 'sync' });
watch(now, () => { if (createdId.value && !activeLinks.value.some(link => link.id === createdId.value)) dismissCreatedUrl(); });
onBeforeUnmount(() => { ++generation; clearInterval(timer); dismissCreatedUrl(); });
</script>

<template>
  <section class="state-card preview-link-panel" aria-label="预览链接">
    <h2>预览链接</h2>
    <p>链接持有者可访问构建内容，请谨慎分享。</p>
    <p v-if="errorMessage" role="alert">{{ errorMessage }}</p>
    <div v-if="justCreatedUrl" role="status" class="created-url-block">
      <p>此链接仅显示一次，请立即复制保存。</p>
      <label for="created-url">完整预览链接</label>
      <input id="created-url" :value="justCreatedUrl" readonly type="url" />
      <button class="subtle-button" type="button" @click="copyCreatedUrl">复制链接</button>
      <button class="subtle-button" type="button" @click="dismissCreatedUrl">关闭提示</button>
      <p aria-live="polite">{{ copyMessage }}</p>
    </div>
    <div v-if="canManage" class="create-preview-link">
      <label for="ttl-select">有效期</label>
      <select id="ttl-select" v-model.number="selectedTtlSeconds">
        <option :value="300">5 分钟</option><option :value="3600">1 小时</option>
        <option :value="21600">6 小时</option><option :value="86400">24 小时（默认）</option><option :value="604800">7 天</option>
      </select>
      <button class="subtle-button" type="button" :disabled="isCreating || isLoading || !!revokingId" @click="handleCreate">{{ isCreating ? '创建中…' : '创建链接' }}</button>
    </div>
    <p v-if="isLoading" role="status">加载中…</p>
    <p v-else-if="!activeLinks.length">暂无有效预览链接。</p>
    <table v-else>
      <thead><tr><th scope="col">链接 ID</th><th scope="col">过期时间</th><th scope="col">最近访问</th><th v-if="canManage" scope="col">操作</th></tr></thead>
      <tbody><tr v-for="link in activeLinks" :key="link.id">
        <td>{{ link.id }}</td><td>{{ new Date(link.expiresAt).toLocaleString('zh-CN') }}</td>
        <td>{{ link.lastAccessedAt ? new Date(link.lastAccessedAt).toLocaleString('zh-CN') : '从未访问' }}</td>
        <td v-if="canManage"><button class="subtle-button" type="button" :disabled="!!revokingId || isCreating || isLoading" @click="handleRevoke(link)">{{ revokingId === link.id ? '撤销中…' : '撤销' }}</button></td>
      </tr></tbody>
    </table>
    <button class="subtle-button" type="button" :disabled="isLoading || isCreating || !!revokingId" @click="refreshList">刷新链接</button>
  </section>
</template>

<style scoped>
.preview-link-panel { padding: 1rem; overflow-x: auto; }
.created-url-block { margin-bottom: 1rem; padding: 0.75rem; border: 1px solid var(--build-border, #3f3f46); border-radius: 6px; }
input, select { background: var(--build-surface, #18181b); color: var(--build-text, #e4e4e7); border: 1px solid var(--build-border, #3f3f46); border-radius: 0.25rem; padding: 0.5rem; font: inherit; }
input:focus-visible, select:focus-visible { outline: 2px solid var(--build-accent, #8b5cf6); outline-offset: 2px; }
.created-url-block input { width: 100%; margin-bottom: 0.5rem; }
.create-preview-link { display: flex; flex-wrap: wrap; gap: 0.75rem; align-items: center; margin-bottom: 1rem; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 0.5rem; text-align: left; overflow-wrap: anywhere; border-bottom: 1px solid var(--build-border, #3f3f46); }
</style>
