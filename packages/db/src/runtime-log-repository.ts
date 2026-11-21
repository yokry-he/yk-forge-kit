import { createHash, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, inArray, isNull, lt, or } from 'drizzle-orm';
import { RUNTIME_LOG_LIMITS as limits, RuntimeLogInputSchema, RuntimeLogEventSchema, type RuntimeLogInput } from '@forgekit/contracts';
import type { DatabaseClient } from './index';
import { domains, deployTargets, invitationRateBuckets, runtimeLogSessions, runtimeLogChunks } from './schema';
import { DeployConflictError, DeployNotFoundError } from './deploy-repository';
export type RuntimeLogRow = typeof runtimeLogSessions.$inferSelect;
const active = inArray(runtimeLogSessions.status, ['pending', 'running']);
export class RuntimeLogLimitError extends Error { constructor() { super('runtime_session_limit'); } }
export class RuntimeLogRepository {
  constructor(private readonly db: DatabaseClient['db']) {}
  async create(projectId: string, actorUserId: string, input: RuntimeLogInput) {
    input = RuntimeLogInputSchema.parse(input);
    return this.db.transaction(async tx => {
      // One tiny cross-replica admission mutex: enforce project/user/SSH-endpoint/global quotas atomically.
      await tx.insert(invitationRateBuckets).values({ key: 'runtime-session-admission', attempts: 1 })
        .onDuplicateKeyUpdate({ set: { attempts: 1 } });
      const [domain] = await tx.select().from(domains).where(and(eq(domains.id, input.domainId), eq(domains.projectId, projectId)));
      if (!domain) throw new DeployNotFoundError();
      const [target] = await tx.select().from(deployTargets).where(and(eq(deployTargets.id, domain.deployTargetId), eq(deployTargets.projectId, projectId))).for('update');
      const [lockedDomain] = await tx.select().from(domains).where(eq(domains.id, domain.id)).for('update');
      if (!target || target.disabledAt || !target.encryptedPrivateKey || !target.currentReleaseId || !target.host || !target.port || !lockedDomain || !lockedDomain.claimedHostname || !lockedDomain.verifiedAt || lockedDomain.status === 'revoked' || lockedDomain.status === 'pending_dns') throw new DeployConflictError();
      const hostHash = createHash('sha256').update(JSON.stringify([target.host.toLowerCase(), target.port])).digest('hex');
      const now = new Date();
      const rows = await tx.select({ projectId: runtimeLogSessions.projectId, actorUserId: runtimeLogSessions.actorUserId, hostHash: runtimeLogSessions.hostHash })
        .from(runtimeLogSessions).where(and(active, gt(runtimeLogSessions.expiresAt, now), gt(runtimeLogSessions.leaseUntil, now)));
      if (rows.length >= limits.global || rows.filter(r => r.projectId === projectId).length >= limits.project ||
        rows.filter(r => r.actorUserId === actorUserId).length >= limits.user || rows.filter(r => r.hostHash === hostHash).length >= limits.host) throw new RuntimeLogLimitError();
      const row: RuntimeLogRow = { id: randomUUID(), projectId, actorUserId, domainId: domain.id, deployTargetId: target.id,
        hostHash, input: { ...input, domainId: domain.id }, status: 'pending', errorCode: null, bytes: 0, lastSeq: 0, leaseOwner: null,
        leaseUntil: new Date(now.getTime() + limits.initialLeaseMs), createdAt: now, expiresAt: new Date(now.getTime() + limits.durationMs) };
      await tx.insert(runtimeLogSessions).values(row); return row;
    }, { isolationLevel: 'read committed' });
  }
  async get(id: string) { const [row] = await this.db.select().from(runtimeLogSessions).where(eq(runtimeLogSessions.id, id)); return row ?? null; }
  async start(id: string) {
    const now = new Date();
    const result = await this.db.update(runtimeLogSessions).set({ status: 'running' }).where(and(eq(runtimeLogSessions.id, id), eq(runtimeLogSessions.status, 'pending'), gt(runtimeLogSessions.expiresAt, now), gt(runtimeLogSessions.leaseUntil, now)));
    return result[0].affectedRows === 1;
  }
  async attach(id: string, owner: string) {
    const now = new Date();
    const result = await this.db.update(runtimeLogSessions).set({ leaseOwner: owner, leaseUntil: new Date(now.getTime() + limits.leaseMs) })
      .where(and(eq(runtimeLogSessions.id, id), or(isNull(runtimeLogSessions.leaseOwner), lt(runtimeLogSessions.leaseUntil, now)),
        // Terminal sessions remain attachable for replay; active leases cannot be revived after quota admission expires.
        or(inArray(runtimeLogSessions.status, ['ended', 'canceled', 'failed']), and(gt(runtimeLogSessions.expiresAt, now), gt(runtimeLogSessions.leaseUntil, now)))));
    return result[0].affectedRows === 1;
  }
  async touch(id: string, owner: string) {
    const now = new Date();
    await this.db.update(runtimeLogSessions).set({ leaseUntil: new Date(now.getTime() + limits.leaseMs) })
      .where(and(eq(runtimeLogSessions.id, id), eq(runtimeLogSessions.leaseOwner, owner),
        or(inArray(runtimeLogSessions.status, ['ended', 'canceled', 'failed']), and(gt(runtimeLogSessions.expiresAt, now), gt(runtimeLogSessions.leaseUntil, now)))));
  }
  async detach(id: string, owner: string) {
    await this.db.update(runtimeLogSessions).set({ leaseOwner: null, leaseUntil: new Date(), status: 'canceled' })
      .where(and(eq(runtimeLogSessions.id, id), eq(runtimeLogSessions.leaseOwner, owner), active));
    await this.db.update(runtimeLogSessions).set({ leaseOwner: null }).where(and(eq(runtimeLogSessions.id, id), eq(runtimeLogSessions.leaseOwner, owner)));
  }
  async finish(id: string, status: 'ended' | 'canceled' | 'failed', errorCode: string | null = null) {
    await this.db.update(runtimeLogSessions).set({ status, errorCode }).where(and(eq(runtimeLogSessions.id, id), active));
  }
  async append(id: string, content: string) {
    RuntimeLogEventSchema.parse({ sessionId: id, seq: 1, content, stream: 'stdout', ts: new Date().toISOString() });
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(runtimeLogSessions).where(eq(runtimeLogSessions.id, id)).for('update');
      if (!row || row.status !== 'running' || row.expiresAt.getTime() <= Date.now() || row.leaseUntil.getTime() <= Date.now()) return;
      const bytes = row.bytes + Buffer.byteLength(content);
      if (bytes > limits.bytes || row.lastSeq >= 10000) throw new RuntimeLogLimitError();
      await tx.insert(runtimeLogChunks).values({ sessionId: id, seq: row.lastSeq + 1, stream: 'stdout', content, ts: new Date() });
      await tx.update(runtimeLogSessions).set({ bytes, lastSeq: row.lastSeq + 1 }).where(eq(runtimeLogSessions.id, id));
    }, { isolationLevel: 'read committed' });
  }
  async highestSeq(id: string) { return (await this.get(id))?.lastSeq ?? 0; }
  listSince(id: string, seq = 0, limit = 500) {
    if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('invalid_runtime_cursor');
    return this.db.select().from(runtimeLogChunks).where(and(eq(runtimeLogChunks.sessionId, id), gt(runtimeLogChunks.seq, seq))).orderBy(asc(runtimeLogChunks.seq)).limit(limit);
  }
  async reconcile() {
    const now = new Date();
    await this.db.update(runtimeLogSessions).set({ status: 'ended', errorCode: 'runtime_session_expired' })
      .where(and(active, or(lt(runtimeLogSessions.expiresAt, now), lt(runtimeLogSessions.leaseUntil, now))));
    await this.db.delete(runtimeLogSessions).where(lt(runtimeLogSessions.expiresAt, new Date(now.getTime() - limits.retentionMs)));
    return this.db.select().from(runtimeLogSessions).where(and(eq(runtimeLogSessions.status, 'pending'), gt(runtimeLogSessions.expiresAt, now))).limit(100);
  }
}
