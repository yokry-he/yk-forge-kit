import { Inject, BadRequestException, Body, Controller, Get, Param, Patch, Req, UseGuards } from '@nestjs/common';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';
import { ProjectMembersService } from './project-members.service';

@Controller('api/v1/projects/:slug/members')
@UseGuards(ProjectApiGuard)
export class ProjectMembersController {
  constructor(@Inject(ProjectMembersService) private readonly members: ProjectMembersService) {}

  @Get()
  list(@Param('slug') slug: string, @Req() request: ProjectAuthRequest) {
    return this.members.list(slug, requireProjectAuth(request));
  }

  @Patch(':userId')
  update(@Param('slug') slug: string, @Param('userId') userId: string, @Body() body: unknown, @Req() request: ProjectAuthRequest) {
    return this.members.updateRole(slug, userId, parseMemberRole(body), requireProjectAuth(request));
  }
}

export function parseMemberRole(body: unknown): 'editor' | 'viewer' {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('role' in body) || (body.role !== 'editor' && body.role !== 'viewer')) {
    throw new BadRequestException('仅允许将现有成员角色设为 editor 或 viewer。');
  }
  return body.role;
}
