import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { BuildIdSchema, PreviewLinkCreateRequestSchema } from '@forgekit/contracts';
import { parseBuildInput } from './builds.controller';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';
import { PreviewLinksService } from './preview-links.service';

@Controller('api/v1/projects/:id/builds/:buildId/preview-links')
@UseGuards(ProjectApiGuard)
export class PreviewLinksController {
  constructor(@Inject(PreviewLinksService) private readonly links: PreviewLinksService) {}
  @Post()
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  create(@Param('id') id: string, @Param('buildId') buildId: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    return this.links.create(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, buildId),
      parseBuildInput(PreviewLinkCreateRequestSchema, body ?? {}), requireProjectAuth(req));
  }
  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Param('id') id: string, @Param('buildId') buildId: string, @Req() req: ProjectAuthRequest) {
    return this.links.list(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, buildId), requireProjectAuth(req));
  }
  @Delete(':linkId')
  @HttpCode(204)
  @Header('Cache-Control', 'no-store')
  revoke(@Param('id') id: string, @Param('buildId') buildId: string, @Param('linkId') linkId: string, @Req() req: ProjectAuthRequest) {
    return this.links.revoke(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, buildId),
      parseBuildInput(BuildIdSchema, linkId), requireProjectAuth(req));
  }
}
