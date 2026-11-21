import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { BuildIdSchema, DeployTargetCreateSchema, RuntimeLogInputSchema, RUNTIME_LOG_LIMITS as limits, type RuntimeLogInput } from '@forgekit/contracts';
import { decryptDeployKey, type DeployTargetRow } from '@forgekit/db';
import { shellQuote } from './ssh-release';
import { sshArguments, streamingCommand } from './ssh-command';
import { redactBuildLog } from './build-logs';

// No request-provided path/argv or filter enters the shell. Only validated server-side identities vary.
export function runtimeLogPath(basePath: string, domainId: string, source: string) {
  const base = DeployTargetCreateSchema.shape.basePath.parse(basePath);
  const id = BuildIdSchema.parse(domainId);
  const parsed = RuntimeLogInputSchema.shape.source.parse(source);
  return `${base}/.forgekit-caddy/logs/${id}/${parsed === 'caddy-access' ? 'access' : 'error'}.jsonl`;
}
/** Fixed single remote process: bounded tail, follow rotation, no symlinks, no tail subprocess to orphan. */
export const runtimeLogProgram = String.raw`
import os, stat, sys, time
path, lines = sys.argv[1], int(sys.argv[2])
limit, used, deadline = 1048576, 0, time.monotonic() + 60

def open_log():
    directory = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        parts = path.strip('/').split('/')
        for part in parts[:-1]:
            new = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            os.close(directory)
            directory = new
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            os.close(fd)
            raise RuntimeError('not_regular')
        return os.fdopen(fd, 'rb')
    finally: os.close(directory)

def emit(data):
    global used
    if any(len(line) + 1 > 65536 for line in data.split(b'\n')[:-1]): raise RuntimeError('line_limit')
    used += len(data)
    if used > limit: raise RuntimeError('limit')
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()

try:
    f = open_log()
    size = os.fstat(f.fileno()).st_size
    start = max(0, size - limit)
    f.seek(start)
    data = f.read(limit)
    if start: data = data.partition(b'\n')[2]
    # Only complete lines; carry a partial trailing line across reads, never publish fragments.
    end = data.rfind(b'\n') + 1
    pending = data[end:]
    if len(pending) > 65536: raise RuntimeError('line_limit')
    emit(b''.join(data[:end].splitlines(keepends=True)[-lines:]))
    while time.monotonic() < deadline:
        data = f.read(8192)
        if data:
            pending += data
            end = pending.rfind(b'\n') + 1
            if end: emit(pending[:end]); pending = pending[end:]
            if len(pending) > 65536: raise RuntimeError('line_limit')
        else:
            current = open_log()
            old, new = os.fstat(f.fileno()), os.fstat(current.fileno())
            if (old.st_dev, old.st_ino) != (new.st_dev, new.st_ino) or new.st_size < f.tell():
                f.close(); f = current; pending = b''
            else: current.close()
            time.sleep(0.25)
    f.close()
except BaseException:
    # No paths, raw exceptions or log text on stderr.
    sys.exit(1)
`;
export function runtimeLogCommand(basePath: string, domainId: string, source: string, lines: number) {
  const path = runtimeLogPath(basePath, domainId, source);
  const count = RuntimeLogInputSchema.shape.lines.parse(lines);
  return `exec timeout --signal=TERM --kill-after=2s 65s python3 -u -c ${shellQuote(runtimeLogProgram)} ${shellQuote(path)} ${count}`;
}
export interface RuntimeLogHost {
  read(target: DeployTargetRow, input: RuntimeLogInput, secrets: readonly string[], line: (value: string) => Promise<void>, signal: AbortSignal): Promise<void>;
}
export class SshRuntimeLogHost implements RuntimeLogHost {
  constructor(private readonly encryptionKey: Buffer) {}
  async read(target: DeployTargetRow, input: RuntimeLogInput, secrets: readonly string[], line: (value: string) => Promise<void>, signal: AbortSignal) {
    input = RuntimeLogInputSchema.parse(input);
    const validated = DeployTargetCreateSchema.omit({ privateKey: true }).parse({ name: target.name, host: target.host,
      port: target.port, username: target.username, hostKey: target.hostKey, basePath: target.basePath, retention: target.retention });
    if (!target.encryptedPrivateKey) throw new Error('runtime_target_unavailable');
    const work = await mkdtemp(join(tmpdir(), 'forgekit-runtime-'));
    let plaintext: Buffer | undefined;
    try {
      plaintext = decryptDeployKey(target.encryptedPrivateKey, this.encryptionKey, target.projectId, target.id);
      const redactSecrets = [...secrets, plaintext.toString('utf8'), target.encryptedPrivateKey, this.encryptionKey.toString('hex')];
      const keyFile = join(work, 'identity'), hostsFile = join(work, 'known_hosts');
      await writeFile(keyFile, plaintext, { mode: 0o600 }); plaintext.fill(0); plaintext = undefined;
      await writeFile(hostsFile, `forgekit-target ${validated.hostKey}\n`, { mode: 0o600 });
      await streamingCommand('ssh', sshArguments(validated, keyFile, hostsFile,
        runtimeLogCommand(validated.basePath, input.domainId, input.source, input.lines)), signal, limits.bytes, async stream => {
        const decoder = new StringDecoder('utf8');
        let pending = '';
        for await (const chunk of stream) {
          pending += decoder.write(Buffer.from(chunk));
          let end: number;
          while ((end = pending.indexOf('\n')) >= 0) {
            const value = pending.slice(0, end + 1); pending = pending.slice(end + 1);
            if (Buffer.byteLength(value) > limits.lineBytes) throw new Error('runtime_line_limit');
            await line(redactBuildLog(value, redactSecrets));
          }
          if (Buffer.byteLength(pending) > limits.lineBytes) throw new Error('runtime_line_limit');
        }
        // EOF/abort may cut a secret in half. Never publish an incomplete final line.
      });
      redactSecrets.fill('');
    } finally { plaintext?.fill(0); await rm(work, { recursive: true, force: true }); }
  }
}
