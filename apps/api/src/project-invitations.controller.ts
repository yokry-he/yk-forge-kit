import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';
import { ProjectInvitationsService } from './project-invitations.service';

@Controller('api/v1/projects/:slug/invitations')
@UseGuards(ProjectApiGuard)
export class ProjectInvitationsController {
  constructor(private readonly invitations: ProjectInvitationsService) {}

  @Get()
  list(@Param('slug') slug: string, @Req() request: ProjectAuthRequest) {
    return this.invitations.list(slug, requireProjectAuth(request));
  }

  @Post()
  create(@Param('slug') slug: string, @Body() body: unknown, @Req() request: ProjectAuthRequest) {
    return this.invitations.create(slug, parseInvitationRole(body), requireProjectAuth(request));
  }
}

@Controller('api/v1/invitations')
@UseGuards(ProjectApiGuard)
export class InvitationRedemptionController {
  constructor(private readonly invitations: ProjectInvitationsService) {}

  @Post('redeem')
  redeem(@Body() body: unknown, @Req() request: ProjectAuthRequest) {
    return this.invitations.redeem(parseInvitationCode(body), requireProjectAuth(request));
  }
}

export function parseInvitationRole(body: unknown): 'editor' | 'viewer' {
  if (!body || typeof body !== 'object' || !('role' in body) || (body.role !== 'editor' && body.role !== 'viewer')) {
    throw new BadRequestException('邀请码角色只能为 editor 或 viewer。');
  }
  return body.role;
}

export function parseInvitationCode(body: unknown): string {
  if (!body || typeof body !== 'object' || !('code' in body) || typeof body.code !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.code)) {
    throw new BadRequestException('邀请码格式无效。');
  }
  return body.code;
}
