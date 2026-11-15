import { bigint, json, mysqlTable, timestamp, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

/** Initial metadata only; no user/auth schema is assumed at this stage. */
export const projects = mysqlTable('projects', {
  id: varchar('id', { length: 36 }).primaryKey(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  name: varchar('name', { length: 150 }).notNull(),
  template: varchar('template', { length: 32 }).notNull().default('vue-web'),
  features: json('features').$type<Array<'theme' | 'router' | 'pinia'>>().notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export const assetInstallations = mysqlTable('asset_installations', {
  id: bigint('id', { mode: 'number', unsigned: true }).autoincrement().primaryKey(),
  projectId: varchar('project_id', { length: 36 }).notNull().references(() => projects.id, { onDelete: 'cascade' }),
  assetId: varchar('asset_id', { length: 128 }).notNull(),
  version: varchar('version', { length: 32 }).notNull(),
  status: varchar('status', { length: 16 }).$type<'planned' | 'applied'>().notNull().default('planned'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [uniqueIndex('asset_installations_project_asset_unique').on(table.projectId, table.assetId)]);
