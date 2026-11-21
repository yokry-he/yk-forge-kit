import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { Readable } from 'node:stream';
import { BuildIdSchema, BuildLogsQuerySchema, WeappConfigInputSchema, WeappJobInputSchema } from '@forgekit/contracts';
import { parseBuildInput } from './builds.controller';
import { WeappService } from './weapp.service';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';
@Controller('api/v1/projects/:id/weapp')
@UseGuards(ProjectApiGuard)
export class WeappController {
  constructor(@Inject(WeappService) private readonly weapp: WeappService) {}
  @Get('config') @Header('Cache-Control', 'no-store')
  config(@Param('id') id: string, @Req() req: ProjectAuthRequest) { return this.weapp.config(parseBuildInput(BuildIdSchema, id), requireProjectAuth(req)); }
  @Put('config') @Header('Cache-Control', 'no-store')
  save(@Param('id') id: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    return this.weapp.save(parseBuildInput(BuildIdSchema, id), parseBuildInput(WeappConfigInputSchema, body), requireProjectAuth(req));
  }
  @Delete('config') @HttpCode(204) @Header('Cache-Control', 'no-store')
  remove(@Param('id') id: string, @Req() req: ProjectAuthRequest) { return this.weapp.remove(parseBuildInput(BuildIdSchema, id), requireProjectAuth(req)); }
  @Post('jobs') @Header('Cache-Control', 'no-store')
  trigger(@Param('id') id: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    return this.weapp.trigger(parseBuildInput(BuildIdSchema, id), parseBuildInput(WeappJobInputSchema, body), requireProjectAuth(req));
  }
  @Get('jobs') @Header('Cache-Control', 'no-store')
  list(@Param('id') id: string, @Req() req: ProjectAuthRequest) { return this.weapp.list(parseBuildInput(BuildIdSchema, id), requireProjectAuth(req)); }
  @Get('jobs/:jobId') @Header('Cache-Control', 'no-store')
  get(@Param('id') id: string, @Param('jobId') jobId: string, @Req() req: ProjectAuthRequest) { return this.weapp.get(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, jobId), requireProjectAuth(req)); }
  @Get('jobs/:jobId/logs') @Header('Cache-Control', 'no-store')
  logs(@Param('id') id: string, @Param('jobId') jobId: string, @Query() query: unknown, @Req() req: ProjectAuthRequest) {
    const input = parseBuildInput(BuildLogsQuerySchema, query);
    return this.weapp.logs(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, jobId), input.seq, input.limit, requireProjectAuth(req));
  }
  @Get('jobs/:jobId/qr') @Header('Cache-Control', 'no-store') @Header('X-Content-Type-Options', 'nosniff')
  async qr(@Param('id') id: string, @Param('jobId') jobId: string, @Req() req: ProjectAuthRequest) {
    const file = await this.weapp.qr(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, jobId), requireProjectAuth(req));
    return new StreamableFile(Readable.from(file.body), { type: 'image/jpeg', length: file.size, disposition: 'inline; filename="qrcode.jpg"' });
  }
}
