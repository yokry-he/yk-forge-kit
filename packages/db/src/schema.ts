import { bigint, mysqlTable, timestamp, varchar } from 'drizzle-orm/mysql-core';

/** Initial metadata only; no user/auth schema is assumed at this stage. */
export const projects = mysqlTable('projects', {
  id: varchar('id', { length: 36 }).primaryKey(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  name: varchar('name', { length: 150 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const assetInstallations = mysqlTable('asset_installations', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  assetId: varchar('asset_id', { length: 128 }).notNull(),
  version: varchar('version', { length: 32 }).notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});
