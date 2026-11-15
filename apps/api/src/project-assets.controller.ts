import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { AssetError, resolveAssets, type AssetManifest } from '@forgekit/asset-core';
import { ProjectAssetsService } from './project-assets.service';

@Controller('api/v1/projects/:slug/assets')
export class ProjectAssetsController {
  constructor(private readonly assets: ProjectAssetsService) {}

  @Get()
  list(@Param('slug') slug: string) {
    return this.assets.list(slug);
  }

  @Post()
  plan(@Param('slug') slug: string, @Body() body: unknown) {
    const asset = parseAssetSelection(body);
    return this.assets.plan(slug, asset.id, asset.version);
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
