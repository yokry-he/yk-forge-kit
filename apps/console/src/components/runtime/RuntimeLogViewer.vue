<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from 'vue';
import { useRuntimeLogStream } from '../../composables/useRuntimeLogStream';
const props = defineProps<{ projectId: string; sessionId: string }>();
const emit = defineEmits<{ denied: [status: 401 | 403 | 404] }>();
const { chunks, state, error, session, accessError, stop } = useRuntimeLogStream(toRef(props, 'projectId'), toRef(props, 'sessionId'));
const text = computed(() => chunks.value.map(chunk => chunk.content).join(''));
const scroll = ref<HTMLElement | null>(null), follow = ref(true);
watch(accessError, status => { if (status) emit('denied', status); });
watch(text, async () => { if (follow.value) { await nextTick(); if (scroll.value) scroll.value.scrollTop = scroll.value.scrollHeight; } });
const labels = { connecting: '连接中…', connected: '实时跟随中', reconnecting: '正在重连…', ended: '会话已结束', error: '连接失败', closed: '已停止' };
</script>
<template>
  <section aria-label="站点运行日志">
    <div class="toolbar">
      <span role="status">{{ labels[state] }}</span>
      <label><input v-model="follow" type="checkbox" /> 自动滚动</label>
      <button type="button" :disabled="['closed', 'ended'].includes(state)" @click="stop">停止跟随</button>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-if="session?.errorCode" role="alert">会话结果：{{ session.errorCode }}。请检查主机配置或重新开始。</p>
    <pre ref="scroll" tabindex="0" aria-label="运行日志内容">{{ text || '暂无匹配日志。' }}</pre>
    <p v-if="state === 'ended' || state === 'closed'">点击“开始查看”创建新会话并继续跟随。</p>
  </section>
</template>
<style scoped>
.toolbar { display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; margin: 1rem 0; }
pre { background: #09090b; color: #d4d4d8; border: 1px solid #3f3f46; border-radius: .5rem; padding: 1rem; max-height: 600px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
pre:focus-visible { outline: 2px solid #8b5cf6; }
</style>
