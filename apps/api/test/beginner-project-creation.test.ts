import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { projects, projectMemberships } from '@forgekit/db';
import { ProjectsController } from '../src/projects.controller';
import { ProjectsService } from '../src/projects.service';
import type { DatabaseService } from '../src/database.service';
import type { IdentityAccountsService } from '../src/identity-accounts.service';

describe('B21 reuses project creation', () => {
  it('persists confirmed platforms and creates the normal owner membership in one transaction', async () => {
    const writes: Array<{ table: unknown; row: unknown }> = [];
    const tx = { insert: (table: unknown) => ({ values: async (row: unknown) => { writes.push({ table, row }); } }) };
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn(tx));
    const identities = { ensureUser: vi.fn().mockResolvedValue('actor-uuid') };
    const service = new ProjectsService({ db: { transaction } } as unknown as DatabaseService, identities as unknown as IdentityAccountsService);
    const find = vi.spyOn(service, 'findBySlug').mockResolvedValue({ slug: 'my-miniapp' } as never);
    const auth = { mode: 'oidc' as const, issuer: 'https://issuer.test', subject: 'subject' };
    const result = await new ProjectsController(service).create({ name: 'my-miniapp', template: 'uniapp', features: [], platforms: ['weapp', 'alipay'] }, { headers: {}, projectAuth: auth });
    expect(identities.ensureUser).toHaveBeenCalledWith(auth);
    expect(writes).toEqual([
      { table: projects, row: expect.objectContaining({ name: 'my-miniapp', template: 'uniapp', features: [], platforms: ['weapp', 'alipay'] }) },
      { table: projectMemberships, row: expect.objectContaining({ userId: 'actor-uuid', role: 'owner' }) },
    ]);
    expect(transaction).toHaveBeenCalledOnce(); expect(find).toHaveBeenCalledWith('my-miniapp', auth);
    expect(result).toEqual({ slug: 'my-miniapp' });
  });
});
