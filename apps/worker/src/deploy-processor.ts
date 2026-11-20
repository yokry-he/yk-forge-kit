import { DeployJobPayloadSchema } from '@forgekit/contracts';
import { BuildRepository, DeployConflictError, DeployLogRepository, DeployRepository, type ResolvedVariables } from '@forgekit/db';
import { SshDeployError } from './ssh-command';
import { redactBuildLog } from './build-logs';
import type { StaticDeployer } from './ssh-deployer';

export function deployErrorCode(error: unknown): string {
  const codes = ['ssh_host_key_mismatch', 'ssh_auth_failed', 'ssh_command_failed', 'ssh_process_unavailable',
    'ssh_output_limit', 'deploy_timeout_or_shutdown', 'deploy_target_incomplete', 'release_not_retained',
    'artifact_entry_limit', 'artifact_size_limit', 'artifact_integrity_failed', 'deploy_remote_result_invalid', 'deploy_local_command_failed'];
  return error instanceof SshDeployError && codes.includes(error.message) ? error.message : 'deploy_execution_failed';
}
export class DeployProcessor {
  private stopping = false;
  private readonly active = new Set<AbortController>();
  constructor(private readonly jobs: Pick<DeployRepository, 'get' | 'target' | 'transition' | 'retained'>,
    private readonly builds: Pick<BuildRepository, 'get'>, private readonly logs: Pick<DeployLogRepository, 'append'>,
    private readonly deployer: StaticDeployer,
    private readonly variables: (projectId: string, environmentId: string) => Promise<ResolvedVariables> = async () => ({ values: {}, secrets: [] })) {}
  shutdown() { this.stopping = true; for (const controller of this.active) controller.abort(); }
  async process(payload: unknown, jobId: string | undefined) {
    if (this.stopping) throw new Error('deploy_worker_stopping');
    const { deploymentId } = DeployJobPayloadSchema.parse(payload);
    if (deploymentId !== jobId) throw new Error('deploy_job_id_invalid');
    const job = await this.jobs.get(deploymentId);
    if (!job || !['pending', 'running'].includes(job.status)) return;
    // A redelivered running record is ambiguous. Recovery waits beyond the remote execution deadline.
    if (job.status === 'running') return;
    try { await this.jobs.transition(job.id, 'pending', 'running'); }
    catch (error) { if (error instanceof DeployConflictError) return; throw error; }
    const controller = new AbortController(); this.active.add(controller);
    const timer = setTimeout(() => controller.abort(), 330000);
    let resolved: ResolvedVariables = { values: {}, secrets: [] };
    let bytes = 0;
    const log = async (content: string) => {
      content = redactBuildLog(content, resolved.secrets);
      bytes += Buffer.byteLength(content);
      if (bytes > 65536) throw new Error('deploy_log_limit');
      await this.logs.append({ deploymentId, stream: 'system', content });
    };
    try {
      if (this.stopping) controller.abort();
      controller.signal.throwIfAborted();
      const target = await this.jobs.target(job.projectId, job.deployTargetId);
      const build = await this.builds.get(job.buildId);
      if (!target || target.disabledAt || !build || build.projectId !== job.projectId || build.status !== 'succeeded' || !build.artifactKey || !build.artifactSha256) throw new Error('deploy_input_unavailable');
      resolved = await this.variables(job.projectId, job.environmentId);
      const retained = (await this.jobs.retained(target.id)).flatMap(row => row.releaseId ? [row.releaseId] : []);
      const keep = await this.deployer.run(job, target, { key: build.artifactKey, sha256: build.artifactSha256 }, retained, log, controller.signal, resolved.values);
      controller.signal.throwIfAborted();
      // Final log is persisted before terminal status, so SSE's terminal high-water snapshot includes it.
      await log('部署任务完成。\n');
      await this.jobs.transition(job.id, 'running', job.action === 'rollback' ? 'rolled_back' : 'succeeded', null, keep);
    } catch (error) {
      const code = controller.signal.aborted ? 'deploy_timeout_or_shutdown' : deployErrorCode(error);
      await log(`部署失败：${code}。请查看主机状态后创建新任务。\n`);
      await this.jobs.transition(job.id, 'running', 'failed', code);
    } finally { resolved.values = {}; resolved.secrets = []; clearTimeout(timer); this.active.delete(controller); }
  }
}
