import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt, ne, or, isNull, isNotNull, sql } from 'drizzle-orm';
import { DomainNameSchema, type DomainOperation, type DomainTlsMode } from '@forgekit/contracts';
import type { DatabaseClient } from './index';
import { domains, domainOperations, deployments, deployTargets, deployAudit, projects } from './schema';
import { DeployConflictError, DeployNotFoundError } from './deploy-repository';
export type DomainRow = typeof domains.$inferSelect;
export type DomainOperationRow = typeof domainOperations.$inferSelect;
type Database = DatabaseClient['db'];
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export class DomainClaimError extends Error { constructor() { super('domain_already_claimed'); } }
const busy = ['pending', 'running'] as const;
async function lockTarget(tx: Transaction, projectId: string, targetId: string) {
  const [target] = await tx.select().from(deployTargets).where(and(eq(deployTargets.projectId, projectId), eq(deployTargets.id, targetId))).for('update');
  if (!target || target.disabledAt || !target.encryptedPrivateKey || !target.currentReleaseId) throw new DeployConflictError();
  const active = await tx.select({ id: domainOperations.id }).from(domainOperations).where(and(eq(domainOperations.deployTargetId, targetId), inArray(domainOperations.status, [...busy]))).limit(1);
  const deploy = await tx.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.deployTargetId, targetId), inArray(deployments.status, [...busy]))).limit(1);
  if (active.length || deploy.length) throw new DeployConflictError();
  return target;
}
export class DomainRepository {
  constructor(private readonly db: Database) {}
  async get(id: string) { const [row] = await this.db.select().from(domains).where(eq(domains.id, id)).limit(1); return row ?? null; }
  list(projectId: string) { return this.db.select().from(domains).where(eq(domains.projectId, projectId)).orderBy(asc(sql`${domains.status} = 'revoked'`), desc(domains.createdAt)).limit(100); }
  async create(projectId: string, targetId: string, hostname: string, actor: string, tlsMode: DomainTlsMode) {
    hostname = DomainNameSchema.parse(hostname);
    return this.db.transaction(async tx => {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update');
      await lockTarget(tx, projectId, targetId);
      const all = await tx.select().from(domains).where(and(eq(domains.projectId, projectId), ne(domains.status, 'revoked')));
      if (all.length >= 100 || all.some(row => row.hostname === hostname && row.deployTargetId === targetId)) throw new DeployConflictError();
      const now = new Date();
      const row: DomainRow = { id: randomUUID(), projectId, deployTargetId: targetId, hostname, claimedHostname: null,
        verificationToken: randomBytes(32).toString('hex'), status: 'pending_dns', tlsMode, certificateExpiresAt: null,
        certificateFingerprint: null, verifiedAt: null, lastCheckedAt: null, errorCode: null, createdAt: now, updatedAt: now };
      await tx.insert(domains).values(row);
      await tx.insert(deployAudit).values({ projectId, targetId, actorUserId: actor, action: 'domain_created' });
      return row;
    }, { isolationLevel: 'read committed' });
  }
  async request(projectId: string, domainId: string, action: DomainOperation['action'], actor: string) {
    const current = await this.get(domainId);
    if (!current || current.projectId !== projectId) throw new DeployNotFoundError();
    return this.db.transaction(async tx => {
      await lockTarget(tx, projectId, current.deployTargetId);
      const [domain] = await tx.select().from(domains).where(eq(domains.id, domainId)).for('update');
      if (!domain || domain.status === 'revoked' || (action === 'refresh' && !domain.verifiedAt)) throw new DeployConflictError();
      const now = new Date();
      const row: DomainOperationRow = { id: randomUUID(), domainId, projectId, deployTargetId: domain.deployTargetId,
        action, actorUserId: actor, status: 'pending', errorCode: null, finishedAt: null, createdAt: now, updatedAt: now };
      await tx.insert(domainOperations).values(row);
      await tx.insert(deployAudit).values({ projectId, targetId: domain.deployTargetId, actorUserId: actor, action: 'domain_' + action });
      return row;
    }, { isolationLevel: 'read committed' });
  }
  async operation(id: string) { const [row] = await this.db.select().from(domainOperations).where(eq(domainOperations.id, id)).limit(1); return row ?? null; }
  operations(projectId: string) { return this.db.select().from(domainOperations).where(eq(domainOperations.projectId, projectId)).orderBy(desc(domainOperations.createdAt), desc(domainOperations.id)).limit(100); }
  async start(id: string) {
    const result = await this.db.update(domainOperations).set({ status: 'running', updatedAt: new Date() }).where(and(eq(domainOperations.id, id), eq(domainOperations.status, 'pending')));
    return result[0].affectedRows === 1;
  }
  /** The unique claim resolves races across projects; pending records never reserve hostnames. */
  async claim(domain: DomainRow) {
    try {
      await this.db.update(domains).set({ claimedHostname: domain.hostname, verifiedAt: new Date(), status: 'issuing', errorCode: null }).where(eq(domains.id, domain.id));
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY' || (cause as { code?: string } | undefined)?.code === 'ER_DUP_ENTRY') throw new DomainClaimError();
      throw error;
    }
  }
  async update(id: string, values: Partial<Pick<DomainRow, 'status' | 'certificateExpiresAt' | 'certificateFingerprint' | 'lastCheckedAt' | 'errorCode'>>) {
    await this.db.update(domains).set({ ...values, updatedAt: new Date() }).where(eq(domains.id, id));
  }
  async finish(id: string, status: 'succeeded' | 'failed', values: Partial<Pick<DomainRow, 'status' | 'certificateExpiresAt' | 'certificateFingerprint' | 'lastCheckedAt' | 'errorCode'>>, errorCode: string | null = null, from: 'pending' | 'running' = 'running') {
    await this.db.transaction(async tx => {
      const [op] = await tx.select().from(domainOperations).where(eq(domainOperations.id, id)).for('update');
      if (!op || op.status !== from) return;
      await tx.update(domains).set({ ...values, ...(values.status === 'revoked' ? { claimedHostname: null } : {}), updatedAt: new Date() }).where(eq(domains.id, op.domainId));
      await tx.update(domainOperations).set({ status, errorCode, finishedAt: new Date(), updatedAt: new Date() }).where(eq(domainOperations.id, id));
    });
  }
  stale(status: 'pending' | 'running', before: Date) { return this.db.select().from(domainOperations).where(and(eq(domainOperations.status, status), lt(domainOperations.updatedAt, before))).orderBy(asc(domainOperations.updatedAt)).limit(100); }
  due(before: Date) {
    // Historical certificates keep previously observed bindings eligible after failure.
    // updatedAt also bounds retries when reconciliation/enqueue failed without a check.
    return this.db.select().from(domains).where(and(
      or(inArray(domains.status, ['active', 'expired']), and(eq(domains.status, 'failed'),
        isNotNull(domains.verifiedAt), isNotNull(domains.claimedHostname), isNotNull(domains.certificateExpiresAt), lt(domains.updatedAt, before))),
      or(isNull(domains.lastCheckedAt), lt(domains.lastCheckedAt, before)),
    )).orderBy(asc(domains.lastCheckedAt)).limit(100);
  }
}
