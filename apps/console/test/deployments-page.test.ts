// @vitest-environment jsdom
import { computed, ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { DeployTargetSchema, DeploymentSchema } from '@forgekit/contracts';
import DeploymentsPage from '../src/views/DeploymentsPage.vue';
import { listDeployTargets, listDeployments, saveDeployTarget, rollbackDeployment } from '../src/api/deploys';
import { ProjectApiError } from '../src/api/projects';
vi.mock('../src/api/deploys', async importOriginal => ({ ...await importOriginal<typeof import('../src/api/deploys')>(),
  listDeployTargets: vi.fn(), listDeployments: vi.fn(), saveDeployTarget: vi.fn(), removeDeployTarget: vi.fn(), rollbackDeployment: vi.fn(), getDeployment: vi.fn() }));
const access = vi.hoisted(() => ({ role: 'editor' }));
const id = '11111111-1111-4111-8111-111111111111', jobId = '22222222-2222-4222-8222-222222222222';
vi.mock('../src/composables/useBuildProjectAccess', () => ({ useBuildProjectAccess: () => ({
  project: ref({ id: '11111111-1111-4111-8111-111111111111', slug: 'site' }), accessVerified: ref(true), error: ref(''), loading: ref(false), canRun: computed(() => access.role === 'editor'),
}) }));
vi.mock('../src/components/deploys/DeployLogViewer.vue', () => ({ default: { template: '<pre>历史部署日志</pre>', props: ['projectId', 'deploymentId'] } }));
enableAutoUnmount(afterEach);
const target = DeployTargetSchema.parse({ id, projectId: id, kind: 'ssh', name: '站点主机', host: 'example.com', port: 22, username: 'deploy',
  hostKey: 'ssh-ed25519 AAAA', basePath: '/srv/site', retention: 2, createdBy: id, createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z' });
const job = DeploymentSchema.parse({ id: jobId, projectId: id, buildId: id, environmentId: id, deployTargetId: id, status: 'succeeded',
  action: 'deploy', releaseId: jobId, retained: true, startedAt: null, finishedAt: null, createdAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z' });
async function render(selected = '') {
  const router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/projects/:slug/deployments/:deploymentId?', name: 'project-deployments', component: DeploymentsPage },
    { path: '/projects/:slug', name: 'project-detail', component: { template: '<div />' } },
    { path: '/projects/:slug/builds', name: 'project-builds', component: { template: '<div />' } },
  ] });
  await router.push('/projects/site/deployments' + selected); await router.isReady();
  const wrapper = mount(DeploymentsPage, { global: { plugins: [router], stubs: { ElPopconfirm: { template: '<span><slot name="reference" /><button class="confirm" @click="$emit(\'confirm\')">确认操作</button></span>' } } } });
  await flushPromises(); return wrapper;
}
function button(wrapper: Awaited<ReturnType<typeof render>>, text: string) { return wrapper.findAll('button').find(button => button.text() === text)!; }
beforeEach(() => {
  vi.clearAllMocks(); access.role = 'editor'; vi.mocked(listDeployTargets).mockResolvedValue([target]); vi.mocked(listDeployments).mockResolvedValue([job]);
  vi.mocked(saveDeployTarget).mockResolvedValue(target); vi.mocked(rollbackDeployment).mockResolvedValue({ ...job, id });
});
describe('Chinese deployment console', () => {
  it('edits without requiring a replacement private key and clears the draft after saving', async () => {
    const wrapper = await render(); await button(wrapper, '编辑').trigger('click');
    expect(wrapper.text()).toContain('留空保持原密钥');
    await wrapper.get('input[aria-label="名称"]').setValue('新的名称');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(saveDeployTarget).toHaveBeenCalledWith(id, id, expect.objectContaining({ name: '新的名称', privateKey: undefined }));
    expect(wrapper.find('textarea[aria-label="SSH 私钥"]').exists()).toBe(false);
  });
  it('shows history and logs, provides rollback for retained releases, and hides writes for viewers', async () => {
    const wrapper = await render('/' + jobId);
    expect(wrapper.text()).toContain('历史部署日志'); expect(wrapper.text()).toContain('部署成功');
    expect(wrapper.text()).toContain('回滚到此版本');
    await wrapper.findAll('button.confirm').at(-1)!.trigger('click'); await flushPromises();
    expect(rollbackDeployment).toHaveBeenCalledWith(id, jobId);
    wrapper.unmount(); access.role = 'viewer'; const viewer = await render();
    for (const text of ['添加目标', '编辑', '删除', '回滚到此版本']) expect(viewer.text()).not.toContain(text);
    expect(viewer.text()).toContain('站点主机');
  });
  it('clears visible target and history data when access is revoked', async () => {
    const wrapper = await render(); vi.mocked(listDeployTargets).mockRejectedValueOnce(new ProjectApiError('权限已撤销', 403));
    await button(wrapper, '刷新').trigger('click'); await flushPromises();
    expect(wrapper.text()).not.toContain('站点主机'); expect(wrapper.text()).toContain('权限已撤销');
  });
  it('offers recovery to the SQL-current retained release after a later deployment fails', async () => {
    vi.mocked(listDeployTargets).mockResolvedValue([{ ...target, currentReleaseId: job.releaseId }]);
    vi.mocked(listDeployments).mockResolvedValue([{ ...job, id, releaseId: id, status: 'failed', retained: false }, job]);
    const wrapper = await render();
    expect(wrapper.text()).toContain('当前版本（数据库记录）');
    expect(wrapper.text()).toContain('数据库记录可能与主机不一致');
    expect(wrapper.findAll('button').filter(button => button.text() === '回滚到此版本')).toHaveLength(1);
    await wrapper.findAll('button.confirm').at(-1)!.trigger('click'); await flushPromises();
    expect(rollbackDeployment).toHaveBeenCalledWith(id, jobId);
  });
  it('disables rollback while a target is active and hides it for removed targets or pruned releases', async () => {
    vi.mocked(listDeployments).mockResolvedValue([{ ...job, id, status: 'running', retained: false }, job]);
    const wrapper = await render();
    expect(button(wrapper, '回滚到此版本').attributes('disabled')).toBeDefined();
    vi.mocked(listDeployTargets).mockResolvedValue([]);
    await button(wrapper, '刷新').trigger('click'); await flushPromises();
    expect(wrapper.text()).not.toContain('回滚到此版本');
    vi.mocked(listDeployTargets).mockResolvedValue([target]);
    vi.mocked(listDeployments).mockResolvedValue([{ ...job, retained: false }]);
    await button(wrapper, '刷新').trigger('click'); await flushPromises();
    expect(wrapper.text()).not.toContain('回滚到此版本');
  });
});
