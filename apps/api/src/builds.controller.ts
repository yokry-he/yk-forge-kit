import { BadRequestException, Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { BuildCreateRequestSchema, BuildIdSchema, BuildListQuerySchema, BuildLogsQuerySchema } from '@forgekit/contracts';
import { BuildsService } from './builds.service';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';

export function parseBuildInput<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { return schema.parse(value); } catch { throw new BadRequestException('构建请求参数无效。'); }
}
@Controller('api/v1/projects/:id/builds')
@UseGuards(ProjectApiGuard)
export class BuildsController {
  constructor(@Inject(BuildsService) private readonly builds: BuildsService) {}
  @Post()
  trigger(@Param('id') id: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    const input = parseBuildInput(BuildCreateRequestSchema, body);
    return this.builds.trigger(parseBuildInput(BuildIdSchema, id), input.sourceRef, requireProjectAuth(req), input.environmentName);
  }
  @Get()
  list(@Param('id') id: string, @Query() query: unknown, @Req() req: ProjectAuthRequest) {
    return this.builds.list(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildListQuerySchema, query), requireProjectAuth(req));
  }
  @Get(':buildId')
  get(@Param('id') id: string, @Param('buildId') buildId: string, @Req() req: ProjectAuthRequest) {
    return this.builds.get(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, buildId), requireProjectAuth(req));
  }
  @Post(':buildId/cancel')
  cancel(@Param('id') id: string, @Param('buildId') buildId: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    if (body !== undefined && body !== null && (typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) {
      throw new BadRequestException('取消构建不接受参数。');
    }
    return this.builds.cancel(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, buildId), requireProjectAuth(req));
  }
  @Get(':buildId/logs')
  logs(@Param('id') id: string, @Param('buildId') buildId: string, @Query() query: unknown, @Req() req: ProjectAuthRequest) {
    const input = parseBuildInput(BuildLogsQuerySchema, query);
    return this.builds.logs(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, buildId), input.seq, input.limit, requireProjectAuth(req));
  }
}
