import { WeappJobPayloadSchema } from '@forgekit/contracts';
import { decryptWeappKey, isWeappBuild, WeappConflictError, type WeappRepository, type WeappLogRepository, type BuildRepository } from '@forgekit/db';
import { redactBuildLog } from './build-logs';
import type { WeappRunner } from './weapp-runner';
export class WeappProcessor {
  private stopping = false;
  private readonly active = new Set<AbortController>();
  constructor(private readonly jobs: Pick<WeappRepository, 'get' | 'config' | 'transition'>,
    private readonly builds: Pick<BuildRepository, 'get'>, private readonly logs: Pick<WeappLogRepository, 'append'>,
    private readonly runner: WeappRunner, private readonly encryptionKey: Buffer,
    private readonly removeArtifact: (key: string) => Promise<void>) {}
  shutdown() { this.stopping = true; for (const controller of this.active) controller.abort(); }
  async process(payload: unknown, queueId: string | undefined) {
    if (this.stopping) throw new Error('weapp_worker_stopping');
    const { jobId } = WeappJobPayloadSchema.parse(payload);
    if (queueId !== jobId) throw new Error('weapp_job_id_invalid');
    const job = await this.jobs.get(jobId);
    // Uploads are external side effects. Never repeat an ambiguous running job.
    if (!job || job.status !== 'queued') return;
    try { await this.jobs.transition(jobId, 'queued', 'running'); }
    catch (error) { if (error instanceof WeappConflictError) return; throw error; }
    const controller = new AbortController(); this.active.add(controller);
    const timer = setTimeout(() => controller.abort(), 330000);
    let secret: Buffer | undefined, qr: string | null = null, bytes = 0;
    const log = async (stream: 'stdout' | 'stderr' | 'system', content: string) => {
      content = redactBuildLog(content, secret ? [secret.toString('utf8')] : []);
      bytes += Buffer.byteLength(content);
      if (bytes > 65536) throw new Error('weapp_log_limit');
      await this.logs.append({ jobId, stream, content });
    };
    try {
      if (this.stopping) controller.abort(); controller.signal.throwIfAborted();
      const config = await this.jobs.config(job.projectId), build = await this.builds.get(job.buildId);
      if (!config || config.appId !== job.appId || !isWeappBuild(build, job.projectId)) throw new Error('weapp_input_unavailable');
      secret = decryptWeappKey(config.encryptedPrivateKey, this.encryptionKey, job.projectId);
      await log('system', '微信上传/预览任务开始。\n');
      qr = await this.runner.run(job, { key: build!.artifactKey!, sha256: build!.artifactSha256! }, secret,
        { write: (stream, content) => log(stream, content) }, controller.signal);
      controller.signal.throwIfAborted();
      if (job.input.action !== 'upload' && !qr) throw new Error('weapp_qr_missing');
      await log('system', '任务完成。体验版本需在微信公众平台手动选择；预览二维码请及时扫码。\n');
      await this.jobs.transition(jobId, 'running', 'succeeded', null, qr);
      qr = null;
    } catch {
      if (qr) await this.removeArtifact(qr);
      const code = controller.signal.aborted ? 'weapp_timeout_or_shutdown' : 'weapp_execution_failed';
      // Fixed summary only. SDK/crypto/driver error objects can contain credentials.
      // Preserve terminal state even if the log quota or DB log write has failed.
      await log('system', '任务失败，请检查 AppID、上传密钥、IP 白名单及网络；上传可能已完成，请先在微信后台核对。\n').catch(() => {});
      await this.jobs.transition(jobId, 'running', 'failed', code);
    } finally { secret?.fill(0); clearTimeout(timer); this.active.delete(controller); }
  }
}
