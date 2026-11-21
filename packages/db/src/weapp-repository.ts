import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import { WeappJobInputSchema, type WeappConfigInput, type WeappJobInput } from '@forgekit/contracts';
import type { DatabaseClient } from './index';
import { builds, projects, weappAudit, weappConfigs, weappJobs } from './schema';
type Database = DatabaseClient['db'];
export type WeappConfigRow = typeof weappConfigs.$inferSelect;
export type WeappJobRow = typeof weappJobs.$inferSelect;
export class WeappConflictError extends Error { constructor() { super('weapp_precondition_failed'); } }
export class WeappRepository {
  constructor(private readonly db: Database) {}
  async config(projectId: string): Promise<WeappConfigRow | null> {
    const [row] = await this.db.select().from(weappConfigs).where(eq(weappConfigs.projectId, projectId)); return row ?? null;
  }
  async save(projectId: string, input: Omit<WeappConfigInput, 'privateKey'>, encrypted: string | undefined, actor: string) {
    return this.db.transaction(async tx => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for('update');
      const [current] = await tx.select().from(weappConfigs).where(eq(weappConfigs.projectId, projectId));
      if (project?.template !== 'uniapp' || (!encrypted && (!current || current.appId !== input.appId))) throw new WeappConflictError();
      const row = { projectId, appId: input.appId, ipWhitelistNote: input.ipWhitelistNote,
        encryptedPrivateKey: encrypted ?? current!.encryptedPrivateKey, updatedBy: actor, updatedAt: new Date() };
      await tx.insert(weappConfigs).values(row).onDuplicateKeyUpdate({ set: row });
      await tx.insert(weappAudit).values({ projectId, actorUserId: actor, action: 'config_saved' }); return row;
    }, { isolationLevel: 'read committed' });
  }
  async remove(projectId: string, actor: string) {
    return this.db.transaction(async tx => {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update');
      await tx.delete(weappConfigs).where(eq(weappConfigs.projectId, projectId));
      await tx.insert(weappAudit).values({ projectId, actorUserId: actor, action: 'config_deleted' });
    }, { isolationLevel: 'read committed' });
  }
  async create(projectId: string, input: WeappJobInput, actor: string): Promise<WeappJobRow> {
    WeappJobInputSchema.parse(input);
    return this.db.transaction(async tx => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for('update');
      const [config] = await tx.select().from(weappConfigs).where(eq(weappConfigs.projectId, projectId));
      const [build] = await tx.select().from(builds).where(and(eq(builds.id, input.buildId), eq(builds.projectId, projectId)));
      const [busy] = await tx.select({ id: weappJobs.id }).from(weappJobs).where(and(eq(weappJobs.projectId, projectId), inArray(weappJobs.status, ['queued', 'running']))).limit(1);
      if (project?.template !== 'uniapp' || !config || !isWeappBuild(build, projectId) || busy) throw new WeappConflictError();
      const now = new Date();
      const row: WeappJobRow = { id: randomUUID(), projectId, buildId: input.buildId, appId: config.appId, input,
        triggeredBy: actor, status: 'queued', errorCode: null, qrArtifactKey: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null };
      await tx.insert(weappJobs).values(row);
      await tx.insert(weappAudit).values({ projectId, jobId: row.id, actorUserId: actor, action: 'triggered' }); return row;
    }, { isolationLevel: 'read committed' });
  }
  async get(id: string): Promise<WeappJobRow | null> {
    const [row] = await this.db.select().from(weappJobs).where(eq(weappJobs.id, id)); return row ?? null;
  }
  list(projectId: string) {
    return this.db.select().from(weappJobs).where(eq(weappJobs.projectId, projectId)).orderBy(desc(weappJobs.createdAt), desc(weappJobs.id)).limit(100);
  }
  stale(status: 'queued' | 'running', before: Date) {
    return this.db.select().from(weappJobs).where(and(eq(weappJobs.status, status), lt(weappJobs.updatedAt, before)))
      .orderBy(asc(weappJobs.updatedAt)).limit(100);
  }
  async transition(id: string, from: 'queued' | 'running', to: 'running' | 'succeeded' | 'failed', errorCode: string | null = null, qrArtifactKey: string | null = null) {
    if ((from === 'queued' && to === 'succeeded') || (from === 'running' && to === 'running')) throw new WeappConflictError();
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(weappJobs).where(eq(weappJobs.id, id)).for('update');
      if (!row || row.status !== from) throw new WeappConflictError();
      const now = new Date();
      await tx.update(weappJobs).set({ status: to, updatedAt: now, errorCode, qrArtifactKey,
        ...(to === 'running' ? { startedAt: now } : { finishedAt: now }) }).where(eq(weappJobs.id, id));
    }, { isolationLevel: 'read committed' });
  }
}
export function isWeappBuild(build: { projectId: string; template: string; target?: string; status: string; artifactKey: string | null; artifactSha256: string | null } | null | undefined, projectId: string) {
  return !!build && build.projectId === projectId && build.template === 'uniapp' && build.target === 'mp-weixin' && build.status === 'succeeded' && !!build.artifactKey && !!build.artifactSha256;
}
