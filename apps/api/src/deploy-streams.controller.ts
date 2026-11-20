import type { IncomingMessage, ServerResponse } from 'node:http';
import { BadRequestException, Controller, Get, Header, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { BuildIdSchema } from '@forgekit/contracts';
import { parseBuildInput } from './builds.controller';
import { DeploysService } from './deploys.service';
import { DeployStreamTickets } from './deploy-stream-tickets';
import { DeployStreamsService } from './deploy-streams.service';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';

import { streamCursor } from './build-streams.controller';
@Controller('api/v1/projects/:id/deployments/:deploymentId')
export class DeployStreamsController {
  constructor(@Inject(DeploysService) private readonly deploys: DeploysService,
    @Inject(DeployStreamTickets) private readonly tickets: DeployStreamTickets,
    @Inject(DeployStreamsService) private readonly streams: DeployStreamsService) {}
  @Post('log-stream-ticket')
  @UseGuards(ProjectApiGuard)
  @Header('Cache-Control', 'no-store')
  async ticket(@Param('id') id: string, @Param('deploymentId') bid: string, @Req() req: ProjectAuthRequest) {
    const projectId = parseBuildInput(BuildIdSchema, id), deploymentId = parseBuildInput(BuildIdSchema, bid);
    const auth = requireProjectAuth(req);
    await this.deploys.get(projectId, deploymentId, auth);
    return this.tickets.issue(projectId, deploymentId, auth);
  }
  @Get('logs/stream')
  async stream(@Param('id') id: string, @Param('deploymentId') bid: string, @Query() query: Record<string, unknown>,
    @Req() req: IncomingMessage & { originalUrl?: string }, @Res() response: ServerResponse) {
    // Remove the credential from request metadata before any error can reach request logging.
    // Drop the entire query, including encoded/duplicate credential keys. @Query is already parsed.
    const ticket = query.ticket;
    if ('ticket' in query) query.ticket = '[REDACTED]';
    const redact = (value: string) => value.split('?', 1)[0]!;
    if (req.url) req.url = redact(req.url);
    if (req.originalUrl) req.originalUrl = redact(req.originalUrl);
    const projectId = parseBuildInput(BuildIdSchema, id), deploymentId = parseBuildInput(BuildIdSchema, bid);
    const cursor = streamCursor(req.headers['last-event-id'], query.after);
    const identity = await this.tickets.take(ticket, projectId, deploymentId);
    await this.streams.open(identity, cursor, response);
  }
}
