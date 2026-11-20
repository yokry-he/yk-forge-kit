import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { BuildRepository, DeployRepository, DeploymentRow, DeployTargetRow } from '@forgekit/db';
import { DeployProcessor } from '../src/deploy-processor';
import { SshDeployError } from '../src/ssh-command';
import type { StaticDeployer } from '../src/ssh-deployer';
const now = new Date(), id = randomUUID();
const row: DeploymentRow = { id, projectId: id, buildId: id, deployTargetId: id, environmentId: id, action: 'deploy', releaseId: id,
  status: 'pending', rollbackOf: null, triggeredBy: id, retained: false, errorMessage: null, startedAt: null, finishedAt: null, createdAt: now, updatedAt: now };
function fixture() {
  const jobs = { get: vi.fn().mockResolvedValue(row), target: vi.fn().mockResolvedValue({ id, projectId: id } satisfies Partial<DeployTargetRow>),
    retained: vi.fn().mockResolvedValue([]), transition: vi.fn().mockResolvedValue(undefined) } satisfies Pick<DeployRepository, 'get' | 'target' | 'retained' | 'transition'>;
  const builds = { get: vi.fn().mockResolvedValue({ projectId: id, status: 'succeeded', artifactKey: 'artifact', artifactSha256: 'a'.repeat(64) }) } satisfies Pick<BuildRepository, 'get'>;
  const logs = { append: vi.fn().mockResolvedValue(undefined) };
  const deployer: StaticDeployer = { run: vi.fn().mockResolvedValue([id]) };
  return { jobs, builds, logs, deployer, processor: new DeployProcessor(jobs, builds, logs, deployer) };
}
describe('deploy job orchestration', () => {
  it('executes a pending job once and persists final logs before committing success', async () => {
    const { processor, jobs, logs, deployer } = fixture();
    await processor.process({ deploymentId: id }, id);
    expect(jobs.transition.mock.calls).toEqual([[id, 'pending', 'running'], [id, 'running', 'succeeded', null, [id]]]);
    expect(logs.append.mock.invocationCallOrder.at(-1)).toBeLessThan(jobs.transition.mock.invocationCallOrder.at(-1)!);
    expect(deployer.run).toHaveBeenCalledOnce();
  });
  it('never reruns an ambiguous running or terminal record and rejects mismatched queue ids', async () => {
    const { processor, jobs, deployer } = fixture();
    for (const status of ['running', 'succeeded', 'failed', 'rolled_back'] as const) {
      jobs.get.mockResolvedValue({ ...row, status }); await processor.process({ deploymentId: id }, id);
    }
    expect(deployer.run).not.toHaveBeenCalled();
    await expect(processor.process({ deploymentId: id }, randomUUID())).rejects.toThrow('deploy_job_id_invalid');
  });
  it.each(['final log', 'success transition'])('can restore A after B switches but its %s fails', async failure => {
    const { processor, jobs, logs, deployer } = fixture();
    const releaseA = randomUUID();
    const sqlTarget = { id, projectId: id, currentReleaseId: releaseA };
    let remoteRelease = releaseA;
    jobs.target.mockResolvedValue(sqlTarget);
    jobs.retained.mockResolvedValue([{ ...row, id: releaseA, releaseId: releaseA, status: 'succeeded', retained: true }]);
    vi.mocked(deployer.run).mockImplementation(async job => {
      remoteRelease = job.releaseId!; return [id, releaseA];
    });
    if (failure === 'final log') logs.append.mockRejectedValueOnce(new Error('log_write_failed'));
    else jobs.transition.mockImplementation(async (_id, _from, to) => {
      if (to === 'succeeded') throw new Error('database_write_failed');
    });
    await processor.process({ deploymentId: id }, id);
    expect(remoteRelease).toBe(id);
    expect(sqlTarget.currentReleaseId).toBe(releaseA);
    expect(jobs.transition).toHaveBeenLastCalledWith(id, 'running', 'failed', 'deploy_execution_failed');
    // The recovery request uses retained A even though SQL already reports A.
    const recoveryId = randomUUID();
    jobs.get.mockResolvedValue({ ...row, id: recoveryId, action: 'rollback', rollbackOf: releaseA, releaseId: releaseA });
    await processor.process({ deploymentId: recoveryId }, recoveryId);
    expect(remoteRelease).toBe(releaseA);
    expect(jobs.transition).toHaveBeenLastCalledWith(recoveryId, 'running', 'rolled_back', null, [id, releaseA]);
  });
  it('records pinning failure without exposing arbitrary exception text', async () => {
    for (const exception of [new SshDeployError('ssh_host_key_mismatch'), new Error('PRIVATE KEY raw-key passphrase=secret')]) {
      const { processor, jobs, logs, deployer } = fixture();
      vi.mocked(deployer.run).mockRejectedValue(exception); await processor.process({ deploymentId: id }, id);
      const code = exception instanceof SshDeployError ? 'ssh_host_key_mismatch' : 'deploy_execution_failed';
      expect(jobs.transition).toHaveBeenLastCalledWith(id, 'running', 'failed', code);
      const serialized = JSON.stringify(logs.append.mock.calls);
      expect(serialized).toContain(code); expect(serialized).not.toContain('raw-key'); expect(serialized).not.toContain('passphrase');
    }
  });
  it('marks rollback operations separately and rejects unavailable builds before connecting', async () => {
    const { processor, jobs, builds, deployer } = fixture();
    jobs.get.mockResolvedValue({ ...row, action: 'rollback', rollbackOf: id }); await processor.process({ deploymentId: id }, id);
    expect(jobs.transition).toHaveBeenLastCalledWith(id, 'running', 'rolled_back', null, [id]);
    vi.mocked(deployer.run).mockClear(); builds.get.mockResolvedValue(null);
    await processor.process({ deploymentId: id }, id); expect(deployer.run).not.toHaveBeenCalled();
    expect(jobs.transition).toHaveBeenLastCalledWith(id, 'running', 'failed', 'deploy_execution_failed');
  });
});
