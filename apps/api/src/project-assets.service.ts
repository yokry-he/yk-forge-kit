import { ConflictException, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { assetInstallations } from '@forgekit/db';
import { DatabaseService } from './database.service';
import { ProjectsService } from './projects.service';

@Injectable()
export class ProjectAssetsService {
  constructor(private readonly database: DatabaseService, private readonly projects: ProjectsService) {}

  async list(slug: string) {
    const project = await this.projects.findBySlug(slug);
    return this.database.db.select().from(assetInstallations)
      .where(eq(assetInstallations.projectId, project.id));
  }

  /** Records intent only. No source files are changed, and applied status cannot be set via HTTP. */
  async plan(slug: string, assetId: string, version: string) {
    const project = await this.projects.findBySlug(slug);
    const db = this.database.db;
    const where = and(eq(assetInstallations.projectId, project.id), eq(assetInstallations.assetId, assetId));
    const [existing] = await db.select().from(assetInstallations).where(where).limit(1);
    if (existing) {
      if (existing.version !== version) throw new ConflictException('该项目已记录其他版本的资产，请先处理升级。');
      return existing;
    }
    try {
      await db.insert(assetInstallations).values({ projectId: project.id, assetId, version, status: 'planned' });
    } catch (error) {
      if (!hasDuplicateKey(error)) throw error;
    }
    // Re-read after insert or concurrent unique-key collision.
    const [saved] = await db.select().from(assetInstallations).where(where).limit(1);
    if (!saved || saved.version !== version) throw new ConflictException('资产计划发生并发冲突，请刷新后重试。');
    return saved;
  }
}

function hasDuplicateKey(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; cause?: unknown };
  return value.code === 'ER_DUP_ENTRY' || (value.cause !== error && hasDuplicateKey(value.cause));
}
