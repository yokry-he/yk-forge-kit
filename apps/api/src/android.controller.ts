import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { Readable } from 'node:stream';
import { BuildIdSchema, BuildLogsQuerySchema, AndroidConfigInputSchema, AndroidJobInputSchema } from '@forgekit/contracts';
import { parseBuildInput } from './builds.controller';
import { AndroidService } from './android.service';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';
@Controller('api/v1/projects/:id/android')
@UseGuards(ProjectApiGuard)
export class AndroidController {
  constructor(@Inject(AndroidService) private readonly android: AndroidService) {}
  @Get('config') @Header('Cache-Control', 'no-store')
  config(@Param('id') id: string, @Req() req: ProjectAuthRequest) { return this.android.config(parseBuildInput(BuildIdSchema, id), requireProjectAuth(req)); }
  @Put('config') @Header('Cache-Control', 'no-store')
  save(@Param('id') id: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    return this.android.save(parseBuildInput(BuildIdSchema, id), parseBuildInput(AndroidConfigInputSchema, body), requireProjectAuth(req));
  }
  @Delete('config') @HttpCode(204) @Header('Cache-Control', 'no-store')
  remove(@Param('id') id: string, @Req() req: ProjectAuthRequest) { return this.android.remove(parseBuildInput(BuildIdSchema, id), requireProjectAuth(req)); }
  @Post('jobs') @Header('Cache-Control', 'no-store')
  trigger(@Param('id') id: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    return this.android.trigger(parseBuildInput(BuildIdSchema, id), parseBuildInput(AndroidJobInputSchema, body), requireProjectAuth(req));
  }
  @Get('jobs') @Header('Cache-Control', 'no-store')
  list(@Param('id') id: string, @Req() req: ProjectAuthRequest) { return this.android.list(parseBuildInput(BuildIdSchema, id), requireProjectAuth(req)); }
  @Post('jobs/:jobId/cancel') @Header('Cache-Control', 'no-store')
  cancel(@Param('id') id: string, @Param('jobId') jobId: string, @Req() req: ProjectAuthRequest) {
    return this.android.cancel(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, jobId), requireProjectAuth(req));
  }
  @Get('jobs/:jobId') @Header('Cache-Control', 'no-store')
  get(@Param('id') id: string, @Param('jobId') jobId: string, @Req() req: ProjectAuthRequest) { return this.android.get(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, jobId), requireProjectAuth(req)); }
  @Get('jobs/:jobId/logs') @Header('Cache-Control', 'no-store')
  logs(@Param('id') id: string, @Param('jobId') jobId: string, @Query() query: unknown, @Req() req: ProjectAuthRequest) {
    const input = parseBuildInput(BuildLogsQuerySchema, query);
    return this.android.logs(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, jobId), input.seq, input.limit, requireProjectAuth(req));
  }
  @Get('jobs/:jobId/artifact') @Header('Cache-Control', 'no-store') @Header('X-Content-Type-Options', 'nosniff')
  async artifact(@Param('id') id: string, @Param('jobId') jobId: string, @Req() req: ProjectAuthRequest) {
    const file = await this.android.artifact(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, jobId), requireProjectAuth(req));
    return new StreamableFile(Readable.from(file.body), { type: 'application/octet-stream', length: file.size, disposition: `attachment; filename="app.${file.kind}"` });
  }
}
