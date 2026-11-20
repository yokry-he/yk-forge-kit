import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { BuildIdSchema, BuildLogsQuerySchema, DeployCreateSchema, EmptyDeployRequestSchema, DeployTargetCreateSchema, DeployTargetUpdateSchema } from '@forgekit/contracts';
import { parseBuildInput } from './builds.controller';
import { DeploysService } from './deploys.service';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';
const id = (value: string) => parseBuildInput(BuildIdSchema, value);

@Controller('api/v1/projects/:id')
@UseGuards(ProjectApiGuard)
export class DeploysController {
  constructor(@Inject(DeploysService) private readonly deploys: DeploysService) {}
  @Header('Cache-Control', 'no-store')
  @Get('deploy-targets') listTargets(@Param('id') pid: string, @Req() req: ProjectAuthRequest) {
    return this.deploys.listTargets(id(pid), requireProjectAuth(req));
  }
  @Header('Cache-Control', 'no-store')
  @Post('deploy-targets') createTarget(@Param('id') pid: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    return this.deploys.saveTarget(id(pid), undefined, parseBuildInput(DeployTargetCreateSchema, body), requireProjectAuth(req));
  }
  @Header('Cache-Control', 'no-store')
  @Patch('deploy-targets/:targetId') updateTarget(@Param('id') pid: string, @Param('targetId') tid: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    return this.deploys.saveTarget(id(pid), id(tid), parseBuildInput(DeployTargetUpdateSchema, body), requireProjectAuth(req));
  }
  @Delete('deploy-targets/:targetId') @HttpCode(204)
  removeTarget(@Param('id') pid: string, @Param('targetId') tid: string, @Req() req: ProjectAuthRequest) {
    return this.deploys.removeTarget(id(pid), id(tid), requireProjectAuth(req));
  }
  @Get('deployments') list(@Param('id') pid: string, @Req() req: ProjectAuthRequest) { return this.deploys.list(id(pid), requireProjectAuth(req)); }
  @Post('deployments') trigger(@Param('id') pid: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    const input = parseBuildInput(DeployCreateSchema, body);
    return this.deploys.trigger(id(pid), input.buildId, input.deployTargetId, requireProjectAuth(req));
  }
  @Get('deployments/:deploymentId') get(@Param('id') pid: string, @Param('deploymentId') did: string, @Req() req: ProjectAuthRequest) {
    return this.deploys.get(id(pid), id(did), requireProjectAuth(req));
  }
  @Post('deployments/:deploymentId/rollback') rollback(@Param('id') pid: string, @Param('deploymentId') did: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    parseBuildInput(EmptyDeployRequestSchema, body ?? {});
    return this.deploys.rollback(id(pid), id(did), requireProjectAuth(req));
  }
  @Get('deployments/:deploymentId/logs') logs(@Param('id') pid: string, @Param('deploymentId') did: string, @Query() query: unknown, @Req() req: ProjectAuthRequest) {
    const input = parseBuildInput(BuildLogsQuerySchema, query);
    return this.deploys.logs(id(pid), id(did), input.seq, input.limit, requireProjectAuth(req));
  }
}
