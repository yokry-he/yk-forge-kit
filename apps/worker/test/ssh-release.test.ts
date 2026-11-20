import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { releaseRoot, releaseScript, retentionPlan } from '../src/ssh-release';
import { boundedCommand, SshDeployError, sshArguments, sshFailure } from '../src/ssh-command';
import { deployErrorCode } from '../src/deploy-processor';

describe('SSH security and diagnostics', () => {
  it('enforces pinned host keys, no ambient config, agent, password or forwarding', () => {
    const args = sshArguments({ host: 'example.com', port: 22, username: 'deploy', hostKey: 'ssh-ed25519 AAAA' }, '/tmp/key', '/tmp/hosts', 'true');
    for (const option of ['StrictHostKeyChecking=yes', 'IdentityAgent=none', 'IdentitiesOnly=yes', 'BatchMode=yes', 'PasswordAuthentication=no', 'GlobalKnownHostsFile=/dev/null', 'UpdateHostKeys=no', 'ClearAllForwardings=yes']) expect(args).toContain(option);
    expect(args.slice(0, 2)).toEqual(['-F', '/dev/null']);
    expect(sshFailure('WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!')).toBe('ssh_host_key_mismatch');
    expect(sshFailure('Host key verification failed.')).toBe('ssh_host_key_mismatch');
    expect(sshFailure('Permission denied (publickey)')).toBe('ssh_auth_failed');
  });
  it('never promotes arbitrary exceptions or remote stderr into persisted logs', async () => {
    for (const secret of ['-----BEGIN OPENSSH PRIVATE KEY----- secret', 'passphrase=secret', 'decrypted material']) {
      expect(deployErrorCode(new Error(secret))).toBe('deploy_execution_failed');
      expect(deployErrorCode(new SshDeployError(secret))).toBe('deploy_execution_failed');
      expect(sshFailure(secret)).toBe('ssh_command_failed');
    }
    const controller = new AbortController();
    const running = boundedCommand('sh', ['-c', 'exec sleep 10'], controller.signal);
    controller.abort(); await expect(running).rejects.toThrow('deploy_timeout_or_shutdown');
  });
});
describe('real Linux release scripts without Docker', () => {
  it('atomically switches complete sites, retries safely, rolls back, prunes, and cleans failed uploads', async () => {
    const work = await mkdtemp(join(tmpdir(), 'b12-release-'));
    const root = join(work, 'remote'), source = join(work, 'source'), archive = join(work, 'site.tar');
    const releases = [randomUUID(), randomUUID(), randomUUID()];
    const signal = new AbortController().signal;
    try {
      await mkdir(source); await writeFile(join(source, 'index.html'), 'release one');
      execFileSync('tar', ['-cf', archive, '-C', source, '.']);
      const deploy = (id: string, prune: string[] = [], input = archive) => boundedCommand('sh', ['-c', releaseScript(root, id, id, false, prune)], signal, input);
      await deploy(releases[0]!);
      expect(await readlink(join(root, 'current'))).toBe('releases/' + releases[0]);
      expect(await readFile(join(root, 'current/index.html'), 'utf8')).toBe('release one');
      await deploy(releases[0]!); // An acknowledged/ambiguous retry never overwrites the completed release.
      await writeFile(join(source, 'index.html'), 'release two'); execFileSync('tar', ['-cf', archive, '-C', source, '.']);
      await deploy(releases[1]!);
      await boundedCommand('sh', ['-c', releaseScript(root, randomUUID(), releases[0]!, true, [])], signal);
      expect(await readFile(join(root, 'current/index.html'), 'utf8')).toBe('release one');
      // Reasserting the current retained version is a safe no-op on the remote host.
      await boundedCommand('sh', ['-c', releaseScript(root, randomUUID(), releases[0]!, true, [])], signal);
      expect(await readFile(join(root, 'current/index.html'), 'utf8')).toBe('release one');
      const plan = retentionPlan(releases[2]!, [releases[1]!, releases[0]!], 2);
      expect(plan.prune).toEqual([releases[0]]); await deploy(releases[2]!, plan.prune);
      expect((await readdir(join(root, 'releases'))).sort()).toEqual(plan.keep.sort());
      const failed = randomUUID(), invalid = join(work, 'invalid.tar'); await writeFile(invalid, 'truncated archive');
      await expect(deploy(failed, [], invalid)).rejects.toThrow();
      expect(await readlink(join(root, 'current'))).toBe('releases/' + releases[2]);
      expect(await readdir(join(root, 'releases'))).not.toContain('.staging-' + failed);
      expect(await readdir(join(root, 'releases'))).not.toContain(failed);
      await expect(boundedCommand('sh', ['-c', releaseScript(root, randomUUID(), releases[0]!, true, [])], signal)).rejects.toThrow();
      expect(await readlink(join(root, 'current'))).toBe('releases/' + releases[2]);
      expect(() => releaseRoot('/srv/a;id', randomUUID(), randomUUID())).toThrow();
    } finally { await rm(work, { recursive: true, force: true }); }
  });
});
