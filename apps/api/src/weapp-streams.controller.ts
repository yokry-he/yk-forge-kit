import type { IncomingMessage, ServerResponse } from 'node:http';
import { BadRequestException, Controller, Get, Header, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { BuildIdSchema } from '@forgekit/contracts';
import { parseBuildInput } from './builds.controller';
import { WeappService } from './weapp.service';
import { WeappStreamTickets } from './weapp-stream-tickets';
import { WeappStreamsService } from './weapp-streams.service';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';

import { streamCursor } from './build-streams.controller';
@Controller('api/v1/projects/:id/weapp/jobs/:jobId')
export class WeappStreamsController {
  constructor(@Inject(WeappService) private readonly weapp: WeappService,
    @Inject(WeappStreamTickets) private readonly tickets: WeappStreamTickets,
    @Inject(WeappStreamsService) private readonly streams: WeappStreamsService) {}
  @Post('log-stream-ticket')
  @UseGuards(ProjectApiGuard)
  @Header('Cache-Control', 'no-store')
  async ticket(@Param('id') id: string, @Param('jobId') bid: string, @Req() req: ProjectAuthRequest) {
    const projectId = parseBuildInput(BuildIdSchema, id), jobId = parseBuildInput(BuildIdSchema, bid);
    const auth = requireProjectAuth(req);
    await this.weapp.get(projectId, jobId, auth);
    return this.tickets.issue(projectId, jobId, auth);
  }
  @Get('logs/stream')
  async stream(@Param('id') id: string, @Param('jobId') bid: string, @Query() query: Record<string, unknown>,
    @Req() req: IncomingMessage & { originalUrl?: string }, @Res() response: ServerResponse) {
    // Remove the credential from request metadata before any error can reach request logging.
    // Drop the entire query, including encoded/duplicate credential keys. @Query is already parsed.
    const ticket = query.ticket;
    if ('ticket' in query) query.ticket = '[REDACTED]';
    const redact = (value: string) => value.split('?', 1)[0]!;
    if (req.url) req.url = redact(req.url);
    if (req.originalUrl) req.originalUrl = redact(req.originalUrl);
    const projectId = parseBuildInput(BuildIdSchema, id), jobId = parseBuildInput(BuildIdSchema, bid);
    const cursor = streamCursor(req.headers['last-event-id'], query.after);
    const identity = await this.tickets.take(ticket, projectId, jobId);
    await this.streams.open(identity, cursor, response);
  }
}
