import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { BuildIdSchema, BuildLogsQuerySchema, RuntimeLogInputSchema } from '@forgekit/contracts';
import { parseBuildInput } from './builds.controller';
import { RuntimeLogsService } from './runtime-logs.service';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';
const id = (value: string) => parseBuildInput(BuildIdSchema, value);
@Controller('api/v1/projects/:id/runtime-log-sessions')
@UseGuards(ProjectApiGuard)
export class RuntimeLogsController {
  constructor(@Inject(RuntimeLogsService) private readonly sessions: RuntimeLogsService) {}
  @Post()
  @Header('Cache-Control', 'no-store')
  create(@Param('id') pid: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    return this.sessions.create(id(pid), parseBuildInput(RuntimeLogInputSchema, body), requireProjectAuth(req));
  }
  @Get(':sessionId')
  @Header('Cache-Control', 'no-store')
  get(@Param('id') pid: string, @Param('sessionId') sid: string, @Req() req: ProjectAuthRequest) {
    return this.sessions.get(id(pid), id(sid), requireProjectAuth(req), true);
  }
  @Delete(':sessionId')
  @HttpCode(204)
  cancel(@Param('id') pid: string, @Param('sessionId') sid: string, @Req() req: ProjectAuthRequest) {
    return this.sessions.cancel(id(pid), id(sid), requireProjectAuth(req));
  }
  @Get(':sessionId/logs')
  @Header('Cache-Control', 'no-store')
  logs(@Param('id') pid: string, @Param('sessionId') sid: string, @Query() query: unknown, @Req() req: ProjectAuthRequest) {
    const input = parseBuildInput(BuildLogsQuerySchema, query);
    return this.sessions.logs(id(pid), id(sid), input.seq, input.limit, requireProjectAuth(req));
  }
}
