import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalFsArtifactStore } from '@forgekit/artifact-store';
import { encryptDeployKey, type DeploymentRow, type DeployTargetRow } from '@forgekit/db';
import { SshStaticDeployer } from '../src/ssh-deployer';
import * as command from '../src/ssh-command';
const actual = command.boundedCommand;
afterEach(() => vi.restoreAllMocks());
describe('static SSH adapter preparation', () => {
  it.each([0o022, 0o077])('normalizes site permissions under umask %i, isolates credentials, and cleans up on failure', async (umask) => {
    const work = await mkdtemp(join(tmpdir(), 'b12-adapter-test-')), id = randomUUID(), key = randomBytes(32);
    const previousUmask = process.umask(umask);
    const signal = new AbortController().signal;
    let privateDirectory = '';
    try {
      const keyPath = join(work, 'key'); execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath]);
      const text = await readFile(keyPath, 'utf8');
      const source = join(work, 'source'); await mkdir(source); await writeFile(join(source, 'index.html'), '<html>valid</html>');
      await mkdir(join(source, 'assets/nested'), { recursive: true });
      await writeFile(join(source, 'assets/nested/app.js'), 'window.fixture=true');
      const store = new LocalFsArtifactStore(join(work, 'artifacts')), artifact = await store.put(id, source, signal);
      const now = new Date();
      const target: DeployTargetRow = { id, projectId: id, kind: 'ssh', name: 'test', host: 'example.com', port: 22, username: 'deploy',
        hostKey: 'ssh-ed25519 AAAA', basePath: '/srv/site', retention: 5, disabledAt: null, currentReleaseId: null,
        encryptedPrivateKey: encryptDeployKey(text, key, id, id), createdBy: id, createdAt: now, updatedAt: now };
      const job: DeploymentRow = { id, projectId: id, buildId: id, environmentId: id, deployTargetId: id, status: 'running', action: 'deploy',
        releaseId: id, rollbackOf: null, triggeredBy: id, retained: false, errorMessage: null, startedAt: now, finishedAt: null, createdAt: now, updatedAt: now };
      const log = vi.fn().mockResolvedValue(undefined);
      const ssh = vi.spyOn(command, 'boundedCommand').mockImplementation(async (program, args, abort, input) => {
        if (program !== 'ssh') return actual(program, args, abort, input);
        const identity = args[args.indexOf('-i') + 1]!; privateDirectory = dirname(identity);
        expect((await stat(privateDirectory)).mode & 0o777).toBe(0o700);
        expect((await stat(identity)).mode & 0o777).toBe(0o600);
        expect((await stat(join(privateDirectory, 'known_hosts'))).mode & 0o777).toBe(0o600);
        expect(await readFile(identity, 'utf8')).toBe(text);
        const archived = execFileSync('tar', ['-tf', input!], { encoding: 'utf8' });
        expect(archived).toContain('./index.html'); expect(archived).not.toContain('identity'); expect(archived).not.toContain('known_hosts');
        const extracted = join(work, 'extracted'); await mkdir(extracted);
        // Match remote extraction under its explicit umask 022.
        execFileSync('sh', ['-c', 'umask 022; exec tar -xf "$1" -C "$2" --no-same-owner --no-same-permissions', 'sh', input!, extracted]);
        for (const path of ['', 'assets', 'assets/nested']) expect((await stat(join(extracted, path))).mode & 0o777).toBe(0o755);
        for (const path of ['index.html', 'assets/nested/app.js']) expect((await stat(join(extracted, path))).mode & 0o777).toBe(0o644);
        throw new command.SshDeployError('ssh_host_key_mismatch');
      });
      const deployer = new SshStaticDeployer(store, key);
      await expect(deployer.run(job, target, artifact, [], log, signal)).rejects.toThrow('ssh_host_key_mismatch');
      expect(privateDirectory).not.toBe(''); await expect(stat(privateDirectory)).rejects.toThrow();
      expect(JSON.stringify(log.mock.calls)).not.toContain(text);
      ssh.mockClear();
      await expect(deployer.run(job, target, { key: artifact.key, sha256: '0'.repeat(64) }, [], log, signal)).rejects.toThrow('artifact_integrity_failed');
      expect(ssh.mock.calls.some(([program]) => program === 'ssh')).toBe(false);
    } finally { process.umask(previousUmask); await rm(work, { recursive: true, force: true }); }
  });
});
