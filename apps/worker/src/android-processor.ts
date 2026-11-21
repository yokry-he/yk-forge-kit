import { AndroidJobPayloadSchema, AndroidSigningSchema, AndroidSettingsSchema } from '@forgekit/contracts';
import { decryptAndroidSigning, AndroidConflictError, type AndroidRepository, type AndroidLogRepository } from '@forgekit/db';
import { redactBuildLog } from './build-logs';
import type { AndroidRunner } from './android-runner';
export class AndroidProcessor {
  private stopping = false;
  private readonly active = new Set<AbortController>();
  constructor(private readonly jobs: Pick<AndroidRepository, 'get' | 'config' | 'transition'>,
    private readonly logs: Pick<AndroidLogRepository, 'append'>, private readonly runner: AndroidRunner,
    private readonly encryptionKey: Buffer, private readonly removeArtifact: (key: string) => Promise<void>) {}
  shutdown() { this.stopping = true; for (const controller of this.active) controller.abort(); }
  async process(payload: unknown, queueId: string | undefined) {
    if (this.stopping) throw new Error('android_worker_stopping');
    const { jobId } = AndroidJobPayloadSchema.parse(payload);
    if (queueId !== jobId) throw new Error('android_job_id_invalid');
    const job = await this.jobs.get(jobId);
    if (!job || !['queued', 'running'].includes(job.status)) return;
    // Reclaimed running jobs are ambiguous; never start a second container tree.
    if (job.status === 'running') {
      try { await this.jobs.transition(jobId, 'running', 'failed', 'android_worker_lost'); }
      catch (error) { if (!(error instanceof AndroidConflictError)) throw error; } return;
    }
    try { await this.jobs.transition(jobId, 'queued', 'running'); }
    catch (error) { if (error instanceof AndroidConflictError) return; throw error; }
    const controller = new AbortController(); this.active.add(controller);
    const timer = setTimeout(() => controller.abort(), 1800000);
    let poll: Promise<void> | undefined;
    const interval = setInterval(() => {
      if (poll) return;
      poll = this.jobs.get(jobId).then(current => { if (current?.status !== 'running' || current.errorCode === 'android_cancel_requested') controller.abort(); })
        .catch(() => controller.abort()).finally(() => { poll = undefined; });
    }, 1000);
    let secret: Buffer | undefined, artifactKey: string | undefined, bytes = 0;
    let secrets: string[] = [];
    const log = async (stream: 'stdout' | 'stderr' | 'system', content: string) => {
      content = redactBuildLog(content, secrets); bytes += Buffer.byteLength(content);
      if (bytes > 1048576) throw new Error('android_log_limit');
      await this.logs.append({ jobId, stream, content });
    };
    try {
      if (this.stopping) controller.abort(); controller.signal.throwIfAborted();
      if (job.input.buildType === 'release') {
        const config = await this.jobs.config(job.projectId);
        if (!config?.encryptedSigning || JSON.stringify(AndroidSettingsSchema.parse(config.settings)) !== JSON.stringify(AndroidSettingsSchema.parse(job.settings))) throw new Error('android_config_changed');
        secret = decryptAndroidSigning(config.encryptedSigning, this.encryptionKey, job.projectId);
        const signing = AndroidSigningSchema.parse(JSON.parse(secret.toString()));
        secrets = Object.values(signing);
      }
      await log('system', 'Android 打包任务开始。\n');
      const result = await this.runner.run(job, secret, { write: log }, controller.signal);
      artifactKey = result.key; controller.signal.throwIfAborted();
      await log('system', 'Android 安装包已生成并签名。\n');
      await this.jobs.transition(jobId, 'running', 'succeeded', null, result.key, result.artifact);
      artifactKey = undefined;
    } catch {
      try { if (artifactKey) await this.removeArtifact(artifactKey); }
      finally {
        await log('system', '打包失败或已取消，请检查工具镜像、离线依赖、App 配置和签名材料。\n').catch(() => {});
        try { await this.jobs.transition(jobId, 'running', 'failed', controller.signal.aborted ? 'android_aborted' : 'android_execution_failed'); }
        catch (error) { if (!(error instanceof AndroidConflictError)) throw error; }
      }
    } finally { secret?.fill(0); secrets = []; clearTimeout(timer); clearInterval(interval); await poll; this.active.delete(controller); }
  }
}
