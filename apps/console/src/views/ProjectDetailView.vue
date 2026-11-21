<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { parseAssetVerificationReceipt, type AssetVerificationReceipt, type ProjectAssetRecord, type ProjectMembersResponse, type ProjectRecord } from '@forgekit/contracts';
import { getAssetVersionStatus, listAssets } from '@forgekit/asset-core';
import { getProject } from '../api/projects';
import { listProjectAssets, planProjectAsset, upgradeProjectAssetPlan } from '../api/project-assets';
import { listProjectMembers, updateProjectMemberRole } from '../api/project-members';
import { issueInvitation, listInvitations, revokeInvitation, type InvitationSummary, type IssuedInvitation } from '../api/invitations';

const route = useRoute();
const project = ref<ProjectRecord | null>(null);
const error = ref('');
const loading = ref(true);
const assets = ref<ProjectAssetRecord[]>([]);
const assetsError = ref('');
const assetsLoading = ref(false);
const planning = ref('');
const upgradingPlan = ref('');
const planMessage = ref('');
const postUpgradeHandoff = ref<{ preview: string; apply: string } | null>(null);
const localDirectory = ref('');
const copied = ref('');
const receiptText = ref('');
const inspectedReceipt = ref<AssetVerificationReceipt | null>(null);
const receiptError = ref('');
const members = ref<ProjectMembersResponse | null>(null);
const accessVerified = ref(false);
const accessError = ref('');
const accessChecking = ref(false);
let viewEpoch = 0;
let accessRefreshInFlight = false;
let accessRefreshTimer: ReturnType<typeof setInterval> | null = null;
const membersLoading = ref(false);
const membersError = ref('');
const memberFeedback = ref('');
const updatingMember = ref('');
const memberRoleDrafts = ref<Record<string, 'editor' | 'viewer'>>({});
const inviteRole = ref<'editor' | 'viewer'>('viewer');
const issuingInvite = ref(false);
const issuedInvite = ref<IssuedInvitation | null>(null);
const invitations = ref<InvitationSummary[]>([]);
const inviteError = ref('');
const revokingInvite = ref('');
const catalog = listAssets().filter((asset) => asset.target.includes('vue-web'));
const pendingAssets = computed(() => assets.value.filter((item) => item.status === 'planned'));

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function assetCliCommand(action: 'plan' | 'add' | 'verify' | 'upgrade' | 'remove', assetId: string, mode?: 'dry-run' | 'yes'): string {
  const directory = localDirectory.value.trim() || `./${project.value?.slug ?? 'my-project'}`;
  return `node packages/cli/dist/index.js asset ${action} ${quoteShell(assetId)} --dir ${quoteShell(directory)}${mode === 'dry-run' ? ' --dry-run' : mode === 'yes' ? ' --yes' : ''}`;
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
  const epoch = viewEpoch;
  assetsLoading.value = true;
  assetsError.value = '';
  try { const next = await listProjectAssets(slug); if (epoch === viewEpoch) assets.value = next; }
  catch (reason) { if (epoch === viewEpoch) assetsError.value = reason instanceof Error ? reason.message : '资产计划加载失败。'; }
  finally { if (epoch === viewEpoch) assetsLoading.value = false; }
}

async function refreshMembers(slug: string): Promise<boolean> {
  const epoch = viewEpoch;
  membersLoading.value = true;
  membersError.value = '';
  try {
    const latest = await listProjectMembers(slug);
    if (epoch !== viewEpoch) return false;
    members.value = latest;
    memberRoleDrafts.value = {};
    if (latest.currentRole !== 'owner') issuedInvite.value = null;
    const nextInvitations = latest.currentRole === 'owner' ? await listInvitations(slug) : [];
    if (epoch !== viewEpoch) return false;
    invitations.value = nextInvitations;
    return true;
  }
  catch (reason) {
    if (epoch !== viewEpoch) return false;
    members.value = null;
    invitations.value = [];
    issuedInvite.value = null;
    memberRoleDrafts.value = {};
    membersError.value = reason instanceof Error ? reason.message : '成员列表加载失败。';
    return false;
  }
  finally { if (epoch === viewEpoch) membersLoading.value = false; }
}

/** Recheck actual server access when returning to the tab; stale roles are never authoritative. */
async function refreshAccess(): Promise<void> {
  if (!project.value || loading.value || accessRefreshInFlight || document.hidden) return;
  const slug = project.value.slug;
  const epoch = viewEpoch;
  accessRefreshInFlight = true;
  accessChecking.value = true;
  accessVerified.value = false;
  accessError.value = '';
  try {
    await getProject(slug);
    if (epoch !== viewEpoch) return;
    if (!(await refreshMembers(slug))) throw new Error(membersError.value || '无法刷新项目成员权限。');
    if (epoch !== viewEpoch) return;
    accessVerified.value = true;
  } catch (reason) {
    if (epoch !== viewEpoch) return;
    accessError.value = reason instanceof Error ? reason.message : '无法验证项目权限。';
    // Access denial is not a recoverable stale display: remove project and member data.
    if (reason instanceof Error && 'status' in reason && (reason.status === 403 || reason.status === 404)) {
      project.value = null;
      members.value = null;
      assets.value = [];
      invitations.value = [];
      issuedInvite.value = null;
      error.value = '项目不存在或当前账户已失去访问权限。';
    }
  } finally {
    if (epoch === viewEpoch) accessChecking.value = false;
    accessRefreshInFlight = false;
  }
}

async function createInvite(): Promise<void> {
  if (!project.value || issuingInvite.value || members.value?.currentRole !== 'owner') return;
  issuingInvite.value = true;
  inviteError.value = '';
  issuedInvite.value = null;
  try {
    issuedInvite.value = await issueInvitation(project.value.slug, inviteRole.value);
    invitations.value = await listInvitations(project.value.slug);
  } catch (reason) { inviteError.value = reason instanceof Error ? reason.message : '无法创建邀请。'; }
  finally { issuingInvite.value = false; }
}

async function revokeInvite(invitationId: string): Promise<void> {
  if (!project.value || members.value?.currentRole !== 'owner' || revokingInvite.value) return;
  revokingInvite.value = invitationId;
  inviteError.value = '';
  try {
    await revokeInvitation(project.value.slug, invitationId);
    invitations.value = await listInvitations(project.value.slug);
    // A newly issued code must not remain visible after its invitation is revoked.
    issuedInvite.value = null;
  } catch (reason) { inviteError.value = reason instanceof Error ? reason.message : '撤销邀请码失败。'; }
  finally { revokingInvite.value = ''; }
}

function draftRole(userId: string, role: 'editor' | 'viewer'): void {
  memberRoleDrafts.value = { ...memberRoleDrafts.value, [userId]: role };
  memberFeedback.value = '';
}

function cancelRoleChange(userId: string): void {
  const next = { ...memberRoleDrafts.value };
  delete next[userId];
  memberRoleDrafts.value = next;
}

async function changeRole(userId: string, role: string): Promise<void> {
  if (!project.value || updatingMember.value || (role !== 'editor' && role !== 'viewer')) return;
  if (members.value?.currentRole !== 'owner' || userId === members.value.currentUserId ||
      !members.value.members.some((member) => member.userId === userId && member.role !== 'owner' && member.role !== role)) return;
  updatingMember.value = userId;
  membersError.value = '';
  memberFeedback.value = '';
  try {
    await updateProjectMemberRole(project.value.slug, userId, role);
    if (await refreshMembers(project.value.slug)) memberFeedback.value = '成员角色已更新，已从服务器刷新最新成员列表。';
    else memberFeedback.value = '角色修改已提交，但列表刷新失败，请手动刷新确认。';
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

async function upgradeRecordedPlan(assetId: string, expectedVersion: string): Promise<void> {
  if (!project.value || upgradingPlan.value || !['owner', 'editor'].includes(members.value?.currentRole ?? '') ||
      getAssetVersionStatus(assetId, expectedVersion) !== 'upgrade-available') return;
  upgradingPlan.value = assetId;
  planMessage.value = '';
  assetsError.value = '';
  try {
    const preview = assetCliCommand('upgrade', assetId, 'dry-run');
    const apply = assetCliCommand('upgrade', assetId, 'yes');
    await upgradeProjectAssetPlan(project.value.slug, assetId, expectedVersion);
    await refreshAssets(project.value.slug);
    postUpgradeHandoff.value = { preview, apply };
    planMessage.value = '已更新服务端目标版本计划；本地源码和锁文件尚未升级，请按 CLI 步骤完成。';
  } catch (reason) { assetsError.value = reason instanceof Error ? reason.message : '版本登记更新失败，请刷新后重试。'; }
  finally { upgradingPlan.value = ''; }
}

async function refresh(): Promise<void> {
  const epoch = ++viewEpoch;
  loading.value = true;
  accessVerified.value = false;
  accessError.value = '';
  error.value = '';
  project.value = null;
  assets.value = [];
  planMessage.value = '';
  postUpgradeHandoff.value = null;
  copied.value = '';
  receiptText.value = '';
  inspectedReceipt.value = null;
  members.value = null;
  memberFeedback.value = '';
  issuedInvite.value = null;
  inviteError.value = '';
  try {
    const latest = await getProject(String(route.params.slug));
    if (epoch !== viewEpoch) return;
    project.value = latest;
    await Promise.all([refreshAssets(project.value.slug), refreshMembers(project.value.slug)]);
    if (epoch === viewEpoch && members.value) accessVerified.value = true;
  }
  catch (reason) { if (epoch === viewEpoch) error.value = reason instanceof Error ? reason.message : '项目读取失败。'; }
  finally { if (epoch === viewEpoch) loading.value = false; }
}
function onVisibilityOrFocus(): void { if (!document.hidden) void refreshAccess(); }
onMounted(() => {
  void refresh();
  window.addEventListener('focus', onVisibilityOrFocus);
  document.addEventListener('visibilitychange', onVisibilityOrFocus);
  accessRefreshTimer = setInterval(onVisibilityOrFocus, 60_000);
});
onUnmounted(() => {
  window.removeEventListener('focus', onVisibilityOrFocus);
  document.removeEventListener('visibilitychange', onVisibilityOrFocus);
  if (accessRefreshTimer) clearInterval(accessRefreshTimer);
  viewEpoch++;
});
watch(() => route.params.slug, refresh);
</script>

<template>
  <div class="content">
    <div class="eyebrow">PROJECT DETAILS</div>
    <h1>项目<span>详情</span></h1>
    <p class="intro"><RouterLink class="inline-link" to="/projects">← 返回项目列表</RouterLink></p>
    <section v-if="loading" class="state-card" role="status">正在读取项目配置…</section>
    <section v-else-if="error" class="state-card" role="alert"><strong>无法读取项目</strong><p>{{ error }}</p><button class="subtle-button" @click="refresh">重试</button></section>
    <section v-if="project && !accessVerified" class="state-card" :role="accessError ? 'alert' : 'status'">{{ accessError || '正在核对项目访问权限…' }} <button v-if="accessError && !accessChecking" class="subtle-button" @click="refreshAccess">重试验证</button></section>
    <section v-else-if="project" class="panel project-detail-panel">
      <div class="project-card-top"><span class="project-mark">V</span><span class="asset-tag verified">已保存元数据</span></div>
      <h2>{{ project.name }}</h2>
      <RouterLink v-if="accessVerified" class="inline-link" :to="{ name: 'project-deployments', params: { slug: project.slug } }">部署目标与历史</RouterLink>
      <RouterLink v-if="accessVerified && project.template === 'uniapp'" class="inline-link" :to="`/projects/${project.slug}/weapp`">微信上传与预览</RouterLink>
      <RouterLink v-if="accessVerified" class="inline-link" :to="`/projects/${project.slug}/variables`">环境变量</RouterLink>
      <RouterLink v-if="accessVerified" class="inline-link" :to="{ name: 'project-builds', params: { slug: project.slug } }">查看构建</RouterLink>
      <div class="summary">
        <div><span>项目 ID</span><strong>{{ project.id }}</strong></div>
        <div><span>模板</span><strong>{{ project.template }}</strong></div>
        <div><span>可选能力</span><strong>{{ project.features.join('、') || '无' }}</strong></div>
        <div><span>创建时间</span><strong>{{ new Date(project.createdAt).toLocaleString('zh-CN') }}</strong></div>
      </div>
      <div class="coming">此页面展示数据库中的项目配置，不代表已经在本机生成源码。源码创建仍需使用 CLI。</div>
    </section>
    <section v-if="project && accessVerified" class="project-assets-panel">
      <div class="section-toolbar"><span>项目资产计划</span><button class="subtle-button" :disabled="assetsLoading" @click="refreshAssets(project.slug)">刷新</button></div>
      <p class="asset-help">这里登记准备集成的公共资产及其版本。<strong>登记不等于安装成功</strong>；实际文件修改仍需通过 CLI 执行并校验。</p>
      <p v-if="assetsError" class="form-error" role="alert">{{ assetsError }}</p>
      <p v-if="planMessage" class="form-success" role="status">{{ planMessage }}</p>
      <div v-if="postUpgradeHandoff" class="asset-handoff">
        <p class="asset-help">目标版本更新后仍须执行本地 CLI，命令保留在这里方便继续完成：</p>
        <div class="handoff-command"><span>升级预览</span><code>{{ postUpgradeHandoff.preview }}</code><button class="subtle-button" @click="copyCommand(postUpgradeHandoff.preview, 'post-upgrade-preview')">{{ copied === 'post-upgrade-preview' ? '已复制' : '复制' }}</button></div>
        <div class="handoff-command"><span>确认执行</span><code>{{ postUpgradeHandoff.apply }}</code><button class="subtle-button" @click="copyCommand(postUpgradeHandoff.apply, 'post-upgrade-apply')">{{ copied === 'post-upgrade-apply' ? '已复制' : '复制' }}</button></div>
      </div>
      <div v-if="assetsLoading" class="state-card" role="status">正在加载资产计划…</div>
      <div v-else-if="!assets.length" class="state-card compact-state">尚未登记额外资产安装计划。</div>
      <div v-else class="project-assets-list">
        <div v-for="item in assets" :key="item.id"><strong>{{ item.assetId }}</strong><small>登记版本 v{{ item.version }}</small><span class="asset-tag" :class="{ verified: getAssetVersionStatus(item.assetId, item.version) === 'current' }">{{ getAssetVersionStatus(item.assetId, item.version) === 'current' ? '当前 Registry 版本' : getAssetVersionStatus(item.assetId, item.version) === 'upgrade-available' ? '有可升级版本' : '版本不受支持' }}</span><span class="asset-tag">{{ item.status === 'planned' ? '仅登记计划' : '历史安装标记' }}</span></div>
      </div>
      <h3>可选公共资产</h3>
      <div v-for="item in catalog" :key="item.id" class="asset-option-row">
        <div><strong>{{ item.name }}</strong><small>{{ item.description }} · v{{ item.version }}</small></div>
        <button class="subtle-button" :disabled="!!planning || assetsLoading || assets.some((asset) => asset.assetId === item.id)" @click="planAsset(item.id)">{{ planning === item.id ? '正在登记…' : assets.some((asset) => asset.assetId === item.id) ? '已登记' : '登记安装计划' }}</button>
      </div>
      <p class="asset-help">当前仅提供已实现安装器的官方主题资产；用户中心、大屏等资产仍在规划中。</p>
      <div v-if="pendingAssets.length" class="asset-handoff">
        <h3>在本机执行已登记的资产计划</h3>
        <p class="asset-help">输入项目源码目录。先预览变更，再执行安装，最后只读校验；命令需要在 YKForgeKit 仓库根目录执行。执行成功也不会自动将数据库状态改为“已安装”。</p>
        <label for="project-source-dir">项目源码目录</label>
        <input id="project-source-dir" v-model="localDirectory" :placeholder="`./${project.slug}`" spellcheck="false" />
        <div v-for="item in pendingAssets" :key="item.id" class="handoff-item">
          <strong>{{ item.assetId }} <small>v{{ item.version }}</small></strong>
          <div v-for="action in (getAssetVersionStatus(item.assetId, item.version) === 'current' ? ['plan', 'add', 'verify'] as const : [] as const)" :key="action" class="handoff-command">
            <span>{{ { plan: '预览', add: '执行', verify: '校验' }[action] }}</span>
            <code>{{ assetCliCommand(action, item.assetId) }}</code>
            <button class="subtle-button" @click="copyCommand(assetCliCommand(action, item.assetId), `${item.assetId}:${action}`)">{{ copied === `${item.assetId}:${action}` ? '已复制' : '复制' }}</button>
          </div>
          <div class="asset-lifecycle-handoff">
            <h3>本地版本维护</h3>
            <p v-if="getAssetVersionStatus(item.assetId, item.version) === 'upgrade-available'" class="asset-help">Registry 已提供新版本。请先确认本地锁文件仍是旧版且未修改受管理文件，再预览升级。</p>
            <p v-else-if="getAssetVersionStatus(item.assetId, item.version) === 'current'" class="asset-help">登记的是当前 Registry 版本。只有本地锁文件存在且内容匹配时，CLI 才会判定为已安装。</p>
            <p v-else class="asset-help">该登记版本没有受支持的自动升级路径，请人工核对锁文件和来源。</p>
            <template v-if="getAssetVersionStatus(item.assetId, item.version) === 'upgrade-available'">
              <div v-for="mode in (['dry-run', 'yes'] as const)" :key="mode" class="handoff-command"><span>{{ mode === 'dry-run' ? '升级预览' : '升级执行' }}</span><code>{{ assetCliCommand('upgrade', item.assetId, mode) }}</code><button class="subtle-button" @click="copyCommand(assetCliCommand('upgrade', item.assetId, mode), `${item.assetId}:upgrade:${mode}`)">{{ copied === `${item.assetId}:upgrade:${mode}` ? '已复制' : '复制' }}</button></div>
              <button v-if="members?.currentRole === 'owner' || members?.currentRole === 'editor'" class="subtle-button" :disabled="!!upgradingPlan || assetsLoading" @click="upgradeRecordedPlan(item.assetId, item.version)">{{ upgradingPlan === item.assetId ? '登记中…' : '将服务端目标版本登记为最新' }}</button>
            </template>
            <div v-for="mode in (['dry-run', 'yes'] as const)" :key="mode" class="handoff-command"><span>{{ mode === 'dry-run' ? '卸载预览' : '卸载执行' }}</span><code>{{ assetCliCommand('remove', item.assetId, mode) }}</code><button class="subtle-button" @click="copyCommand(assetCliCommand('remove', item.assetId, mode), `${item.assetId}:remove:${mode}`)">{{ copied === `${item.assetId}:remove:${mode}` ? '已复制' : '复制' }}</button></div>
            <p class="asset-help">先运行 --dry-run 并检查 git diff，再决定是否执行 --yes。浏览器不会修改源码；CLI 会拒绝覆盖已漂移的文件。数据库登记版本不会随着本地命令自动更新。</p>
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
    <section v-if="project && accessVerified" class="project-assets-panel member-panel">
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
          <template v-if="members.currentRole === 'owner' && member.role !== 'owner' && member.userId !== members.currentUserId">
            <label class="sr-only" :for="`role-${member.userId}`">{{ member.displayName }} 的成员角色</label>
            <select :id="`role-${member.userId}`" :value="memberRoleDrafts[member.userId] ?? member.role" :disabled="!!updatingMember || membersLoading" @change="draftRole(member.userId, ($event.target as HTMLSelectElement).value as 'editor' | 'viewer')"><option value="editor">Editor</option><option value="viewer">Viewer</option></select>
            <template v-if="memberRoleDrafts[member.userId] && memberRoleDrafts[member.userId] !== member.role">
              <button class="subtle-button" :disabled="!!updatingMember" @click="changeRole(member.userId, memberRoleDrafts[member.userId]!)">{{ updatingMember === member.userId ? '保存中…' : '确认更改' }}</button>
              <button class="subtle-button" :disabled="!!updatingMember" @click="cancelRoleChange(member.userId)">取消</button>
            </template>
          </template>
        </div>
      </div>
      <p class="asset-help">支持一次性邀请码，不发送邮件，也不会提前创建受邀用户。受邀者需要使用自己的 OIDC 身份完成兑换。</p>
      <div v-if="members?.currentRole === 'owner'" class="invite-box">
        <h3>邀请新成员</h3>
        <p class="asset-help">生成 7 天有效、仅能使用一次的邀请码。请通过可信渠道单独发送给受邀人；受邀人使用 OIDC 登录后在用户中心兑换。</p>
        <div class="invite-controls"><label for="invite-role">加入角色</label><select id="invite-role" v-model="inviteRole"><option value="viewer">Viewer</option><option value="editor">Editor</option></select><button class="subtle-button" :disabled="issuingInvite" @click="createInvite">{{ issuingInvite ? '正在生成…' : '生成邀请码' }}</button></div>
        <p v-if="inviteError" class="form-error" role="alert">{{ inviteError }}</p>
        <div v-if="issuedInvite" class="issued-code" role="status"><strong>邀请码仅在本次生成时显示</strong><code>{{ issuedInvite.code }}</code><span>有效期至 {{ new Date(issuedInvite.expiresAt).toLocaleString('zh-CN') }}</span><button class="subtle-button" @click="copyCommand(issuedInvite.code, 'invite')">{{ copied === 'invite' ? '已复制' : '复制邀请码' }}</button></div>
        <div v-if="invitations.length" class="invitation-history"><strong>近期邀请</strong><div v-for="invitation in invitations" :key="invitation.id"><span>{{ invitation.role }}</span><small>{{ invitation.redeemedAt ? '已兑换' : invitation.revokedAt ? '已撤销' : new Date(invitation.expiresAt).getTime() <= Date.now() ? '已过期' : '待兑换' }}</small><button v-if="!invitation.redeemedAt && !invitation.revokedAt && new Date(invitation.expiresAt).getTime() > Date.now()" class="subtle-button" :disabled="!!revokingInvite" @click="revokeInvite(invitation.id)">{{ revokingInvite === invitation.id ? '撤销中…' : '撤销' }}</button></div></div>
      </div>
    </section>
  </div>
</template>
