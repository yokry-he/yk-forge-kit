import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { normalizeProjectOptions, ProjectValidationError, type ProjectOptions } from '@forgekit/project-core';
import { ProjectsService } from './projects.service';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';

@Controller('api/v1/projects')
@UseGuards(ProjectApiGuard)
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list(@Req() request: ProjectAuthRequest) {
    return this.projects.list(requireProjectAuth(request));
  }

  @Get(':slug')
  find(@Param('slug') slug: string, @Req() request: ProjectAuthRequest) {
    return this.projects.findBySlug(slug, requireProjectAuth(request));
  }

  @Post()
  create(@Body() value: unknown, @Req() request: ProjectAuthRequest) {
    return this.projects.create(parseCreateProject(value), requireProjectAuth(request));
  }
}

/** Validate the untrusted HTTP payload before it reaches the persistence layer. */
export function parseCreateProject(value: unknown): ProjectOptions {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('请求体必须是项目配置对象。');
    const input = value as Record<string, unknown>;
    if (typeof input.name !== 'string' || input.template !== 'vue-web' || !Array.isArray(input.features)) {
      throw new BadRequestException('项目名称、模板或能力配置格式不正确。');
    }
    if (input.features.some((feature) => typeof feature !== 'string')) throw new BadRequestException('项目能力格式不正确。');
    try {
      return normalizeProjectOptions(input as unknown as ProjectOptions);
    } catch (error) {
      if (error instanceof ProjectValidationError) throw new BadRequestException(error.message);
      throw error;
    }
}
