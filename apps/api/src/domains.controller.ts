import { Body, Controller, Delete, Get, Header, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { BuildIdSchema, BuildLogsQuerySchema, DomainCreateSchema, EmptyDeployRequestSchema } from '@forgekit/contracts';
import { parseBuildInput } from './builds.controller';
import { DomainsService } from './domains.service';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';
const id = (value: string) => parseBuildInput(BuildIdSchema, value);
@Controller('api/v1/projects/:id')
@UseGuards(ProjectApiGuard)
export class DomainsController {
  constructor(@Inject(DomainsService) private readonly domains: DomainsService) {}
  @Header('Cache-Control', 'no-store')
  @Get('domains') list(@Param('id') pid: string, @Req() req: ProjectAuthRequest) { return this.domains.list(id(pid), requireProjectAuth(req)); }
  @Header('Cache-Control', 'no-store')
  @Post('domains') create(@Param('id') pid: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    return this.domains.create(id(pid), parseBuildInput(DomainCreateSchema, body), requireProjectAuth(req));
  }
  @Header('Cache-Control', 'no-store')
  @Post('domains/:domainId/verify') verify(@Param('id') pid: string, @Param('domainId') did: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    parseBuildInput(EmptyDeployRequestSchema, body ?? {});
    return this.domains.request(id(pid), id(did), 'verify', requireProjectAuth(req));
  }
  @Header('Cache-Control', 'no-store')
  @Post('domains/:domainId/refresh') refresh(@Param('id') pid: string, @Param('domainId') did: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    parseBuildInput(EmptyDeployRequestSchema, body ?? {});
    return this.domains.request(id(pid), id(did), 'refresh', requireProjectAuth(req));
  }
  // Removal is asynchronous. The global claim is released only after the remote route has been removed.
  @Header('Cache-Control', 'no-store')
  @Delete('domains/:domainId') remove(@Param('id') pid: string, @Param('domainId') did: string, @Req() req: ProjectAuthRequest) {
    return this.domains.request(id(pid), id(did), 'remove', requireProjectAuth(req));
  }
  @Header('Cache-Control', 'no-store')
  @Get('domain-operations') operations(@Param('id') pid: string, @Req() req: ProjectAuthRequest) { return this.domains.operations(id(pid), requireProjectAuth(req)); }
  @Header('Cache-Control', 'no-store')
  @Get('domain-operations/:operationId') get(@Param('id') pid: string, @Param('operationId') oid: string, @Req() req: ProjectAuthRequest) { return this.domains.get(id(pid), id(oid), requireProjectAuth(req)); }
  @Header('Cache-Control', 'no-store')
  @Get('domain-operations/:operationId/logs') logs(@Param('id') pid: string, @Param('operationId') oid: string, @Query() query: unknown, @Req() req: ProjectAuthRequest) {
    const input = parseBuildInput(BuildLogsQuerySchema, query);
    return this.domains.logs(id(pid), id(oid), input.seq, input.limit, requireProjectAuth(req));
  }
}
