import { BadRequestException, Body, Controller, Get, Param, Post } from '@nestjs/common';
import { normalizeProjectOptions, ProjectValidationError, type ProjectOptions } from '@forgekit/project-core';
import { ProjectsService } from './projects.service';

@Controller('api/v1/projects')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get()
  list() {
    return this.projects.list();
  }

  @Get(':slug')
  find(@Param('slug') slug: string) {
    return this.projects.findBySlug(slug);
  }

  @Post()
  create(@Body() value: unknown) {
    return this.projects.create(parseCreateProject(value));
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
