import { describe, expect, it } from 'vitest';
import { DeployTargetUpdateSchema, SshHostSchema, SshUserSchema, DeployBasePathSchema } from '../src/deploys';
describe('B12 target validation', () => {
  it('rejects option/shell/pattern/metadata targets and root accounts', () => {
    for (const host of ['-oProxyCommand=echo', 'host;id', 'a b', '*.example', 'https://host', '169.254.169.254', 'a\nb', 'a..b', '0.0.0.0']) expect(SshHostSchema.safeParse(host).success, host).toBe(false);
    for (const user of ['root', '-o', 'deploy;id', 'user@host']) expect(SshUserSchema.safeParse(user).success).toBe(false);
    for (const path of ['/', '/etc', '/srv/a/../b', '/srv/a;id', '/srv/a\nb']) expect(DeployBasePathSchema.safeParse(path).success).toBe(false);
    expect(SshHostSchema.parse('ecs.example.cn')).toBe('ecs.example.cn');
  });
  it('does not require a replacement key on edit; enforces pinning and retention bounds', () => {
    const target = { name: '站点', host: '127.0.0.1', username: 'deploy', hostKey: 'ssh-ed25519 AAAA', basePath: '/srv/site' };
    expect(DeployTargetUpdateSchema.parse(target)).toMatchObject({ port: 22, retention: 5 });
    for (const extra of [{ port: 0 }, { port: 65536 }, { retention: 0 }, { retention: 51 }, { hostKey: '' }, { privateKey: '' }, { passphrase: 'do-not-store' }]) {
      expect(DeployTargetUpdateSchema.safeParse({ ...target, ...extra }).success).toBe(false);
    }
  });
});
