import { redactBuildLog, type BuildLogEvent, type BuildFailureSignals } from '@forgekit/contracts';
import type { BuildRepository, BuildLogRepository } from '@forgekit/db';
import type { RunnerInfo } from '@forgekit/contracts';
import type { ArtifactMetadata } from './artifact-store';

export type { ArtifactStore } from './artifact-store';

type PersistedBuild = NonNullable<Awaited<ReturnType<BuildRepository['get']>>>;
export type BuildRecord = Omit<PersistedBuild, 'target'> & { target?: PersistedBuild['target'] };
export interface BuildLogSink {
  write(stream: BuildLogEvent['stream'], content: string): Promise<void>;
}
/** B09 must terminate and clean up its isolated process when signal is aborted. */
export interface BuildRunner {
  run(build: BuildRecord, logs: BuildLogSink, signal: AbortSignal): Promise<{
    exitCode: number; artifact?: ArtifactMetadata; runnerInfo?: RunnerInfo; failureSignals?: BuildFailureSignals;
  }>;
}
export class RepositoryLogSink implements BuildLogSink {
  constructor(private readonly buildId: string, private readonly logs: Pick<BuildLogRepository, 'append'>,
    private readonly signal: AbortSignal,
    private readonly onLog?: (log: { seq: number; content: string }) => void) {}
  async write(stream: BuildLogEvent['stream'], content: string): Promise<void> {
    this.signal.throwIfAborted();
    const row = await this.logs.append({ buildId: this.buildId, stream, content: redactBuildLog(content) });
    this.onLog?.(row);
  }
}

/** Carries only fixed codes, never a raw exception or environment value. */
export class BuildRunnerFailure extends Error {
  constructor(readonly code: 'build_artifact_missing' | 'artifact_storage_unavailable', readonly failureSignals: BuildFailureSignals) { super(code); }
}
/** Never reads sourceRef, executes user code, or creates an artifact. */
export class NoopRunner implements BuildRunner {
  async run(_build: BuildRecord, logs: BuildLogSink, signal: AbortSignal) {
    for (const line of ['NoopRunner: starting\n', 'NoopRunner: no source executed\n', 'NoopRunner: done\n']) {
      signal.throwIfAborted();
      await logs.write('stdout', line);
    }
    return { exitCode: 0 };
  }
}
