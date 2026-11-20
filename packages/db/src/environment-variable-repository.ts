import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { EnvironmentNameSchema, VariableInputSchema, VariableNameSchema, type VariableInput } from '@forgekit/contracts';
import type { DatabaseClient } from './index';
import { buildEnvironments, builds, environments, environmentVariables, projects, variableAudit } from './schema';
import { decryptVariable, deployEncryptionKey } from './deploy-secrets';

type Database = DatabaseClient['db'];
export type VariableRow = typeof environmentVariables.$inferSelect;
export type ResolvedVariables = { values: Record<string, string>; secrets: string[] };
export class VariableNotFoundError extends Error { constructor() { super('variable_not_found'); } }
export class VariableLimitError extends Error { constructor() { super('variable_limit'); } }

export class EnvironmentVariableRepository {
  constructor(private readonly db: Database) {}
  async environments(projectId: string) {
    return this.db.select({ id: environments.id, name: environments.name }).from(environments)
      .where(eq(environments.projectId, projectId)).orderBy(asc(environments.name));
  }
  async list(projectId: string, environmentName: string): Promise<VariableRow[]> {
    const [env] = await this.db.select().from(environments)
      .where(and(eq(environments.projectId, projectId), eq(environments.name, environmentName))).limit(1);
    return env ? this.rows(projectId, env.id) : [];
  }
  private rows(projectId: string, environmentId: string) {
    return this.db.select().from(environmentVariables).where(and(eq(environmentVariables.projectId, projectId),
      eq(environmentVariables.environmentId, environmentId))).orderBy(asc(environmentVariables.name));
  }
  async save(projectId: string, environmentName: string, name: string, input: VariableInput, actor: string,
    encrypt: (value: string, environmentId: string) => string): Promise<VariableRow> {
    EnvironmentNameSchema.parse(environmentName); VariableNameSchema.parse(name); VariableInputSchema.parse(input);
    return this.db.transaction(async tx => {
      const [project] = await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update');
      if (!project) throw new VariableNotFoundError();
      let [env] = await tx.select().from(environments).where(and(eq(environments.projectId, projectId), eq(environments.name, environmentName)));
      if (!env) {
        const existing = await tx.select({ id: environments.id }).from(environments).where(eq(environments.projectId, projectId));
        if (existing.length >= 100) throw new VariableLimitError();
        env = { id: randomUUID(), projectId, name: environmentName, createdAt: new Date(), updatedAt: new Date() };
        await tx.insert(environments).values(env);
      }
      const rows = await tx.select({ name: environmentVariables.name }).from(environmentVariables).where(eq(environmentVariables.environmentId, env.id));
      const exists = rows.some(row => row.name === name);
      if (!exists && rows.length >= 100) throw new VariableLimitError();
      const row: VariableRow = { projectId, environmentId: env.id, name, kind: input.kind,
        plainValue: input.kind === 'plain' ? input.value : null,
        encryptedValue: input.kind === 'secret' ? encrypt(input.value, env.id) : null,
        updatedBy: actor, updatedAt: new Date() };
      await tx.insert(environmentVariables).values(row).onDuplicateKeyUpdate({ set: row });
      await tx.insert(variableAudit).values({ projectId, environmentId: env.id, name, kind: input.kind,
        actorUserId: actor, action: exists ? 'update' : 'create' });
      return row;
    }, { isolationLevel: 'read committed' });
  }
  async remove(projectId: string, environmentName: string, name: string, actor: string) {
    return this.db.transaction(async tx => {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update');
      const [env] = await tx.select().from(environments).where(and(eq(environments.projectId, projectId), eq(environments.name, environmentName)));
      if (!env) throw new VariableNotFoundError();
      const where = and(eq(environmentVariables.environmentId, env.id), eq(environmentVariables.name, name));
      const [row] = await tx.select({ kind: environmentVariables.kind }).from(environmentVariables).where(where);
      if (!row) throw new VariableNotFoundError();
      await tx.delete(environmentVariables).where(where);
      await tx.insert(variableAudit).values({ projectId, environmentId: env.id, name, kind: row.kind, actorUserId: actor, action: 'delete' });
    }, { isolationLevel: 'read committed' });
  }
  /** Trusted worker only. API uses list + an explicit public serializer and never this method. */
  async resolve(projectId: string, environmentId: string): Promise<ResolvedVariables> {
    const rows = await this.rows(projectId, environmentId);
    const values: Record<string, string> = Object.create(null) as Record<string, string>, secrets: string[] = [];
    let key: Buffer | undefined;
    try {
      for (const row of rows) {
        VariableNameSchema.parse(row.name);
        if (row.kind === 'secret') {
          key ??= deployEncryptionKey(process.env.FORGEKIT_DEPLOY_ENCRYPTION_KEY);
          const buffer = decryptVariable(row.encryptedValue ?? '', key, projectId, environmentId, row.name);
          try { values[row.name] = buffer.toString('utf8'); secrets.push(values[row.name]!); }
          finally { buffer.fill(0); }
        } else values[row.name] = row.plainValue ?? '';
      }
      return { values, secrets };
    } finally { key?.fill(0); }
  }
  /** Old B09 builds have no binding; persist the preview default before executing user code. */
  async forBuild(projectId: string, buildId: string): Promise<ResolvedVariables> {
    const environmentId = await this.db.transaction(async tx => {
      await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, projectId)).for('update');
      const [build] = await tx.select({ id: builds.id }).from(builds).where(and(eq(builds.id, buildId), eq(builds.projectId, projectId)));
      if (!build) throw new VariableNotFoundError();
      const [binding] = await tx.select().from(buildEnvironments).where(eq(buildEnvironments.buildId, buildId));
      if (binding) return binding.environmentId;
      let [env] = await tx.select().from(environments).where(and(eq(environments.projectId, projectId), eq(environments.name, 'preview')));
      if (!env) {
        env = { id: randomUUID(), projectId, name: 'preview', createdAt: new Date(), updatedAt: new Date() };
        await tx.insert(environments).values(env);
      }
      await tx.insert(buildEnvironments).values({ projectId, buildId, environmentId: env.id });
      return env.id;
    }, { isolationLevel: 'read committed' });
    return this.resolve(projectId, environmentId);
  }
}
