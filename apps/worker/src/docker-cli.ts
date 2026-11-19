import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { CappedBuildLogs } from './build-logs';

export interface DockerCommand {
  execute(args: string[], signal: AbortSignal, logs?: CappedBuildLogs): Promise<number>;
}
export type DockerSpawn = (args: string[]) => ChildProcessByStdio<null, Readable, Readable>;

/** No shell on the host; terminate only the CLI child we spawned. Containers are removed by the runner. */
export class DockerCli implements DockerCommand {
  constructor(private readonly start: DockerSpawn = (args) => spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })) {}
  async execute(args: string[], signal: AbortSignal, logs?: CappedBuildLogs): Promise<number> {
    signal.throwIfAborted();
    const child = this.start(args);
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      escalation ??= setTimeout(() => { child.kill('SIGKILL'); }, 1000);
    };
    signal.addEventListener('abort', stop, { once: true });
    const closed = new Promise<number>((resolve, reject) => {
      child.once('error', () => reject(new Error('docker_cli_error')));
      child.once('close', (code) => resolve(code ?? 1));
    });
    const discard = async (input: AsyncIterable<Uint8Array>) => { for await (const _chunk of input) { /* drain bounded pipe */ } };
    const output = Promise.all([
      logs ? logs.consume('stdout', child.stdout) : discard(child.stdout),
      logs ? logs.consume('stderr', child.stderr) : discard(child.stderr),
    ]);
    // A log persistence/limit failure must stop the CLI too, even if the process keeps writing.
    void output.catch(stop);
    try {
      const [code] = await Promise.all([closed, output]);
      signal.throwIfAborted();
      return code;
    } finally {
      stop();
      await Promise.allSettled([closed, output]);
      clearTimeout(escalation);
      signal.removeEventListener('abort', stop);
    }
  }
}
