import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { getAssetVersionStatus } from '@forgekit/asset-core';
import { and, eq } from 'drizzle-orm';
import { assetInstallations } from '@forgekit/db';
import { DatabaseService } from './database.service';
import { ProjectsService } from './projects.service';
import type { ProjectAuthContext } from './project-auth-context';

@Injectable()
export class ProjectAssetsService {
  constructor(private readonly database: DatabaseService, private readonly projects: ProjectsService) {}

  async list(slug: string, auth: ProjectAuthContext) {
    const project = await this.projects.findBySlug(slug, auth, 'asset:read');
    return this.database.db.select().from(assetInstallations)
      .where(eq(assetInstallations.projectId, project.id));
  }

  /** Records intent only. No source files are changed, and applied status cannot be set via HTTP. */
  async plan(slug: string, assetId: string, version: string, auth: ProjectAuthContext) {
    const project = await this.projects.findBySlug(slug, auth, 'asset:plan');
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

  /** Compare-and-swap desired version only; never claims any local files were upgraded. */
  async upgradePlan(slug: string, assetId: string, expectedVersion: string, targetVersion: string, auth: ProjectAuthContext) {
    const project = await this.projects.findBySlug(slug, auth, 'asset:plan');
    const db = this.database.db;
    const where = and(eq(assetInstallations.projectId, project.id), eq(assetInstallations.assetId, assetId));
    const [existing] = await db.select().from(assetInstallations).where(where).limit(1);
    if (!existing) throw new NotFoundException('资产计划不存在，请先登记。');
    if (existing.version !== expectedVersion) throw new ConflictException('资产登记版本已变化，请刷新后重试。');
    if (existing.status !== 'planned') throw new ConflictException('历史安装标记不可通过计划升级接口修改。');
    if (getAssetVersionStatus(assetId, expectedVersion) !== 'upgrade-available' || expectedVersion === targetVersion) {
      throw new ConflictException('该资产没有受支持的计划升级路径。');
    }
    const [result] = await db.update(assetInstallations).set({ version: targetVersion })
      .where(and(where, eq(assetInstallations.version, expectedVersion), eq(assetInstallations.status, 'planned')));
    if (result.affectedRows !== 1) throw new ConflictException('资产计划已被其他操作修改，请刷新后重试。');
    const [updated] = await db.select().from(assetInstallations).where(where).limit(1);
    if (!updated) throw new ConflictException('升级后无法读取资产计划。');
    return updated;
  }
}

function hasDuplicateKey(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { code?: unknown; cause?: unknown };
  return value.code === 'ER_DUP_ENTRY' || (value.cause !== error && hasDuplicateKey(value.cause));
}
