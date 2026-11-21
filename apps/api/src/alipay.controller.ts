import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Post, Put, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { Readable } from 'node:stream';
import { BuildIdSchema, BuildLogsQuerySchema, AlipayConfigInputSchema, AlipayJobInputSchema } from '@forgekit/contracts';
import { parseBuildInput } from './builds.controller';
import { AlipayService } from './alipay.service';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';
@Controller('api/v1/projects/:id/alipay')
@UseGuards(ProjectApiGuard)
export class AlipayController {
  constructor(@Inject(AlipayService) private readonly alipay: AlipayService) {}
  @Get('config') @Header('Cache-Control', 'no-store')
  config(@Param('id') id: string, @Req() req: ProjectAuthRequest) { return this.alipay.config(parseBuildInput(BuildIdSchema, id), requireProjectAuth(req)); }
  @Put('config') @Header('Cache-Control', 'no-store')
  save(@Param('id') id: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    return this.alipay.save(parseBuildInput(BuildIdSchema, id), parseBuildInput(AlipayConfigInputSchema, body), requireProjectAuth(req));
  }
  @Delete('config') @HttpCode(204) @Header('Cache-Control', 'no-store')
  remove(@Param('id') id: string, @Req() req: ProjectAuthRequest) { return this.alipay.remove(parseBuildInput(BuildIdSchema, id), requireProjectAuth(req)); }
  @Post('jobs') @Header('Cache-Control', 'no-store')
  trigger(@Param('id') id: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    return this.alipay.trigger(parseBuildInput(BuildIdSchema, id), parseBuildInput(AlipayJobInputSchema, body), requireProjectAuth(req));
  }
  @Get('jobs') @Header('Cache-Control', 'no-store')
  list(@Param('id') id: string, @Req() req: ProjectAuthRequest) { return this.alipay.list(parseBuildInput(BuildIdSchema, id), requireProjectAuth(req)); }
  @Get('jobs/:jobId') @Header('Cache-Control', 'no-store')
  get(@Param('id') id: string, @Param('jobId') jobId: string, @Req() req: ProjectAuthRequest) { return this.alipay.get(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, jobId), requireProjectAuth(req)); }
  @Get('jobs/:jobId/logs') @Header('Cache-Control', 'no-store')
  logs(@Param('id') id: string, @Param('jobId') jobId: string, @Query() query: unknown, @Req() req: ProjectAuthRequest) {
    const input = parseBuildInput(BuildLogsQuerySchema, query);
    return this.alipay.logs(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, jobId), input.seq, input.limit, requireProjectAuth(req));
  }
  @Get('jobs/:jobId/qr') @Header('Cache-Control', 'no-store') @Header('X-Content-Type-Options', 'nosniff')
  async qr(@Param('id') id: string, @Param('jobId') jobId: string, @Req() req: ProjectAuthRequest) {
    const file = await this.alipay.qr(parseBuildInput(BuildIdSchema, id), parseBuildInput(BuildIdSchema, jobId), requireProjectAuth(req));
    return new StreamableFile(Readable.from(file.body), { type: file.type, length: file.size, disposition: 'inline; filename="qrcode.img"' });
  }
}
