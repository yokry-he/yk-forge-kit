import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readlink, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { releaseScript } from '../src/ssh-release';
import { serializeDotEnv } from '../src/ssh-deployer';
import { CappedBuildLogs, redactBuildLog } from '../src/build-logs';

describe('B14 private release environment', () => {
  it('installs .env 0600 outside the public release, atomically, and keeps rollback configuration', async () => {
    const work = await mkdtemp(join(tmpdir(), 'b14-release-')), id = randomUUID(), second = randomUUID();
    const secret = 'b14-host-secret', config = serializeDotEnv({ TOKEN: secret, SPECIAL: 'quote\'"$value\nnext-line\\end' });
    try {
      const source = join(work, 'source'), root = join(work, 'remote'); await mkdir(source);
      await writeFile(join(source, 'index.html'), 'release');
      await writeFile(join(source, '.forgekit-env'), config, { mode: 0o600 });
      const archive = join(work, 'site.tar'); execFileSync('tar', ['-cf', archive, '-C', source, '.']);
      const run = (release: string, rollback = false, prune: string[] = []) => execFileSync('sh', ['-c', releaseScript(root, randomUUID(), release, rollback, prune, true)],
        { input: rollback ? undefined : execFileSync('cat', [archive]), encoding: 'utf8' });
      const output = run(id); expect(output).toContain('B12_DONE'); expect(output).not.toContain(secret);
      const envPath = join(root, 'environments', id, '.env');
      expect(await readFile(envPath, 'utf8')).toBe(config);
      expect(execFileSync('sh', ['-c', '. "$1"; printf "%s" "$SPECIAL"', 'sh', envPath], { encoding: 'utf8' })).toBe('quote\'"$value\nnext-line\\end');
      expect((await stat(envPath)).mode & 0o777).toBe(0o600);
      expect((await stat(join(root, 'environments', id))).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, 'environments'))).mode & 0o777).toBe(0o700);
      expect(await readdir(join(root, 'current'))).not.toContain('.forgekit-env');
      expect(run(id)).toContain('B12_DONE'); // Idempotent delivery.
      await writeFile(join(source, '.forgekit-env'), serializeDotEnv({ TOKEN: 'replaced-host-secret' }), { mode: 0o600 });
      execFileSync('tar', ['-cf', archive, '-C', source, '.']); run(second);
      run(id, true); expect(await readFile(envPath, 'utf8')).toBe(config);
      const third = randomUUID(); run(third, false, [second]);
      await expect(stat(join(root, 'environments', second))).rejects.toThrow();
      expect(await readdir(join(root, 'environments'))).not.toContain('.staging-' + id);
    } finally { await rm(work, { recursive: true, force: true }); }
  });
  it('cleans failed uploads and never switches current to an incomplete release', async () => {
    const work = await mkdtemp(join(tmpdir(), 'b14-release-fail-')), id = randomUUID();
    try {
      const source = join(work, 'source'), root = join(work, 'remote'); await mkdir(source);
      await writeFile(join(source, '.forgekit-env'), 'TOKEN=private-secret', { mode: 0o600 });
      const input = execFileSync('tar', ['-cf', '-', '-C', source, '.']);
      expect(() => execFileSync('sh', ['-c', releaseScript(root, randomUUID(), id, false, [], true)], { input, stdio: ['pipe', 'pipe', 'pipe'] })).toThrow();
      expect(await readdir(join(root, 'releases'))).toEqual([]);
      await expect(stat(join(root, 'current'))).rejects.toThrow();
      await expect(stat(join(root, 'environments', id))).rejects.toThrow();
    } finally { await rm(work, { recursive: true, force: true }); }
  });
  it('removes prepared private configuration when the final release switch fails', async () => {
    const work = await mkdtemp(join(tmpdir(), 'b14-switch-fail-')), previous = randomUUID(), failed = randomUUID(), operation = randomUUID();
    try {
      const source = join(work, 'source'), root = join(work, 'remote'); await mkdir(source);
      await writeFile(join(source, 'index.html'), 'complete');
      await writeFile(join(source, '.forgekit-env'), "TOKEN='b14-switch-secret'\n", { mode: 0o600 });
      const input = execFileSync('tar', ['-cf', '-', '-C', source, '.']);
      execFileSync('sh', ['-c', releaseScript(root, randomUUID(), previous, false, [], true)], { input });
      // Force a failure after private .env and release directory preparation.
      await writeFile(join(root, '.current-' + operation), 'blocked');
      expect(() => execFileSync('sh', ['-c', releaseScript(root, operation, failed, false, [], true)], { input, stdio: ['pipe', 'pipe', 'pipe'] })).toThrow();
      expect(await readlink(join(root, 'current'))).toBe('releases/' + previous);
      await expect(stat(join(root, 'environments', failed))).rejects.toThrow();
      await expect(stat(join(root, 'releases', failed))).rejects.toThrow();
      expect((await stat(join(root, 'environments', previous, '.env'))).mode & 0o777).toBe(0o600);
    } finally { await rm(work, { recursive: true, force: true }); }
  });
  it('redacts CRLF, multiline fragments and escaped single-line forms before chunking', async () => {
    const value = 'first-secret-line\r\nsecond-secret-line', persisted: string[] = [];
    const logs = new CappedBuildLogs({ write: async (_stream, text) => { persisted.push(text); } }, 10000, text => redactBuildLog(text, [value]));
    async function* chunks() { yield Buffer.from(value.slice(0, 5)); yield Buffer.from(value.slice(5) + '\n' + JSON.stringify(value) + '\n'); }
    await logs.consume('stdout', chunks()); await logs.consume('stderr', chunks());
    expect(persisted.join('')).not.toContain('first-secret-line'); expect(persisted.join('')).not.toContain('second-secret-line');
    expect(persisted.join('')).toContain('[REDACTED]');
    expect(redactBuildLog('an ordinary log', ['', 'a', 'or'])).toBe('an ordinary log');
  });
});
