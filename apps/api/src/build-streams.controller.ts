import type { IncomingMessage, ServerResponse } from 'node:http';
import { BadRequestException, Controller, Get, Header, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { BuildIdSchema } from '@forgekit/contracts';
import { resolveAuthConfig } from './auth.config';
import { parseBuildInput } from './builds.controller';
import { BuildsService } from './builds.service';
import { BuildStreamTickets } from './build-stream-tickets';
import { BuildStreamsService } from './build-streams.service';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';

export function streamCursor(header: unknown, after: unknown): number {
  const value = header ?? after ?? '0';
  if (typeof value !== 'string' || !/^\d+$/.test(value) || Number(value) > 4294967295) throw new BadRequestException('日志游标无效。');
  return Number(value);
}
@Controller('api/v1/projects/:id/builds/:buildId')
export class BuildStreamsController {
  private readonly mode = resolveAuthConfig(process.env).mode;
  constructor(@Inject(BuildsService) private readonly builds: BuildsService,
    @Inject(BuildStreamTickets) private readonly tickets: BuildStreamTickets,
    @Inject(BuildStreamsService) private readonly streams: BuildStreamsService) {}
  @Post('log-stream-ticket')
  @UseGuards(ProjectApiGuard)
  @Header('Cache-Control', 'no-store')
  async ticket(@Param('id') id: string, @Param('buildId') bid: string, @Req() req: ProjectAuthRequest) {
    const projectId = parseBuildInput(BuildIdSchema, id), buildId = parseBuildInput(BuildIdSchema, bid);
    const auth = requireProjectAuth(req);
    await this.builds.get(projectId, buildId, auth);
    return this.tickets.issue(projectId, buildId, auth);
  }
  @Get('logs/stream')
  async stream(@Param('id') id: string, @Param('buildId') bid: string, @Query() query: Record<string, unknown>,
    @Req() req: IncomingMessage & { originalUrl?: string }, @Res() response: ServerResponse) {
    // Remove the credential from request metadata before any error can reach request logging.
    // Drop the entire query, including encoded/duplicate credential keys. @Query is already parsed.
    const ticket = query.ticket;
    if ('ticket' in query) query.ticket = '[REDACTED]';
    const redact = (value: string) => value.split('?', 1)[0]!;
    if (req.url) req.url = redact(req.url);
    if (req.originalUrl) req.originalUrl = redact(req.originalUrl);
    const projectId = parseBuildInput(BuildIdSchema, id), buildId = parseBuildInput(BuildIdSchema, bid);
    const cursor = streamCursor(req.headers['last-event-id'], query.after);
    const identity = this.mode === 'local' ? { projectId, buildId, auth: { mode: 'local' as const }, expires: Date.now() + 60_000 }
      : await this.tickets.take(ticket, projectId, buildId);
    await this.streams.open(identity, cursor, response);
  }
}
