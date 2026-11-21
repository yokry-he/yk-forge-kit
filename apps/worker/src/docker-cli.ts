import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { CappedBuildLogs } from './build-logs';

export interface DockerCommand {
  execute(args: string[], signal: AbortSignal, logs?: CappedBuildLogs, variables?: Readonly<Record<string, string>>, input?: Uint8Array): Promise<number>;
}
export type DockerSpawn = (args: string[], variables?: Readonly<Record<string, string>>) => ChildProcessByStdio<Writable | null, Readable, Readable>;

/** No shell on the host; terminate only the CLI child we spawned. Containers are removed by the runner. */
export class DockerCli implements DockerCommand {
  constructor(private readonly start: DockerSpawn = (args, variables) => spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...variables, FORGEKIT_DEPLOY_ENCRYPTION_KEY: undefined } })) {}
  async execute(args: string[], signal: AbortSignal, logs?: CappedBuildLogs, variables?: Readonly<Record<string, string>>, input?: Uint8Array): Promise<number> {
    signal.throwIfAborted();
    const child = this.start(args, variables);
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
    const sent = new Promise<void>((resolve, reject) => {
      if (!child.stdin) { if (input) reject(new Error('docker_cli_input_unavailable')); else resolve(); return; }
      child.stdin.on('error', () => reject(new Error('docker_cli_input_error')));
      child.stdin.end(input, (error?: Error | null) => error ? reject(new Error('docker_cli_input_error')) : resolve());
    });
    const discard = async (input: AsyncIterable<Uint8Array>) => { for await (const _chunk of input) { /* drain bounded pipe */ } };
    const output = Promise.all([
      logs ? logs.consume('stdout', child.stdout) : discard(child.stdout),
      logs ? logs.consume('stderr', child.stderr) : discard(child.stderr),
    ]);
    // A log persistence/limit failure must stop the CLI too, even if the process keeps writing.
    void output.catch(stop);
    void sent.catch(stop);
    try {
      const [code] = await Promise.all([closed, output, sent]);
      signal.throwIfAborted();
      return code;
    } finally {
      stop();
      await Promise.allSettled([closed, output, sent]);
      clearTimeout(escalation);
      signal.removeEventListener('abort', stop);
    }
  }
}
