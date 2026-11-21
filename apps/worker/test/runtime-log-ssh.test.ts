import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile, rename, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeLogInputSchema } from '@forgekit/contracts';
import { encryptDeployKey, type DeployTargetRow } from '@forgekit/db';
import { runtimeLogPath, runtimeLogCommand, runtimeLogProgram, SshRuntimeLogHost } from '../src/runtime-log-ssh';
import * as command from '../src/ssh-command';
const actual = command.streamingCommand;
afterEach(() => vi.restoreAllMocks());
const id = randomUUID();
describe('allowlisted log command', () => {
  it('derives only known Caddy paths and rejects injection into every remote operand', () => {
    expect(runtimeLogPath('/srv/site', id, 'caddy-access')).toBe(`/srv/site/.forgekit-caddy/logs/${id}/access.jsonl`);
    expect(runtimeLogPath('/srv/site', id, 'caddy-error')).toContain('/error.jsonl');
    expect(runtimeLogCommand('/srv/site', id, 'caddy-access', 1000)).toContain('exec timeout --signal=TERM --kill-after=2s 65s python3');
    for (const source of ['../../etc/passwd', 'caddy-access;id', '$(id)', '*', '--help']) expect(() => runtimeLogPath('/srv/site', id, source)).toThrow();
    for (const base of ['/tmp/site', '/srv/site/../etc', '/srv/$(id)', '/srv/site;id', '/srv/a b', '/srv/site\n']) expect(() => runtimeLogPath(base, id, 'caddy-access')).toThrow();
    for (const domain of [id + ';id', '../../etc/passwd', '$(id)', '*']) expect(() => runtimeLogPath('/srv/site', domain, 'caddy-access')).toThrow();
    for (const lines of [-1, 0, 1001, 1.5, NaN]) expect(() => runtimeLogCommand('/srv/site', id, 'caddy-access', lines)).toThrow();
  });
});
describe('real fixed Python reader through trusted SSH adapter boundary', () => {
  it.each([
    { name: 'completed line below the cap', suffix: 'b'.repeat(100) + '\n' + 'c'.repeat(8091), bytes: 60101 },
    { name: 'completed line exactly at the cap', suffix: 'b'.repeat(5535) + '\n' + 'c'.repeat(2656), bytes: 65536 },
    { name: 'completed line above the cap', suffix: 'b'.repeat(5536) + '\n' + 'c'.repeat(2655), bytes: null },
    { name: 'remaining fragment above the cap', suffix: 'b'.repeat(8192), bytes: null },
  ])('checks each line and remaining fragment separately: $name', async ({ suffix, bytes }) => {
    const work = await mkdtemp(join(tmpdir(), 'b15-reader-boundary-')), file = join(work, 'access.jsonl');
    try {
      await writeFile(file, 'a'.repeat(60000));
      // Run the exact reader with a deterministic clock and append at its first idle poll.
      const harness = String.raw`
import sys, time
program, suffix = sys.argv[1:3]
del sys.argv[1:3]
clock = iter([0, 0, 0, 61])
time.monotonic = lambda: next(clock)
def append(_):
    with open(sys.argv[1], 'ab') as f: f.write(suffix.encode())
time.sleep = append
exec(program)
`;
      const read = () => execFileSync('python3', ['-c', harness, runtimeLogProgram, suffix, file, '1'], { stdio: ['pipe', 'pipe', 'pipe'] });
      if (bytes === null) expect(read).toThrow();
      else expect(read().toString()).toBe('a'.repeat(60000) + suffix.slice(0, bytes - 60000));
    } finally { await rm(work, { recursive: true, force: true }); }
  });
  it('tails recent complete lines, redacts split UTF-8 output before delivery, follows rotation and kills on abort', async () => {
    const work = await mkdtemp(join(tmpdir(), 'b15-reader-')), key = randomBytes(32);
    const controller = new AbortController(), lines: string[] = [];
    const file = join(work, 'access.jsonl'), keyFile = join(work, 'private');
    let privateDir = '';
    try {
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyFile]);
      const privateKey = await readFile(keyFile, 'utf8');
      const target: DeployTargetRow = { id, projectId: id, kind: 'ssh', name: 'test', host: 'host.example', port: 22, username: 'deploy',
        hostKey: 'ssh-ed25519 AAAA', basePath: '/srv/site', retention: 5, disabledAt: null, currentReleaseId: id,
        encryptedPrivateKey: encryptDeployKey(privateKey, key, id, id), createdBy: id, createdAt: new Date(), updatedAt: new Date() };
      await writeFile(file, 'older\nrecent 中文 fixture-private-secret\n');
      vi.spyOn(command, 'streamingCommand').mockImplementation(async (program, args, signal, budget, consume) => {
        expect(program).toBe('ssh'); expect(args).toContain('StrictHostKeyChecking=yes'); expect(args).toContain('IdentityAgent=none');
        expect(args.at(-1)).not.toContain('fixture-private-secret'); expect(args.at(-1)).not.toContain('$(id)');
        privateDir = dirname(args[args.indexOf('-i') + 1]!);
        expect((await stat(privateDir)).mode & 0o777).toBe(0o700);
        expect((await stat(join(privateDir, 'identity'))).mode & 0o777).toBe(0o600);
        // Execute the exact fixed shell program; substitute only the fixture path for sandbox portability.
        const remote = args.at(-1)!.replace(runtimeLogPath('/srv/site', id, 'caddy-access'), file);
        await actual('sh', ['-c', remote], signal, budget, consume);
      });
      const task = new SshRuntimeLogHost(key).read(target, RuntimeLogInputSchema.parse({ domainId: id, source: 'caddy-access', lines: 1, keyword: '$(id)' }), ['fixture-private-secret'], async line => { lines.push(line); }, controller.signal);
      const waitFor = async (test: () => boolean) => { for (let i = 0; i < 80; i++) { if (test()) return; await delay(25); } throw new Error('reader_did_not_deliver'); };
      await waitFor(() => lines.length >= 1);
      expect(lines.join('')).toBe('recent 中文 [REDACTED]\n');
      await appendFile(file, 'follow fixture-private-'); await delay(300);
      expect(lines.length).toBe(1);
      await appendFile(file, 'secret\n'); await waitFor(() => lines.length >= 2);
      await rename(file, file + '.old'); await writeFile(file, 'rotated\n');
      await waitFor(() => lines.includes('rotated\n'));
      controller.abort(); await expect(task).rejects.toThrow();
      expect(lines.join('')).not.toContain('fixture-private-secret'); expect(lines.join('')).not.toContain('older');
      await expect(stat(privateDir)).rejects.toThrow();
    } finally { controller.abort(); key.fill(0); await rm(work, { recursive: true, force: true }); }
  }, 10000);
  it('refuses symlinked paths and caps raw bytes even if filtered output would be empty', async () => {
    const work = await mkdtemp(join(tmpdir(), 'b15-reader-'));
    try {
      const source = join(work, 'source'), link = join(work, 'link'); await mkdir(source);
      await writeFile(join(source, 'access'), 'private\n'); await symlink(source, link);
      const consume = async (stream: AsyncIterable<Uint8Array>) => { for await (const _chunk of stream) { /* discard */ } };
      await expect(actual('python3', ['-u', '-c', runtimeLogProgram, join(link, 'access'), '1'], AbortSignal.timeout(2000), 1024, consume)).rejects.toThrow('ssh_command_failed');
      await expect(actual('python3', ['-c', 'import sys; sys.stdout.write("x" * 100000)'], AbortSignal.timeout(2000), 1024, consume)).rejects.toThrow('ssh_output_limit');
    } finally { await rm(work, { recursive: true, force: true }); }
  });
});
