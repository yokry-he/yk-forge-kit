import type { BuildLogEvent } from '@forgekit/contracts';
import type { BuildRepository, BuildLogRepository } from '@forgekit/db';

export type BuildRecord = NonNullable<Awaited<ReturnType<BuildRepository['get']>>>;
export interface BuildLogSink {
  write(stream: BuildLogEvent['stream'], content: string): Promise<void>;
}
/** B09 must terminate and clean up its isolated process when signal is aborted. */
export interface BuildRunner {
  run(build: BuildRecord, logs: BuildLogSink, signal: AbortSignal): Promise<{ exitCode: number }>;
}
/** Capability boundary only. No storage implementation or artifact download in B08. */
export interface ArtifactStore {
  put(buildId: string, source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<{
    key: string; size: number; sha256: string;
  }>;
}
export class RepositoryLogSink implements BuildLogSink {
  constructor(private readonly buildId: string, private readonly logs: Pick<BuildLogRepository, 'append'>,
    private readonly signal: AbortSignal) {}
  async write(stream: BuildLogEvent['stream'], content: string): Promise<void> {
    this.signal.throwIfAborted();
    await this.logs.append({ buildId: this.buildId, stream, content });
  }
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
