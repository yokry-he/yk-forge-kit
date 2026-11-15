<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { parseAssetVerificationReceipt, type AssetVerificationReceipt, type ProjectAssetRecord, type ProjectMembersResponse, type ProjectRecord } from '@forgekit/contracts';
import { listAssets } from '@forgekit/asset-core';
import { getProject } from '../api/projects';
import { listProjectAssets, planProjectAsset } from '../api/project-assets';
import { listProjectMembers, updateProjectMemberRole } from '../api/project-members';

const route = useRoute();
const project = ref<ProjectRecord | null>(null);
const error = ref('');
const loading = ref(true);
const assets = ref<ProjectAssetRecord[]>([]);
const assetsError = ref('');
const assetsLoading = ref(false);
const planning = ref('');
const planMessage = ref('');
const localDirectory = ref('');
const copied = ref('');
const receiptText = ref('');
const inspectedReceipt = ref<AssetVerificationReceipt | null>(null);
const receiptError = ref('');
const members = ref<ProjectMembersResponse | null>(null);
const membersLoading = ref(false);
const membersError = ref('');
const memberFeedback = ref('');
const updatingMember = ref('');
const catalog = listAssets().filter((asset) => asset.target.includes('vue-web'));
const pendingAssets = computed(() => assets.value.filter((item) => item.status === 'planned'));

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function assetCliCommand(action: 'plan' | 'add' | 'verify', assetId: string): string {
  const directory = localDirectory.value.trim() || `./${project.value?.slug ?? 'my-project'}`;
  return `node packages/cli/dist/index.js asset ${action} ${quoteShell(assetId)} --dir ${quoteShell(directory)}`;
}

async function copyCommand(command: string, key: string): Promise<void> {
  try { await navigator.clipboard.writeText(command); copied.value = key; }
  catch { copied.value = '复制失败，请手动选择命令'; }
}

function inspectReceipt(): void {
  inspectedReceipt.value = null;
  receiptError.value = '';
  try {
    const value = parseAssetVerificationReceipt(receiptText.value);
    if (!project.value || value.project !== project.value.slug) throw new Error('回执项目名称与当前项目不匹配。');
    if (!assets.value.some((asset) => asset.assetId === value.assetId && asset.version === value.assetVersion)) {
      throw new Error('回执资产及版本与当前登记计划不匹配。');
    }
    inspectedReceipt.value = value;
  } catch (reason) { receiptError.value = reason instanceof Error ? reason.message : '无法读取校验回执。'; }
}

async function refreshAssets(slug: string): Promise<void> {
  assetsLoading.value = true;
  assetsError.value = '';
  try { assets.value = await listProjectAssets(slug); }
  catch (reason) { assetsError.value = reason instanceof Error ? reason.message : '资产计划加载失败。'; }
  finally { assetsLoading.value = false; }
}

async function refreshMembers(slug: string): Promise<void> {
  membersLoading.value = true;
  membersError.value = '';
  try { members.value = await listProjectMembers(slug); }
  catch (reason) { membersError.value = reason instanceof Error ? reason.message : '成员列表加载失败。'; }
  finally { membersLoading.value = false; }
}

async function changeRole(userId: string, role: string): Promise<void> {
  if (!project.value || updatingMember.value || (role !== 'editor' && role !== 'viewer')) return;
  updatingMember.value = userId;
  membersError.value = '';
  memberFeedback.value = '';
  try {
    await updateProjectMemberRole(project.value.slug, userId, role);
    await refreshMembers(project.value.slug);
    memberFeedback.value = '成员角色已更新。';
  } catch (reason) { membersError.value = reason instanceof Error ? reason.message : '成员角色更新失败。'; }
  finally { updatingMember.value = ''; }
}

async function planAsset(assetId: string): Promise<void> {
  if (!project.value || planning.value) return;
  planning.value = assetId;
  planMessage.value = '';
  assetsError.value = '';
  try {
    await planProjectAsset(project.value.slug, assetId);
    await refreshAssets(project.value.slug);
    planMessage.value = '资产安装计划已登记，尚未修改项目源码。';
  } catch (reason) { assetsError.value = reason instanceof Error ? reason.message : '登记失败。'; }
  finally { planning.value = ''; }
}

async function refresh(): Promise<void> {
  loading.value = true;
  error.value = '';
  project.value = null;
  assets.value = [];
  planMessage.value = '';
  copied.value = '';
  receiptText.value = '';
  inspectedReceipt.value = null;
  members.value = null;
  memberFeedback.value = '';
  try {
    project.value = await getProject(String(route.params.slug));
    await Promise.all([refreshAssets(project.value.slug), refreshMembers(project.value.slug)]);
  }
  catch (reason) { error.value = reason instanceof Error ? reason.message : '项目读取失败。'; }
  finally { loading.value = false; }
}
onMounted(refresh);
watch(() => route.params.slug, refresh);
</script>

<template>
  <div class="content">
    <div class="eyebrow">PROJECT DETAILS</div>
    <h1>项目<span>详情</span></h1>
    <p class="intro"><RouterLink class="inline-link" to="/projects">← 返回项目列表</RouterLink></p>
    <section v-if="loading" class="state-card" role="status">正在读取项目配置…</section>
    <section v-else-if="error" class="state-card" role="alert"><strong>无法读取项目</strong><p>{{ error }}</p><button class="subtle-button" @click="refresh">重试</button></section>
    <section v-else-if="project" class="panel project-detail-panel">
      <div class="project-card-top"><span class="project-mark">V</span><span class="asset-tag verified">已保存元数据</span></div>
      <h2>{{ project.name }}</h2>
      <div class="summary">
        <div><span>项目 ID</span><strong>{{ project.id }}</strong></div>
        <div><span>模板</span><strong>{{ project.template }}</strong></div>
        <div><span>可选能力</span><strong>{{ project.features.join('、') || '无' }}</strong></div>
        <div><span>创建时间</span><strong>{{ new Date(project.createdAt).toLocaleString('zh-CN') }}</strong></div>
      </div>
      <div class="coming">此页面展示数据库中的项目配置，不代表已经在本机生成源码。源码创建仍需使用 CLI。</div>
    </section>
    <section v-if="project" class="project-assets-panel">
      <div class="section-toolbar"><span>项目资产计划</span><button class="subtle-button" :disabled="assetsLoading" @click="refreshAssets(project.slug)">刷新</button></div>
      <p class="asset-help">这里登记准备集成的公共资产及其版本。<strong>登记不等于安装成功</strong>；实际文件修改仍需通过 CLI 执行并校验。</p>
      <p v-if="assetsError" class="form-error" role="alert">{{ assetsError }}</p>
      <p v-if="planMessage" class="form-success" role="status">{{ planMessage }}</p>
      <div v-if="assetsLoading" class="state-card" role="status">正在加载资产计划…</div>
      <div v-else-if="!assets.length" class="state-card compact-state">尚未登记额外资产安装计划。</div>
      <div v-else class="project-assets-list">
        <div v-for="item in assets" :key="item.id"><strong>{{ item.assetId }}</strong><small>v{{ item.version }}</small><span class="asset-tag" :class="{ verified: item.status === 'applied' }">{{ item.status === 'planned' ? '待执行' : '已确认安装' }}</span></div>
      </div>
      <h3>可选公共资产</h3>
      <div v-for="item in catalog" :key="item.id" class="asset-option-row">
        <div><strong>{{ item.name }}</strong><small>{{ item.description }} · v{{ item.version }}</small></div>
        <button class="subtle-button" :disabled="!!planning || assetsLoading || assets.some((asset) => asset.assetId === item.id)" @click="planAsset(item.id)">{{ planning === item.id ? '正在登记…' : assets.some((asset) => asset.assetId === item.id) ? '已登记' : '登记安装计划' }}</button>
      </div>
      <p class="asset-help">当前仅提供已实现安装器的官方主题资产；用户中心、大屏等资产仍在规划中。</p>
      <div v-if="pendingAssets.length" class="asset-handoff">
        <h3>在本机执行已登记的资产计划</h3>
        <p class="asset-help">输入项目源码目录。先预览变更，再执行安装，最后只读校验；命令需要在 ForgeKit 仓库根目录执行。执行成功也不会自动将数据库状态改为“已安装”。</p>
        <label for="project-source-dir">项目源码目录</label>
        <input id="project-source-dir" v-model="localDirectory" :placeholder="`./${project.slug}`" spellcheck="false" />
        <div v-for="item in pendingAssets" :key="item.id" class="handoff-item">
          <strong>{{ item.assetId }} <small>v{{ item.version }}</small></strong>
          <div v-for="action in (['plan', 'add', 'verify'] as const)" :key="action" class="handoff-command">
            <span>{{ { plan: '预览', add: '执行', verify: '校验' }[action] }}</span>
            <code>{{ assetCliCommand(action, item.assetId) }}</code>
            <button class="subtle-button" @click="copyCommand(assetCliCommand(action, item.assetId), `${item.assetId}:${action}`)">{{ copied === `${item.assetId}:${action}` ? '已复制' : '复制' }}</button>
          </div>
        </div>
        <small role="status">{{ copied === '复制失败，请手动选择命令' ? copied : '建议先查看 git diff，确认文件变更后再提交。' }}</small>
        <div class="receipt-inspector">
          <h3>查看本地校验回执</h3>
          <p class="asset-help">运行下方命令并复制 JSON 输出，可在此检查回执是否对应当前项目与资产版本。回执未签名，仅供本地人工核对，不能作为身份认证或数据库安装确认。</p>
          <div class="handoff-command"><span>回执</span><code>{{ assetCliCommand('verify', pendingAssets[0]!.assetId) }} --json</code><button class="subtle-button" @click="copyCommand(`${assetCliCommand('verify', pendingAssets[0]!.assetId)} --json`, 'receipt')">{{ copied === 'receipt' ? '已复制' : '复制' }}</button></div>
          <label for="receipt-json">校验回执 JSON</label>
          <textarea id="receipt-json" v-model="receiptText" rows="5" placeholder="粘贴 CLI --json 输出" spellcheck="false" @input="inspectedReceipt = null; receiptError = ''"></textarea>
          <button class="subtle-button" :disabled="!receiptText.trim()" @click="inspectReceipt">检查回执</button>
          <p v-if="receiptError" class="form-error" role="alert">{{ receiptError }}</p>
          <div v-if="inspectedReceipt" class="receipt-result" role="status"><strong>回执字段匹配</strong><small>{{ inspectedReceipt.assetId }}@{{ inspectedReceipt.assetVersion }} · {{ inspectedReceipt.files.length }} 个文件摘要 · {{ new Date(inspectedReceipt.verifiedAt).toLocaleString('zh-CN') }}</small><p>此结果只代表回执内容通过格式与项目匹配检查，不代表服务器验证了本地文件；数据库状态仍为原值。</p></div>
        </div>
      </div>
    </section>
    <section v-if="project" class="project-assets-panel member-panel">
      <div class="section-toolbar"><span>项目成员</span><button class="subtle-button" :disabled="membersLoading" @click="refreshMembers(project.slug)">刷新</button></div>
      <p class="asset-help">成员关系来自服务端授权记录。Owner 可以调整已有 Editor/Viewer 的角色，不能通过此界面降级 Owner。</p>
      <p v-if="membersError" class="form-error" role="alert">{{ membersError }}</p>
      <p v-if="memberFeedback" class="form-success" role="status">{{ memberFeedback }}</p>
      <div v-if="membersLoading" class="state-card compact-state" role="status">正在加载项目成员…</div>
      <div v-else-if="!members?.members.length" class="state-card compact-state">暂无成员记录。旧项目的归属需要由管理员确认后迁移。</div>
      <div v-else class="member-list">
        <div v-for="member in members.members" :key="member.userId" class="member-row">
          <span class="member-avatar">{{ member.displayName.slice(0, 1).toUpperCase() }}</span>
          <div class="member-name"><strong>{{ member.displayName }} <small v-if="member.userId === members.currentUserId">（我）</small></strong><small>{{ member.userId }}</small></div>
          <span v-if="members.currentRole !== 'owner' || member.role === 'owner' || member.userId === members.currentUserId" class="asset-tag" :class="{ verified: member.role === 'owner' }">{{ member.role }}</span>
          <label v-else class="sr-only" :for="`role-${member.userId}`">成员角色</label>
          <select v-if="members.currentRole === 'owner' && member.role !== 'owner' && member.userId !== members.currentUserId" :id="`role-${member.userId}`" :value="member.role" :disabled="!!updatingMember" @change="changeRole(member.userId, ($event.target as HTMLSelectElement).value)"><option value="editor">Editor</option><option value="viewer">Viewer</option></select>
        </div>
      </div>
      <p class="asset-help">成员邀请和加入流程将在身份提供方完成实际联调后补充；当前不发送邀请，也不创建未经验证的外部账号。</p>
    </section>
  </div>
</template>
