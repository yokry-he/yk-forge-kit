import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { eq, desc } from 'drizzle-orm';
import { projects } from '@forgekit/db';
import { DatabaseService } from './database.service';

export interface CreateProjectInput {
  name: string;
  template: 'vue-web';
  features: Array<'theme' | 'router' | 'pinia'>;
}

@Injectable()
export class ProjectsService {
  constructor(private readonly database: DatabaseService) {}

  async create(input: CreateProjectInput) {
    const db = this.database.db;
    try {
      await db.insert(projects).values({
        id: randomUUID(),
        slug: input.name,
        name: input.name,
        template: input.template,
        features: input.features,
      });
    } catch (error) {
      // mysql2 errors may be wrapped by Drizzle. Only translate the known unique constraint error.
      if (hasMysqlCode(error, 'ER_DUP_ENTRY')) throw new ConflictException('项目名称已存在。');
      throw error;
    }
    return this.findBySlug(input.name);
  }

  async list() {
    return this.database.db.select().from(projects).orderBy(desc(projects.createdAt), desc(projects.id)).limit(50);
  }

  async findBySlug(slug: string) {
    const [project] = await this.database.db.select().from(projects).where(eq(projects.slug, slug)).limit(1);
    if (!project) throw new NotFoundException('项目不存在。');
    return project;
  }
}

function hasMysqlCode(error: unknown, code: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; cause?: unknown };
  return value.code === code || (value.cause !== error && hasMysqlCode(value.cause, code));
}
