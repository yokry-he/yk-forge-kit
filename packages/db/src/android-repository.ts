import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import { AndroidJobInputSchema, type AndroidConfigInput, type AndroidJobInput } from '@forgekit/contracts';
import type { DatabaseClient } from './index';
import { projects, androidAudit, androidConfigs, androidJobs } from './schema';
type Database = DatabaseClient['db'];
export type AndroidConfigRow = typeof androidConfigs.$inferSelect;
export type AndroidJobRow = typeof androidJobs.$inferSelect;
export class AndroidConflictError extends Error { constructor() { super('android_precondition_failed'); } }
export class AndroidRepository {
  constructor(private readonly db: Database) {}
  async config(projectId: string): Promise<AndroidConfigRow | null> {
    const [row] = await this.db.select().from(androidConfigs).where(eq(androidConfigs.projectId, projectId)); return row ?? null;
  }
  async save(projectId: string, input: Omit<AndroidConfigInput, 'signing'>, encrypted: string | undefined, actor: string) {
    return this.db.transaction(async tx => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for('update');
      const [current] = await tx.select().from(androidConfigs).where(eq(androidConfigs.projectId, projectId));
      const [busy] = await tx.select({ id: androidJobs.id }).from(androidJobs).where(and(eq(androidJobs.projectId, projectId), inArray(androidJobs.status, ['queued', 'running']))).limit(1);
      if (busy) throw new AndroidConflictError();
      if (project?.template !== 'uniapp') throw new AndroidConflictError();
      const row = { projectId, settings: input,
        encryptedSigning: encrypted ?? (current?.settings.packageName === input.packageName ? current.encryptedSigning : null), updatedBy: actor, updatedAt: new Date() };
      await tx.insert(androidConfigs).values(row).onDuplicateKeyUpdate({ set: row });
      await tx.insert(androidAudit).values({ projectId, actorUserId: actor, action: 'config_saved' }); return row;
    }, { isolationLevel: 'read committed' });
  }
  async remove(projectId: string, actor: string) {
    return this.db.transaction(async tx => {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update');
      const [busy] = await tx.select({ id: androidJobs.id }).from(androidJobs).where(and(eq(androidJobs.projectId, projectId), inArray(androidJobs.status, ['queued', 'running']))).limit(1);
      if (busy) throw new AndroidConflictError();
      await tx.delete(androidConfigs).where(eq(androidConfigs.projectId, projectId));
      await tx.insert(androidAudit).values({ projectId, actorUserId: actor, action: 'config_deleted' });
    }, { isolationLevel: 'read committed' });
  }
  async create(projectId: string, input: AndroidJobInput, actor: string): Promise<AndroidJobRow> {
    AndroidJobInputSchema.parse(input);
    return this.db.transaction(async tx => {
      const [project] = await tx.select().from(projects).where(eq(projects.id, projectId)).for('update');
      const [config] = await tx.select().from(androidConfigs).where(eq(androidConfigs.projectId, projectId));
      const [busy] = await tx.select({ id: androidJobs.id }).from(androidJobs).where(and(eq(androidJobs.projectId, projectId), inArray(androidJobs.status, ['queued', 'running']))).limit(1);
      if (project?.template !== 'uniapp' || !config || (input.buildType === 'release' && !config.encryptedSigning) || busy) throw new AndroidConflictError();
      const now = new Date();
      const row: AndroidJobRow = { id: randomUUID(), projectId, settings: config.settings, source: { name: project.slug, features: project.features }, input,
        triggeredBy: actor, status: 'queued', errorCode: null, artifactKey: null, artifact: null, createdAt: now, updatedAt: now, startedAt: null, finishedAt: null };
      await tx.insert(androidJobs).values(row);
      await tx.insert(androidAudit).values({ projectId, jobId: row.id, actorUserId: actor, action: 'triggered' }); return row;
    }, { isolationLevel: 'read committed' });
  }
  async get(id: string): Promise<AndroidJobRow | null> {
    const [row] = await this.db.select().from(androidJobs).where(eq(androidJobs.id, id)); return row ?? null;
  }
  list(projectId: string) {
    return this.db.select().from(androidJobs).where(eq(androidJobs.projectId, projectId)).orderBy(desc(androidJobs.createdAt), desc(androidJobs.id)).limit(100);
  }
  stale(status: 'queued' | 'running', before: Date) {
    return this.db.select().from(androidJobs).where(and(eq(androidJobs.status, status), lt(androidJobs.updatedAt, before)))
      .orderBy(asc(androidJobs.updatedAt)).limit(100);
  }
  async cancel(projectId: string, id: string, actor: string) {
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(androidJobs).where(and(eq(androidJobs.id, id), eq(androidJobs.projectId, projectId))).for('update');
      if (!row) throw new AndroidConflictError();
      if (!['queued', 'running'].includes(row.status)) return;
      const now = new Date();
      // Running stays active until the owner has removed its containers.
      await tx.update(androidJobs).set(row.status === 'queued'
        ? { status: 'failed', errorCode: 'android_canceled', updatedAt: now, finishedAt: now }
        : { errorCode: 'android_cancel_requested' }).where(eq(androidJobs.id, id));
      await tx.insert(androidAudit).values({ projectId, jobId: id, actorUserId: actor, action: 'cancel_requested' });
    }, { isolationLevel: 'read committed' });
  }
  async transition(id: string, from: 'queued' | 'running', to: 'running' | 'succeeded' | 'failed', errorCode: string | null = null, artifactKey: string | null = null, artifact: import('@forgekit/contracts').AndroidArtifact | null = null) {
    if ((from === 'queued' && to === 'succeeded') || (from === 'running' && to === 'running')) throw new AndroidConflictError();
    return this.db.transaction(async tx => {
      const [row] = await tx.select().from(androidJobs).where(eq(androidJobs.id, id)).for('update');
      if (!row || row.status !== from || (to === 'succeeded' && row.errorCode === 'android_cancel_requested')) throw new AndroidConflictError();
      const now = new Date();
      await tx.update(androidJobs).set({ status: to, updatedAt: now, errorCode, artifactKey, artifact,
        ...(to === 'running' ? { startedAt: now } : { finishedAt: now }) }).where(eq(androidJobs.id, id));
    }, { isolationLevel: 'read committed' });
  }
}
