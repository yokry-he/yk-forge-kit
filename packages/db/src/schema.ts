import { bigint, index, json, mysqlTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

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

export const assetInstallations = mysqlTable('asset_installations', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  assetId: varchar('asset_id', { length: 128 }).notNull(),
  version: varchar('version', { length: 32 }).notNull(),
  status: varchar('status', { length: 16 }).$type<'planned' | 'applied'>().notNull().default('planned'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('asset_installations_project_asset_unique').on(table.projectId, table.assetId)]);
