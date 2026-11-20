import { randomUUID, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, gt, isNull, lt, or } from 'drizzle-orm';
import {
  BuildSchema, BuildStatusSchema, canTransition, BuildLogEventSchema,
  PreviewLinkCreateRequestSchema, Sha256Schema,
  type BuildStatus, type BuildLogEvent, type RunnerInfo,
} from '@forgekit/contracts';
import type { DatabaseClient } from './index';
import { builds, buildLogChunks, previewLinks, projects, buildAudit, previewLinkAudit, environments, buildEnvironments } from './schema';

type Database = DatabaseClient['db'];
type BuildRow = typeof builds.$inferSelect;
const statusPatchSchema = BuildSchema.pick({ exitCode: true, errorMessage: true, artifactKey: true,
  artifactSize: true, artifactSha256: true, logStorageKey: true, runnerInfo: true }).partial();

export class BuildNotFoundError extends Error {
  constructor() { super('构建或项目不存在。'); }
}
export class BuildTransitionError extends Error {
  constructor() { super('构建状态转换无效或状态已被其他任务更新。'); }
}

function pageSize(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError('limit 必须是 1–1000 的整数。');
  return limit;
}

/** Database rows use Date; contracts use ISO strings at process boundaries. */
export class BuildRepository {
  constructor(private readonly db: Database) {}

  /** B09 template rendering input only; never returns platform credentials. */
  async getProjectSource(projectId: string) {
    const [row] = await this.db.select({ name: projects.slug, template: projects.template, features: projects.features })
      .from(projects).where(eq(projects.id, projectId)).limit(1);
    return row ?? null;
  }

  async create(input: { projectId: string; template: string; sourceRef: string; triggeredBy: string }, audit = false, environmentName = 'preview'): Promise<BuildRow> {
    const now = new Date();
    const row: BuildRow = {
      ...input, id: randomUUID(), number: 1, status: 'queued', queuedAt: now, startedAt: null,
      finishedAt: null, exitCode: null, errorMessage: null, artifactKey: null, artifactSize: null,
      artifactSha256: null, logStorageKey: null, runnerInfo: null, createdAt: now, updatedAt: now,
    };
    BuildSchema.parse({ ...row, queuedAt: now.toISOString(), createdAt: now.toISOString(), updatedAt: now.toISOString() });
    return this.db.transaction(async (tx) => {
      // A parent row always exists, including when this is the project's first build.
      const [project] = await tx.select({ id: projects.id }).from(projects)
        .where(eq(projects.id, input.projectId)).for('update');
      if (!project) throw new BuildNotFoundError();
      // READ COMMITTED avoids shared index-gap locks between different projects' first builds.
      const [last] = await tx.select({ number: builds.number }).from(builds)
        .where(eq(builds.projectId, input.projectId)).orderBy(desc(builds.number)).limit(1).for('update');
      row.number = (last?.number ?? 0) + 1;
      if (row.number > 4294967295) throw new RangeError('构建编号已耗尽。');
      await tx.insert(builds).values(row);
      let [environment] = await tx.select().from(environments).where(and(eq(environments.projectId, input.projectId), eq(environments.name, environmentName)));
      if (!environment) {
        environment = { id: randomUUID(), projectId: input.projectId, name: environmentName, createdAt: now, updatedAt: now };
        await tx.insert(environments).values(environment);
      }
      await tx.insert(buildEnvironments).values({ buildId: row.id, projectId: input.projectId, environmentId: environment.id });
      if (audit) await tx.insert(buildAudit).values({ projectId: row.projectId, buildId: row.id,
        actorUserId: row.triggeredBy, action: 'triggered' });
      return row;
    }, { isolationLevel: 'read committed' });
  }

  async get(id: string): Promise<BuildRow | null> {
    const [row] = await this.db.select().from(builds).where(eq(builds.id, id)).limit(1);
    return row ?? null;
  }

  /** Descending build-number cursor; pass the last returned number as beforeNumber. */
  async listByProject(projectId: string, options: { limit?: number; beforeNumber?: number } = {}): Promise<BuildRow[]> {
    const before = options.beforeNumber;
    if (before !== undefined && (!Number.isInteger(before) || before < 1)) throw new RangeError('构建游标无效。');
    return this.db.select().from(builds).where(and(eq(builds.projectId, projectId),
      before === undefined ? undefined : lt(builds.number, before)))
      .orderBy(desc(builds.number)).limit(pageSize(options.limit ?? 50));
  }

  /** Reconcile a DB commit interrupted before enqueue; bounded scan, stable oldest-first order. */
  async listQueuedBefore(before: Date, limit = 100): Promise<BuildRow[]> {
    return this.db.select().from(builds).where(and(eq(builds.status, 'queued'), lt(builds.queuedAt, before)))
      .orderBy(asc(builds.queuedAt), asc(builds.id)).limit(pageSize(limit));
  }

  async listRunningBefore(before: Date, limit = 100): Promise<BuildRow[]> {
    return this.db.select().from(builds).where(and(eq(builds.status, 'running'), lt(builds.startedAt, before)))
      .orderBy(asc(builds.startedAt), asc(builds.id)).limit(pageSize(limit));
  }

  async updateStatus(id: string, from: BuildStatus, to: BuildStatus, patch: {
    exitCode?: number; errorMessage?: string; artifactKey?: string; artifactSize?: number;
    artifactSha256?: string; logStorageKey?: string; runnerInfo?: RunnerInfo;
  } = {}, cancelActorId?: string): Promise<BuildRow> {
    if (cancelActorId !== undefined) {
      BuildSchema.shape.triggeredBy.parse(cancelActorId);
      if (to !== 'canceled') throw new BuildTransitionError();
    }
    BuildStatusSchema.parse(from);
    BuildStatusSchema.parse(to);
    if (!canTransition(from, to)) throw new BuildTransitionError();
    // Whitelist fields at runtime as well as in TypeScript; never accept IDs/status/timestamps from a patch.
    const parsed = statusPatchSchema.parse(patch);
    // Explicit undefined has the same meaning as an omitted optional field.
    for (const key of Object.keys(parsed) as Array<keyof typeof parsed>) {
      if (parsed[key] === undefined) delete parsed[key];
    }
    return this.db.transaction(async (tx) => {
      const [current] = await tx.select().from(builds).where(eq(builds.id, id)).limit(1).for('update');
      if (!current) throw new BuildNotFoundError();
      if (current.status !== from) throw new BuildTransitionError();
      const now = new Date();
      const row: BuildRow = { ...current, ...parsed, status: to, updatedAt: now,
        startedAt: to === 'running' ? now : current.startedAt,
        finishedAt: to === 'running' ? null : now };
      await tx.update(builds).set(row).where(eq(builds.id, id));
      if (cancelActorId) await tx.insert(buildAudit).values({ projectId: row.projectId, buildId: id,
        actorUserId: cancelActorId, action: 'canceled' });
      return row;
    });
  }
}

export class BuildLogRepository {
  constructor(private readonly db: Database) {}

  /** Serializes appenders on the build row and assigns the next sequence (starting at 1). */
  async append(input: Omit<BuildLogEvent, 'seq' | 'ts'> & { ts?: Date }) {
    const row = { ...input, ts: input.ts ?? new Date(), seq: 1 };
    BuildLogEventSchema.parse({ ...row, ts: row.ts.toISOString() });
    return this.db.transaction(async (tx) => {
      const [build] = await tx.select({ id: builds.id }).from(builds).where(eq(builds.id, input.buildId)).for('update');
      if (!build) throw new BuildNotFoundError();
      // Keep per-build serialization without locking shared index gaps for other builds' first chunks.
      const [last] = await tx.select({ seq: buildLogChunks.seq }).from(buildLogChunks)
        .where(eq(buildLogChunks.buildId, input.buildId)).orderBy(desc(buildLogChunks.seq)).limit(1).for('update');
      row.seq = (last?.seq ?? 0) + 1;
      if (row.seq > 4294967295) throw new RangeError('日志序号已耗尽。');
      await tx.insert(buildLogChunks).values(row);
      return row;
    }, { isolationLevel: 'read committed' });
  }

  /** One statement captures a stable high-water mark; appenders never reuse sequence IDs. */
  async highestSeq(buildId: string): Promise<number> {
    const [row] = await this.db.select({ seq: buildLogChunks.seq }).from(buildLogChunks)
      .where(eq(buildLogChunks.buildId, buildId)).orderBy(desc(buildLogChunks.seq)).limit(1);
    return row?.seq ?? 0;
  }

  async listSince(buildId: string, seq = 0, limit = 500) {
    if (!Number.isInteger(seq) || seq < 0) throw new RangeError('日志游标必须是非负整数。');
    return this.db.select().from(buildLogChunks)
      .where(and(eq(buildLogChunks.buildId, buildId), gt(buildLogChunks.seq, seq)))
      .orderBy(asc(buildLogChunks.seq)).limit(pageSize(limit));
  }
}

const publicPreviewColumns = {
  id: previewLinks.id, buildId: previewLinks.buildId, createdBy: previewLinks.createdBy,
  createdAt: previewLinks.createdAt, expiresAt: previewLinks.expiresAt,
  revokedAt: previewLinks.revokedAt, lastAccessedAt: previewLinks.lastAccessedAt,
};

/** Accepts only SHA-256 digests. Token generation/one-time delivery belong to B11. */
export class PreviewLinkRepository {
  constructor(private readonly db: Database) {}

  async create(input: { buildId: string; tokenHash: string; createdBy: string; ttlSeconds?: number }, audit?: { projectId: string; actorUserId: string }) {
    Sha256Schema.parse(input.tokenHash);
    const { ttlSeconds } = PreviewLinkCreateRequestSchema.parse({ ttlSeconds: input.ttlSeconds });
    const now = new Date();
    const row = { id: randomUUID(), buildId: input.buildId, createdBy: input.createdBy,
      createdAt: now, expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
      revokedAt: null, lastAccessedAt: null };
    await this.db.transaction(async (tx) => {
      if (audit) {
        const [build] = await tx.select().from(builds).where(eq(builds.id, input.buildId)).limit(1).for('update');
        if (!build || build.projectId !== audit.projectId || build.status !== 'succeeded' || !build.artifactKey) throw new BuildTransitionError();
      }
      await tx.insert(previewLinks).values({ ...row, tokenHash: input.tokenHash });
      if (audit) await tx.insert(previewLinkAudit).values({ ...audit, previewLinkId: row.id, buildId: row.buildId, action: 'created' });
    });
    return row;
  }

  /** Does not touch access time: call recordAccess only when the gateway serves an artifact. */
  async findValidByHash(tokenHash: string) {
    Sha256Schema.parse(tokenHash);
    const [row] = await this.db.select({ ...publicPreviewColumns, tokenHash: previewLinks.tokenHash }).from(previewLinks)
      .where(and(eq(previewLinks.tokenHash, tokenHash), isNull(previewLinks.revokedAt), gt(previewLinks.expiresAt, new Date())))
      .limit(1);
    // A fixed-size digest comparison, including misses; never compare plaintext tokens.
    const equal = timingSafeEqual(Buffer.from(tokenHash, 'hex'), Buffer.from(row?.tokenHash ?? '0'.repeat(64), 'hex'));
    if (!row || !equal) return null;
    const { tokenHash: _digest, ...metadata } = row;
    return metadata;
  }

  async listActive(buildId: string) {
    return this.db.select(publicPreviewColumns).from(previewLinks)
      .where(and(eq(previewLinks.buildId, buildId), isNull(previewLinks.revokedAt), gt(previewLinks.expiresAt, new Date())))
      .orderBy(desc(previewLinks.createdAt), desc(previewLinks.id));
  }

  async recordAccess(id: string, throttleMs = 0): Promise<boolean> {
    const [result] = await this.db.update(previewLinks).set({ lastAccessedAt: new Date() })
      .where(and(eq(previewLinks.id, id), isNull(previewLinks.revokedAt), gt(previewLinks.expiresAt, new Date()),
        or(isNull(previewLinks.lastAccessedAt), lt(previewLinks.lastAccessedAt, new Date(Date.now() - throttleMs)))));
    return result.affectedRows === 1;
  }

  /** Idempotent; buildId scopes the operation after the caller authorizes project/build access. */
  async revoke(buildId: string, id: string, audit?: { projectId: string; actorUserId: string }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const [result] = await tx.update(previewLinks).set({ revokedAt: new Date() })
        .where(and(eq(previewLinks.id, id), eq(previewLinks.buildId, buildId), isNull(previewLinks.revokedAt)));
      if (result.affectedRows === 1 && audit) await tx.insert(previewLinkAudit).values({ ...audit, buildId, previewLinkId: id, action: 'revoked' });
      return result.affectedRows === 1;
    });
  }
}
