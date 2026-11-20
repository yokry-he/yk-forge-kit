import type { RunnerInfo } from '@forgekit/contracts';
import { bigint, boolean, index, int, json, mysqlEnum, mysqlTable, primaryKey, foreignKey, text, timestamp, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

/** Initial metadata only; no user/auth schema is assumed at this stage. */
export const projects = mysqlTable('projects', {
  id: varchar('id', { length: 36 }).primaryKey(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  name: varchar('name', { length: 150 }).notNull(),
  template: varchar('template', { length: 32 }).notNull().default('vue-web'),
  features: json('features').$type<Array<'theme' | 'router' | 'pinia'>>().notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/** Human accounts are provider-neutral; no passwords or credentials are stored here. */
export const users = mysqlTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  displayName: varchar('display_name', { length: 150 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

/** Stable issuer + subject pairing; email is not an authentication identifier. */
export const externalIdentities = mysqlTable('external_identities', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  userId: varchar('user_id', { length: 36 }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  issuer: varchar('issuer', { length: 255 }).notNull(),
  subject: varchar('subject', { length: 255 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('external_identity_issuer_subject_unique').on(table.issuer, table.subject)]);

/** Project roles remain separate from global identity records. */
export const projectMemberships = mysqlTable('project_memberships', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: varchar('user_id', { length: 36 }).notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: varchar('role', { length: 16 }).$type<'owner' | 'editor' | 'viewer'>().notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('project_membership_project_user_unique').on(table.projectId, table.userId)]);

/** Append-only member role audit. User IDs remain as historical identifiers. */
export const projectMemberAudit = mysqlTable('project_member_audit', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  actorUserId: varchar('actor_user_id', { length: 36 }).notNull(),
  targetUserId: varchar('target_user_id', { length: 36 }).notNull(),
  previousRole: varchar('previous_role', { length: 16 }).notNull(),
  nextRole: varchar('next_role', { length: 16 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [index('project_member_audit_project_time_idx').on(table.projectId, table.createdAt)]);

/** One-time invitation codes are stored only as SHA-256 digests. */
export const projectInvitations = mysqlTable('project_invitations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull().unique(),
  role: varchar('role', { length: 16 }).$type<'editor' | 'viewer'>().notNull(),
  createdByUserId: varchar('created_by_user_id', { length: 36 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at').notNull(),
  redeemedAt: timestamp('redeemed_at'),
  redeemedByUserId: varchar('redeemed_by_user_id', { length: 36 }),
  revokedAt: timestamp('revoked_at'),
  revokedByUserId: varchar('revoked_by_user_id', { length: 36 }),
}, (table) => [index('project_invitation_project_expiry_idx').on(table.projectId, table.expiresAt)]);

/** Append-only invitation lifecycle audit; never includes invitation plaintext or digest. */
export const projectInvitationAudit = mysqlTable('project_invitation_audit', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  invitationId: varchar('invitation_id', { length: 36 }).notNull(),
  actorUserId: varchar('actor_user_id', { length: 36 }).notNull(),
  action: varchar('action', { length: 16 }).$type<'created' | 'redeemed' | 'revoked'>().notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [index('project_invitation_audit_project_time_idx').on(table.projectId, table.createdAt)]);

/** Shared atomic rate counters, keyed by non-reversible OIDC identity digest and time window. */
export const invitationRateBuckets = mysqlTable('invitation_rate_buckets', {
  key: varchar('bucket_key', { length: 96 }).primaryKey(),
  attempts: int('attempts', { unsigned: true }).notNull().default(0),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [index('invitation_rate_bucket_created_idx').on(table.createdAt)]);

export const assetInstallations = mysqlTable('asset_installations', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  assetId: varchar('asset_id', { length: 128 }).notNull(),
  version: varchar('version', { length: 32 }).notNull(),
  status: varchar('status', { length: 16 }).$type<'planned' | 'applied'>().notNull().default('planned'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('asset_installations_project_asset_unique').on(table.projectId, table.assetId)]);

/** Project-scoped names, e.g. preview / production. No environment secrets in B07. */
export const environments = mysqlTable('environments', {
  id: varchar('id', { length: 36 }).primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 64 }).notNull(),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().$onUpdateFn(() => new Date()),
}, (t) => [
  uniqueIndex('environments_project_name_unique').on(t.projectId, t.name),
  uniqueIndex('environments_project_id_unique').on(t.projectId, t.id),
]);

export const deployTargets = mysqlTable('deploy_targets', {
  id: varchar('id', { length: 36 }).primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  kind: mysqlEnum('kind', ['ssh']).notNull().default('ssh'),
  name: varchar('name', { length: 150 }).notNull(),
  host: varchar('host', { length: 255 }),
  port: int('port', { unsigned: true }),
  username: varchar('username', { length: 150 }),
  hostKey: text('host_key'),
  encryptedPrivateKey: text('encrypted_private_key'),
  basePath: varchar('base_path', { length: 255 }),
  retention: int('retention', { unsigned: true }).notNull().default(5),
  currentReleaseId: varchar('current_release_id', { length: 36 }),
  disabledAt: timestamp('disabled_at', { fsp: 3 }),
  createdBy: varchar('created_by', { length: 36 }).notNull().references(() => users.id),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().$onUpdateFn(() => new Date()),
}, (t) => [uniqueIndex('deploy_targets_project_id_unique').on(t.projectId, t.id)]);

export const builds = mysqlTable('builds', {
  id: varchar('id', { length: 36 }).primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  number: int('number', { unsigned: true }).notNull(),
  template: varchar('template', { length: 32 }).notNull(),
  sourceRef: varchar('source_ref', { length: 1024 }).notNull(),
  status: mysqlEnum('status', ['queued', 'running', 'succeeded', 'failed', 'canceled', 'timed_out']).notNull().default('queued'),
  triggeredBy: varchar('triggered_by', { length: 36 }).notNull().references(() => users.id),
  queuedAt: timestamp('queued_at', { fsp: 3 }).notNull().defaultNow(),
  startedAt: timestamp('started_at', { fsp: 3 }),
  finishedAt: timestamp('finished_at', { fsp: 3 }),
  exitCode: int('exit_code'),
  errorMessage: text('error_message'),
  artifactKey: varchar('artifact_key', { length: 1024 }),
  artifactSize: bigint('artifact_size', { mode: 'number', unsigned: true }),
  artifactSha256: varchar('artifact_sha256', { length: 64 }),
  logStorageKey: varchar('log_storage_key', { length: 1024 }),
  runnerInfo: json('runner_info').$type<RunnerInfo>(),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().$onUpdateFn(() => new Date()),
}, (t) => [
  uniqueIndex('builds_project_number_unique').on(t.projectId, t.number),
  uniqueIndex('builds_project_id_unique').on(t.projectId, t.id),
  index('builds_project_status_idx').on(t.projectId, t.status),
]);

/** Authoritative MVP log, ordered by a per-build sequence for SSE resume. */
export const buildLogChunks = mysqlTable('build_log_chunks', {
  buildId: varchar('build_id', { length: 36 }).notNull().references(() => builds.id, { onDelete: 'cascade' }),
  seq: int('seq', { unsigned: true }).notNull(),
  stream: mysqlEnum('stream', ['stdout', 'stderr', 'system']).notNull(),
  content: text('content').notNull(),
  ts: timestamp('ts', { fsp: 3 }).notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.buildId, t.seq] })]);

/** Composite FKs prevent linking a build to another project's environment or host. */
export const deployments = mysqlTable('deployments', {
  id: varchar('id', { length: 36 }).primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull(),
  buildId: varchar('build_id', { length: 36 }).notNull(),
  environmentId: varchar('environment_id', { length: 36 }).notNull(),
  deployTargetId: varchar('deploy_target_id', { length: 36 }).notNull(),
  status: mysqlEnum('status', ['pending', 'running', 'succeeded', 'failed', 'canceled', 'rolled_back']).notNull().default('pending'),
  action: mysqlEnum('action', ['deploy', 'rollback']).notNull().default('deploy'),
  releaseId: varchar('release_id', { length: 36 }),
  rollbackOf: varchar('rollback_of', { length: 36 }),
  triggeredBy: varchar('triggered_by', { length: 36 }),
  retained: boolean('retained').notNull().default(false),
  errorMessage: varchar('error_message', { length: 255 }),
  startedAt: timestamp('started_at', { fsp: 3 }),
  finishedAt: timestamp('finished_at', { fsp: 3 }),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { fsp: 3 }).notNull().defaultNow().$onUpdateFn(() => new Date()),
}, (t) => [
  foreignKey({ columns: [t.projectId, t.buildId], foreignColumns: [builds.projectId, builds.id], name: 'deployments_project_build_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.projectId, t.environmentId], foreignColumns: [environments.projectId, environments.id], name: 'deployments_project_environment_fk' }).onDelete('cascade'),
  foreignKey({ columns: [t.projectId, t.deployTargetId], foreignColumns: [deployTargets.projectId, deployTargets.id], name: 'deployments_project_target_fk' }).onDelete('cascade'),
  index('deployments_project_environment_status_idx').on(t.projectId, t.environmentId, t.status),
  index('deployments_target_status_idx').on(t.deployTargetId, t.status),
  index('deployments_status_updated_idx').on(t.status, t.updatedAt),
]);

export const previewLinks = mysqlTable('preview_links', {
  id: varchar('id', { length: 36 }).primaryKey(),
  buildId: varchar('build_id', { length: 36 }).notNull().references(() => builds.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  expiresAt: timestamp('expires_at', { fsp: 3 }).notNull(),
  revokedAt: timestamp('revoked_at', { fsp: 3 }),
  createdBy: varchar('created_by', { length: 36 }).notNull().references(() => users.id),
  lastAccessedAt: timestamp('last_accessed_at', { fsp: 3 }),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('preview_links_token_hash_unique').on(t.tokenHash),
  index('preview_links_build_expiry_idx').on(t.buildId, t.expiresAt),
  index('preview_links_expiry_idx').on(t.expiresAt),
]);

/** Append-only build control audit. Status updates and audit commit together. */
export const buildAudit = mysqlTable('build_audit', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  buildId: varchar('build_id', { length: 36 }).notNull().references(() => builds.id, { onDelete: 'cascade' }),
  actorUserId: varchar('actor_user_id', { length: 36 }).notNull(),
  action: varchar('action', { length: 16 }).$type<'triggered' | 'canceled'>().notNull(),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => [index('build_audit_project_time_idx').on(t.projectId, t.createdAt)]);

/** Link lifecycle audit excludes bearer tokens, URLs and digests. */
export const previewLinkAudit = mysqlTable('preview_link_audit', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  buildId: varchar('build_id', { length: 36 }).notNull().references(() => builds.id, { onDelete: 'cascade' }),
  previewLinkId: varchar('preview_link_id', { length: 36 }).notNull(),
  actorUserId: varchar('actor_user_id', { length: 36 }).notNull(),
  action: varchar('action', { length: 16 }).$type<'created' | 'revoked'>().notNull(),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, (t) => [index('preview_link_audit_project_time_idx').on(t.projectId, t.createdAt)]);

/** Same append/sequence contract as build_log_chunks. */
export const deployLogChunks = mysqlTable('deploy_log_chunks', {
  deploymentId: varchar('deployment_id', { length: 36 }).notNull().references(() => deployments.id, { onDelete: 'cascade' }),
  seq: int('seq', { unsigned: true }).notNull(),
  stream: mysqlEnum('stream', ['stdout', 'stderr', 'system']).notNull(),
  content: text('content').notNull(),
  ts: timestamp('ts', { fsp: 3 }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.deploymentId, t.seq] })]);
export const deployAudit = mysqlTable('deploy_audit', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  targetId: varchar('target_id', { length: 36 }).notNull(),
  deploymentId: varchar('deployment_id', { length: 36 }),
  actorUserId: varchar('actor_user_id', { length: 36 }).notNull(),
  action: varchar('action', { length: 24 }).notNull(),
  createdAt: timestamp('created_at', { fsp: 3 }).notNull().defaultNow(),
}, t => [index('deploy_audit_project_time_idx').on(t.projectId, t.createdAt)]);
