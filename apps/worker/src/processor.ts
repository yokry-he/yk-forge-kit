import { BuildJobPayloadSchema, canTransition, classifyBuildFailure, type BuildStatus, type DiagnosisLog } from '@forgekit/contracts';
import { BuildTransitionError, type BuildRepository, type BuildLogRepository } from '@forgekit/db';
import { BuildRunnerFailure, RepositoryLogSink, type BuildRunner } from './runner';

type Repository = Pick<BuildRepository, 'get' | 'updateStatus'>;
const terminal = (status: BuildStatus) => !canTransition(status, 'canceled');

/** Only invoke while holding the BullMQ job lock for this build ID. */
export class BuildProcessor {
  private stopping = false;
  private readonly active = new Set<AbortController>();
  constructor(private readonly builds: Repository, private readonly logs: Pick<BuildLogRepository, 'append'>,
    private readonly runner: BuildRunner, private readonly timeoutMs: number, private readonly pollMs = 250) {}

  shutdown(): void {
    this.stopping = true;
    for (const controller of this.active) controller.abort(new Error('worker_shutdown'));
  }

  private async finish(id: string, status: 'succeeded' | 'failed' | 'timed_out', patch: Parameters<BuildRepository['updateStatus']>[3]) {
    if (status !== 'succeeded' && !patch?.diagnosis) patch = { ...patch,
      diagnosis: classifyBuildFailure({ errorCodes: patch?.errorMessage?.split(':').slice(0, 1), logs: [] }) };
    try {
      try { await this.builds.updateStatus(id, 'running', status, patch); }
      catch (error) {
        if (error instanceof BuildTransitionError || !patch?.diagnosis) throw error;
        // Diagnosis is optional: retry the same terminal result without it so a JSON
        // persistence error cannot replace the original exit code or failure fields.
        const { diagnosis: _diagnosis, ...terminalPatch } = patch;
        await this.builds.updateStatus(id, 'running', status, terminalPatch);
      }
    }
    catch (error) {
      if (!(error instanceof BuildTransitionError)) throw error;
      const current = await this.builds.get(id);
      if (current && !terminal(current.status)) throw error;
    }
  }

  /** Redelivery of running means the previous owner lost its queue lock; never execute it twice. */
  async process(payload: unknown, jobId: string | undefined): Promise<void> {
    if (this.stopping) throw new Error('worker_stopping');
    const { buildId } = BuildJobPayloadSchema.parse(payload);
    if (jobId !== buildId) throw new Error('job id must equal build id');
    const build = await this.builds.get(buildId);
    if (!build || terminal(build.status)) return;
    if (build.status === 'running') {
      await this.finish(buildId, 'failed', { errorMessage: 'worker_lost: previous queue lease expired; create a new build to retry' });
      return;
    }
    let running;
    try { running = await this.builds.updateStatus(buildId, 'queued', 'running'); }
    catch (error) {
      if (!(error instanceof BuildTransitionError)) throw error;
      const current = await this.builds.get(buildId);
      if (!current || terminal(current.status)) return;
      throw error;
    }

    if (this.stopping) {
      await this.finish(buildId, 'failed', { errorMessage: 'worker_shutdown' });
      return;
    }
    const controller = new AbortController();
    this.active.add(controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let timedOut = false;
    let canceled = false;
    const control = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      timeout = setTimeout(() => { timedOut = true; controller.abort(new Error('build_timeout')); }, this.timeoutMs);
      const check = async () => {
        try {
          const current = await this.builds.get(buildId);
          if (!current || terminal(current.status)) {
            canceled = true;
            controller.abort(new Error('build_canceled'));
          }
        } catch (error) { controller.abort(error); }
        if (!stopped && !controller.signal.aborted) poll = setTimeout(() => { void check(); }, this.pollMs);
      };
      // First read also catches cancellation between queued->running and runner startup.
      poll = setTimeout(() => { void check(); }, 0);
    });
    // Match stored sequence numbers, keeping a bounded tail even for custom runners.
    const diagnosisLogs: DiagnosisLog[] = [];
    let diagnosisBytes = 0;
    const sink = new RepositoryLogSink(buildId, this.logs, controller.signal, log => {
      diagnosisLogs.push(log); diagnosisBytes += Buffer.byteLength(log.content);
      while (diagnosisLogs.length > 5000 || diagnosisBytes > 2 * 1024 * 1024) {
        diagnosisBytes -= Buffer.byteLength(diagnosisLogs.shift()!.content);
      }
    });
    const execution = Promise.resolve().then(() => this.runner.run(running, sink, controller.signal));
    try {
      const result = await Promise.race([execution, control]);
      if (!Number.isInteger(result.exitCode) || result.exitCode < -2147483648 || result.exitCode > 2147483647) {
        throw new Error('invalid_runner_result');
      }
      await this.finish(buildId, result.exitCode === 0 ? 'succeeded' : 'failed', {
        exitCode: result.exitCode, runnerInfo: result.runnerInfo,
        ...(result.exitCode !== 0 ? { diagnosis: classifyBuildFailure({ ...result.failureSignals,
          exitCode: result.exitCode, logs: diagnosisLogs }) } : {}),
        ...(result.exitCode === 0 && result.artifact ? { artifactKey: result.artifact.key,
          artifactSize: result.artifact.size, artifactSha256: result.artifact.sha256 } : {}),
      });
    } catch (error) {
      // Only allowlisted internal messages reach the classifier, never arbitrary exceptions.
      const safeCodes = ['build_timeout', 'build_output_missing', 'docker_cli_error', 'docker_cleanup_failed',
        'docker_worker_requires_non_root', 'missing_registry_egress'];
      const code = timedOut ? 'build_timeout' : error instanceof BuildRunnerFailure ? error.code
        : error instanceof Error && safeCodes.includes(error.message) ? error.message : 'runner_or_control_failure';
      if (!canceled) await this.finish(buildId, timedOut ? 'timed_out' : 'failed', {
        errorMessage: timedOut ? 'build_timeout' : 'runner_or_control_failure',
        diagnosis: classifyBuildFailure({ ...(error instanceof BuildRunnerFailure ? error.failureSignals : {}),
          errorCodes: [code], logs: diagnosisLogs }),
      });
    } finally {
      stopped = true;
      clearTimeout(timeout);
      clearTimeout(poll);
      controller.abort(new Error('build_finished'));
      // The race handles the outcome; an aborted runner may reject only after asynchronous cleanup.
      // Keep the processor pending (and BullMQ's concurrency slot/lock) until that cleanup settles.
      await Promise.allSettled([execution]);
      this.active.delete(controller);
    }
  }
}
