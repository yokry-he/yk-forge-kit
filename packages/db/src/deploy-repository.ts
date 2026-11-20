import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne } from 'drizzle-orm';
import { DeployLogEventSchema, type DeployLogEvent, type DeployTargetUpdate } from '@forgekit/contracts';
import type { DatabaseClient } from './index';
import { builds, deployAudit, deployLogChunks, deployments, deployTargets, environments, projects, domains, domainOperations } from './schema';

type Database = DatabaseClient['db'];
export type DeployTargetRow = typeof deployTargets.$inferSelect;
export type DeploymentRow = typeof deployments.$inferSelect;
export class DeployConflictError extends Error { constructor() { super('部署目标忙碌、已删除、构建不可用或发布已不在保留范围。'); } }
export class DeployNotFoundError extends Error { constructor() { super('部署记录或目标不存在。'); } }
const busy = ['pending', 'running'] as const;

export class DeployRepository {
  constructor(private readonly db: Database) {}
  async target(projectId: string, id: string) {
    const [row] = await this.db.select().from(deployTargets).where(and(eq(deployTargets.projectId, projectId), eq(deployTargets.id, id))).limit(1);
    return row ?? null;
  }
  listTargets(projectId: string) {
    return this.db.select().from(deployTargets).where(and(eq(deployTargets.projectId, projectId), isNull(deployTargets.disabledAt)))
      .orderBy(desc(deployTargets.createdAt)).limit(100);
  }
  async saveTarget(projectId: string, id: string, actor: string, input: Omit<DeployTargetUpdate, 'privateKey'>,
    encryptedPrivateKey: string | undefined, create = false) {
    return this.db.transaction(async tx => {
      // Consistent project -> target lock order, also bounds target count under concurrent creation.
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update');
      const [old] = await tx.select().from(deployTargets).where(and(eq(deployTargets.id, id), eq(deployTargets.projectId, projectId))).for('update');
      if (create) {
        const all = await tx.select({ id: deployTargets.id }).from(deployTargets).where(and(eq(deployTargets.projectId, projectId), isNull(deployTargets.disabledAt)));
        if (old || !encryptedPrivateKey || all.length >= 100) throw new DeployConflictError();
        await tx.insert(deployTargets).values({ ...input, id, projectId, createdBy: actor, encryptedPrivateKey });
      } else {
        if (!old || old.disabledAt) throw new DeployNotFoundError();
        const domainBusy = await tx.select({ id: domainOperations.id }).from(domainOperations).where(and(eq(domainOperations.deployTargetId, id), inArray(domainOperations.status, [...busy]))).limit(1);
        if (domainBusy.length) throw new DeployConflictError();
        const active = await tx.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.deployTargetId, id), inArray(deployments.status, [...busy]))).limit(1);
        if (active.length) throw new DeployConflictError();
        const history = await tx.select({ id: deployments.id }).from(deployments).where(eq(deployments.deployTargetId, id)).limit(1);
        // Moving an existing target would make historical rollback refer to a different filesystem.
        if (history.length && (old.host !== input.host || old.port !== input.port || old.username !== input.username || old.basePath !== input.basePath)) throw new DeployConflictError();
        await tx.update(deployTargets).set({ ...input, ...(encryptedPrivateKey ? { encryptedPrivateKey } : {}) }).where(eq(deployTargets.id, id));
      }
      await tx.insert(deployAudit).values({ projectId, targetId: id, actorUserId: actor, action: create ? 'target_created' : 'target_updated' });
    }, { isolationLevel: 'read committed' });
  }
  async removeTarget(projectId: string, id: string, actor: string) {
    await this.db.transaction(async tx => {
      const [row] = await tx.select().from(deployTargets).where(and(eq(deployTargets.id, id), eq(deployTargets.projectId, projectId))).for('update');
      if (!row || row.disabledAt) throw new DeployNotFoundError();
      const domainBusy = await tx.select({ id: domainOperations.id }).from(domainOperations).where(and(eq(domainOperations.deployTargetId, id), inArray(domainOperations.status, [...busy]))).limit(1);
      if (domainBusy.length) throw new DeployConflictError();
      const active = await tx.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.deployTargetId, id), inArray(deployments.status, [...busy]))).limit(1);
      if (active.length) throw new DeployConflictError();
      const bound = await tx.select({ id: domains.id }).from(domains).where(and(eq(domains.deployTargetId, id), ne(domains.status, 'revoked'))).limit(1);
      if (bound.length) throw new DeployConflictError();
      await tx.update(deployTargets).set({ disabledAt: new Date(), encryptedPrivateKey: null }).where(eq(deployTargets.id, id));
      await tx.insert(deployAudit).values({ projectId, targetId: id, actorUserId: actor, action: 'target_removed' });
    });
  }
  async create(input: { projectId: string; buildId: string; deployTargetId: string; actor: string; rollbackOf?: string }) {
    return this.db.transaction(async tx => {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, input.projectId)).for('update');
      const [target] = await tx.select().from(deployTargets).where(and(eq(deployTargets.id, input.deployTargetId), eq(deployTargets.projectId, input.projectId))).for('update');
      if (!target || target.disabledAt || !target.hostKey || !target.encryptedPrivateKey || !target.basePath) throw new DeployConflictError();
      const domainBusy = await tx.select({ id: domainOperations.id }).from(domainOperations).where(and(eq(domainOperations.deployTargetId, target.id), inArray(domainOperations.status, [...busy]))).limit(1);
      if (domainBusy.length) throw new DeployConflictError();
      const active = await tx.select({ id: deployments.id }).from(deployments).where(and(eq(deployments.deployTargetId, target.id), inArray(deployments.status, [...busy]))).limit(1);
      if (active.length) throw new DeployConflictError();
      const [build] = await tx.select().from(builds).where(and(eq(builds.id, input.buildId), eq(builds.projectId, input.projectId)));
      if (!build || build.status !== 'succeeded' || !build.artifactKey || !build.artifactSha256) throw new DeployConflictError();
      let releaseId: string = randomUUID();
      if (input.rollbackOf) {
        const [previous] = await tx.select().from(deployments).where(and(eq(deployments.id, input.rollbackOf), eq(deployments.deployTargetId, target.id)));
        if (!previous || previous.action !== 'deploy' || !previous.retained || previous.status !== 'succeeded' || previous.buildId !== input.buildId || !previous.releaseId) throw new DeployConflictError();
        // SSH may have switched releases before SQL/log persistence failed. Reasserting the
        // SQL-current retained release must remain possible; the remote switch is idempotent.
        releaseId = previous.releaseId;
      }
      let [environment] = await tx.select().from(environments).where(and(eq(environments.projectId, input.projectId), eq(environments.name, 'production')));
      if (!environment) {
        const now = new Date(); environment = { id: randomUUID(), projectId: input.projectId, name: 'production', createdAt: now, updatedAt: now };
        await tx.insert(environments).values(environment);
      }
      const now = new Date();
      const row: DeploymentRow = { id: randomUUID(), projectId: input.projectId, buildId: input.buildId,
        deployTargetId: target.id, environmentId: environment.id, status: 'pending', action: input.rollbackOf ? 'rollback' : 'deploy',
        releaseId, rollbackOf: input.rollbackOf ?? null, triggeredBy: input.actor, retained: false, errorMessage: null,
        startedAt: null, finishedAt: null, createdAt: now, updatedAt: now };
      await tx.insert(deployments).values(row);
      await tx.insert(deployAudit).values({ projectId: row.projectId, targetId: target.id, deploymentId: row.id, actorUserId: input.actor, action: row.action });
      return row;
    }, { isolationLevel: 'read committed' });
  }
  async get(id: string) {
    const [row] = await this.db.select().from(deployments).where(eq(deployments.id, id)).limit(1); return row ?? null;
  }
  list(projectId: string) {
    return this.db.select().from(deployments).where(eq(deployments.projectId, projectId)).orderBy(desc(deployments.createdAt), desc(deployments.id)).limit(100);
  }
  retained(targetId: string) {
    return this.db.select().from(deployments).where(and(eq(deployments.deployTargetId, targetId), eq(deployments.action, 'deploy'), eq(deployments.retained, true)))
      .orderBy(desc(deployments.createdAt), desc(deployments.id));
  }
  stale(status: 'pending' | 'running', before: Date) {
    return this.db.select().from(deployments).where(and(eq(deployments.status, status), lt(deployments.updatedAt, before)))
      .orderBy(asc(deployments.updatedAt)).limit(100);
  }
  async transition(id: string, from: 'pending' | 'running', to: 'running' | 'failed' | 'succeeded' | 'rolled_back',
    errorMessage: string | null = null, keptReleases?: string[]) {
    if ((from === 'pending' && !['running', 'failed'].includes(to)) || (from === 'running' && to === 'running')) throw new DeployConflictError();
    const current = await this.get(id); if (!current) throw new DeployNotFoundError();
    return this.db.transaction(async tx => {
      await tx.select({ id: deployTargets.id }).from(deployTargets).where(eq(deployTargets.id, current.deployTargetId)).for('update');
      const [row] = await tx.select().from(deployments).where(eq(deployments.id, id)).for('update');
      if (!row || row.status !== from) throw new DeployConflictError();
      const now = new Date();
      const success = to === 'succeeded' || to === 'rolled_back';
      await tx.update(deployments).set({ status: to, errorMessage, updatedAt: now,
        ...(to === 'running' ? { startedAt: now } : { finishedAt: now }), retained: success && row.action === 'deploy' }).where(eq(deployments.id, id));
      if (success) {
        if (!keptReleases || !row.releaseId || !keptReleases.includes(row.releaseId)) throw new DeployConflictError();
        await tx.update(deployTargets).set({ currentReleaseId: row.releaseId }).where(eq(deployTargets.id, row.deployTargetId));
        const retained = await tx.select().from(deployments).where(and(eq(deployments.deployTargetId, row.deployTargetId), eq(deployments.retained, true)));
        for (const old of retained) if (!old.releaseId || !keptReleases.includes(old.releaseId)) {
          await tx.update(deployments).set({ retained: false }).where(eq(deployments.id, old.id));
        }
      }
    });
  }
}

export class DeployLogRepository {
  constructor(private readonly db: Database) {}
  async append(input: Omit<DeployLogEvent, 'seq' | 'ts'>) {
    const row = { ...input, ts: new Date(), seq: 1 };
    DeployLogEventSchema.parse({ ...row, ts: row.ts.toISOString() });
    return this.db.transaction(async tx => {
      const [deployment] = await tx.select({ id: deployments.id }).from(deployments).where(eq(deployments.id, input.deploymentId)).for('update');
      if (!deployment) throw new DeployNotFoundError();
      const [last] = await tx.select({ seq: deployLogChunks.seq }).from(deployLogChunks).where(eq(deployLogChunks.deploymentId, input.deploymentId)).orderBy(desc(deployLogChunks.seq)).limit(1).for('update');
      row.seq = (last?.seq ?? 0) + 1;
      if (row.seq > 4294967295) throw new RangeError('deploy_log_sequence_exhausted');
      await tx.insert(deployLogChunks).values(row); return row;
    }, { isolationLevel: 'read committed' });
  }
  async highestSeq(deploymentId: string) {
    const [row] = await this.db.select({ seq: deployLogChunks.seq }).from(deployLogChunks).where(eq(deployLogChunks.deploymentId, deploymentId)).orderBy(desc(deployLogChunks.seq)).limit(1);
    return row?.seq ?? 0;
  }
  listSince(deploymentId: string, seq = 0, limit = 500) {
    if (!Number.isInteger(seq) || seq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('invalid_deploy_log_cursor');
    return this.db.select().from(deployLogChunks).where(and(eq(deployLogChunks.deploymentId, deploymentId), gt(deployLogChunks.seq, seq)))
      .orderBy(asc(deployLogChunks.seq)).limit(limit);
  }
}
