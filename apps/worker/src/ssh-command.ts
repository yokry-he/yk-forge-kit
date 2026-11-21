import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

export class SshDeployError extends Error {}
/** Suppress arbitrary remote/CLI text. Only fixed, actionable error codes leave this adapter. */
export function sshFailure(stderr: string): string {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|No .* host key is known|no matching host key type/i.test(stderr)) return 'ssh_host_key_mismatch';
  if (/Permission denied|Load key|invalid format|incorrect passphrase/i.test(stderr)) return 'ssh_auth_failed';
  return 'ssh_command_failed';
}
export async function boundedCommand(program: string, args: string[], signal: AbortSignal, inputFile?: string): Promise<string> {
  signal.throwIfAborted();
  const child = spawn(program, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' } });
  let output = '', error = '', bytes = 0;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    escalation ??= setTimeout(() => child.kill('SIGKILL'), 1000);
  };
  signal.addEventListener('abort', stop, { once: true });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(new SshDeployError('ssh_process_unavailable')));
    child.once('close', resolve);
  });
  const collect = async (stream: AsyncIterable<Uint8Array>, stderr: boolean) => {
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > 65536) { stop(); throw new SshDeployError('ssh_output_limit'); }
      if (stderr) error += Buffer.from(chunk).toString('utf8'); else output += Buffer.from(chunk).toString('utf8');
    }
  };
  const input = inputFile ? pipeline(createReadStream(inputFile), child.stdin) : Promise.resolve(child.stdin.end());
  const io = Promise.all([collect(child.stdout, false), collect(child.stderr, true), input]);
  void io.catch(stop);
  try {
    const [code] = await Promise.all([closed, io]);
    signal.throwIfAborted();
    if (code !== 0) throw new SshDeployError(program === 'ssh' ? sshFailure(error) : 'deploy_local_command_failed');
    return output;
  } catch (err) {
    stop(); await Promise.allSettled([closed, io]);
    if (signal.aborted) throw new SshDeployError('deploy_timeout_or_shutdown');
    // A failed handshake can close stdin (EPIPE) before tar has finished writing.
    if (program === 'ssh' && sshFailure(error) !== 'ssh_command_failed') throw new SshDeployError(sshFailure(error));
    if (err instanceof SshDeployError) throw err;
    throw new SshDeployError('ssh_command_failed');
  } finally {
    stop(); await Promise.allSettled([closed, io]); clearTimeout(escalation);
    signal.removeEventListener('abort', stop);
  }
}
export function sshArguments(target: { host: string; port: number; username: string; hostKey: string }, keyFile: string, hostsFile: string, command: string): string[] {
  const algorithm = target.hostKey.split(' ')[0]!;
  return ['-F', '/dev/null', '-T', '-a', '-x', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'ClearAllForwardings=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'CheckHostIP=no', '-o', 'UpdateHostKeys=no',
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', `UserKnownHostsFile=${hostsFile}`, '-o', 'HostKeyAlias=forgekit-target',
    '-o', `HostKeyAlgorithms=${algorithm === 'ssh-rsa' ? 'rsa-sha2-512,rsa-sha2-256' : algorithm}`,
    '-o', 'ConnectTimeout=10', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2',
    '-o', 'LogLevel=ERROR', '-i', keyFile, '-p', String(target.port), '-l', target.username, target.host, command];
}

/** Streaming variant of the same pinned CLI channel. Bounds raw output before line decoding/redaction. */
export async function streamingCommand(program: string, args: string[], signal: AbortSignal, maxBytes: number,
  consume: (stream: AsyncIterable<Uint8Array>) => Promise<void>): Promise<void> {
  signal.throwIfAborted();
  const child = spawn(program, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' } });
  let stderr = '', bytes = 0, escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM'); escalation ??= setTimeout(() => child.kill('SIGKILL'), 1000);
  };
  signal.addEventListener('abort', stop, { once: true });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(new SshDeployError('ssh_process_unavailable')));
    child.once('close', resolve);
  });
  async function* stdout() {
    for await (const chunk of child.stdout) {
      bytes += chunk.length;
      if (bytes > maxBytes) throw new SshDeployError('ssh_output_limit');
      yield chunk as Uint8Array;
    }
  }
  const errors = (async () => {
    for await (const chunk of child.stderr) {
      if (Buffer.byteLength(stderr) + chunk.length > 65536) throw new SshDeployError('ssh_output_limit');
      stderr += Buffer.from(chunk).toString('utf8');
    }
  })();
  const io = Promise.all([consume(stdout()), errors]); void io.catch(stop);
  try {
    const [code] = await Promise.all([closed, io]);
    signal.throwIfAborted();
    if (code !== 0) throw new SshDeployError(sshFailure(stderr));
  } finally {
    stop(); await Promise.allSettled([closed, io]); clearTimeout(escalation);
    signal.removeEventListener('abort', stop);
  }
}
