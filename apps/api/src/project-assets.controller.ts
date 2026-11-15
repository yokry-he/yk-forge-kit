import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AssetError, resolveAssets, type AssetManifest } from '@forgekit/asset-core';
import { ProjectAssetsService } from './project-assets.service';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';

@Controller('api/v1/projects/:slug/assets')
@UseGuards(ProjectApiGuard)
export class ProjectAssetsController {
  constructor(private readonly assets: ProjectAssetsService) {}

  @Get()
  list(@Param('slug') slug: string, @Req() request: ProjectAuthRequest) {
    return this.assets.list(slug, requireProjectAuth(request));
  }

  @Post()
  plan(@Param('slug') slug: string, @Body() body: unknown, @Req() request: ProjectAuthRequest) {
    const asset = parseAssetSelection(body);
    return this.assets.plan(slug, asset.id, asset.version, requireProjectAuth(request));
  }
}

export function parseAssetSelection(body: unknown): AssetManifest {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('assetId' in body) || typeof body.assetId !== 'string') {
    throw new BadRequestException('需要合法的 assetId。');
  }
  try {
    const [asset] = resolveAssets([body.assetId], 'vue-web');
    if (!asset) throw new AssetError('资产不存在。');
    return asset;
  } catch (error) {
    if (error instanceof AssetError) throw new BadRequestException(error.message);
    throw error;
  }
}
