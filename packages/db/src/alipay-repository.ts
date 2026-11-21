import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import { AlipayJobInputSchema, type AlipayConfigInput, type AlipayJobInput } from '@forgekit/contracts';
import type { DatabaseClient } from './index';
import { builds, projects, alipayAudit, alipayConfigs, alipayJobs } from './schema';
type Database = DatabaseClient['db'];
export type AlipayConfigRow = typeof alipayConfigs.$inferSelect;
export type AlipayJobRow = typeof alipayJobs.$inferSelect;
export class AlipayConflictError extends Error { constructor() { super('alipay_precondition_failed'); } }
export class AlipayRepository {
  constructor(private readonly db: Database) {}
  async config(projectId: string): Promise<AlipayConfigRow | null> {
    const [row] = await this.db.select().from(alipayConfigs).where(eq(alipayConfigs.projectId, projectId)); return row ?? null;
  }
  async save(projectId: string, input: Omit<AlipayConfigInput, 'privateKey'>, encrypted: string | undefined, actor: string) {
    return this.db.transaction(async tx => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for('update');
      const [current] = await tx.select().from(alipayConfigs).where(eq(alipayConfigs.projectId, projectId));
      if (project?.template !== 'uniapp' || (!encrypted && (!current || (current.appId !== input.appId || current.toolId !== input.toolId)))) throw new AlipayConflictError();
      const row = { projectId, appId: input.appId, toolId: input.toolId,
        encryptedPrivateKey: encrypted ?? current!.encryptedPrivateKey, updatedBy: actor, updatedAt: new Date() };
      await tx.insert(alipayConfigs).values(row).onDuplicateKeyUpdate({ set: row });
      await tx.insert(alipayAudit).values({ projectId, actorUserId: actor, action: 'config_saved' }); return row;
    }, { isolationLevel: 'read committed' });
  }
  async remove(projectId: string, actor: string) {
    return this.db.transaction(async tx => {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update');
      await tx.delete(alipayConfigs).where(eq(alipayConfigs.projectId, projectId));
      await tx.insert(alipayAudit).values({ projectId, actorUserId: actor, action: 'config_deleted' });
    }, { isolationLevel: 'read committed' });
  }
  async create(projectId: string, input: AlipayJobInput, actor: string): Promise<AlipayJobRow> {
    AlipayJobInputSchema.parse(input);
    return this.db.transaction(async tx => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for('update');
      const [config] = await tx.select().from(alipayConfigs).where(eq(alipayConfigs.projectId, projectId));
      const [build] = await tx.select().from(builds).where(and(eq(builds.id, input.buildId), eq(builds.projectId, projectId)));
      const [busy] = await tx.select({ id: alipayJobs.id }).from(alipayJobs).where(and(eq(alipayJobs.projectId, projectId), inArray(alipayJobs.status, ['queued', 'running']))).limit(1);
      if (project?.template !== 'uniapp' || !config || !isAlipayBuild(build, projectId) || busy) throw new AlipayConflictError();
      const now = new Date();
      const row: AlipayJobRow = { id: randomUUID(), projectId, buildId: input.buildId, appId: config.appId, toolId: config.toolId, input,
        triggeredBy: actor, status: 'queued', errorCode: null, qrArtifactKey: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null };
      await tx.insert(alipayJobs).values(row);
      await tx.insert(alipayAudit).values({ projectId, jobId: row.id, actorUserId: actor, action: 'triggered' }); return row;
    }, { isolationLevel: 'read committed' });
  }
  async get(id: string): Promise<AlipayJobRow | null> {
    const [row] = await this.db.select().from(alipayJobs).where(eq(alipayJobs.id, id)); return row ?? null;
  }
  list(projectId: string) {
    return this.db.select().from(alipayJobs).where(eq(alipayJobs.projectId, projectId)).orderBy(desc(alipayJobs.createdAt), desc(alipayJobs.id)).limit(100);
  }
  stale(status: 'queued' | 'running', before: Date) {
    return this.db.select().from(alipayJobs).where(and(eq(alipayJobs.status, status), lt(alipayJobs.updatedAt, before)))
      .orderBy(asc(alipayJobs.updatedAt)).limit(100);
  }
  async transition(id: string, from: 'queued' | 'running', to: 'running' | 'succeeded' | 'failed', errorCode: string | null = null, qrArtifactKey: string | null = null) {
    if ((from === 'queued' && to === 'succeeded') || (from === 'running' && to === 'running')) throw new AlipayConflictError();
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(alipayJobs).where(eq(alipayJobs.id, id)).for('update');
      if (!row || row.status !== from) throw new AlipayConflictError();
      const now = new Date();
      await tx.update(alipayJobs).set({ status: to, updatedAt: now, errorCode, qrArtifactKey,
        ...(to === 'running' ? { startedAt: now } : { finishedAt: now }) }).where(eq(alipayJobs.id, id));
    }, { isolationLevel: 'read committed' });
  }
}
export function isAlipayBuild(build: { projectId: string; template: string; target?: string; status: string; artifactKey: string | null; artifactSha256: string | null } | null | undefined, projectId: string) {
  return !!build && build.projectId === projectId && build.template === 'uniapp' && build.target === 'mp-alipay' && build.status === 'succeeded' && !!build.artifactKey && !!build.artifactSha256;
}
