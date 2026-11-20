import { Body, Controller, Delete, Get, Header, HttpCode, Inject, Param, Put, Req, UseGuards } from '@nestjs/common';
import { BuildIdSchema, EnvironmentNameSchema, VariableInputSchema, VariableNameSchema } from '@forgekit/contracts';
import { parseBuildInput } from './builds.controller';
import { EnvironmentVariablesService } from './environment-variables.service';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';
@Controller('api/v1/projects/:id/environments')
@UseGuards(ProjectApiGuard)
export class EnvironmentVariablesController {
  constructor(@Inject(EnvironmentVariablesService) private readonly variables: EnvironmentVariablesService) {}
  @Get() @Header('Cache-Control', 'no-store')
  environments(@Param('id') id: string, @Req() req: ProjectAuthRequest) {
    return this.variables.environments(parseBuildInput(BuildIdSchema, id), requireProjectAuth(req));
  }
  @Get(':environment/variables') @Header('Cache-Control', 'no-store')
  list(@Param('id') id: string, @Param('environment') environment: string, @Req() req: ProjectAuthRequest) {
    return this.variables.list(parseBuildInput(BuildIdSchema, id), parseBuildInput(EnvironmentNameSchema, environment), requireProjectAuth(req));
  }
  @Get(':environment/variables/:name') @Header('Cache-Control', 'no-store')
  get(@Param('id') id: string, @Param('environment') environment: string, @Param('name') name: string, @Req() req: ProjectAuthRequest) {
    return this.variables.get(parseBuildInput(BuildIdSchema, id), parseBuildInput(EnvironmentNameSchema, environment),
      parseBuildInput(VariableNameSchema, name), requireProjectAuth(req));
  }
  @Put(':environment/variables/:name') @Header('Cache-Control', 'no-store')
  save(@Param('id') id: string, @Param('environment') environment: string, @Param('name') name: string, @Body() body: unknown, @Req() req: ProjectAuthRequest) {
    return this.variables.save(parseBuildInput(BuildIdSchema, id), parseBuildInput(EnvironmentNameSchema, environment),
      parseBuildInput(VariableNameSchema, name), parseBuildInput(VariableInputSchema, body), requireProjectAuth(req));
  }
  @Delete(':environment/variables/:name') @HttpCode(204) @Header('Cache-Control', 'no-store')
  remove(@Param('id') id: string, @Param('environment') environment: string, @Param('name') name: string, @Req() req: ProjectAuthRequest) {
    return this.variables.remove(parseBuildInput(BuildIdSchema, id), parseBuildInput(EnvironmentNameSchema, environment),
      parseBuildInput(VariableNameSchema, name), requireProjectAuth(req));
  }
}
