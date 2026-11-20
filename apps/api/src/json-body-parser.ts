import type { IncomingMessage, ServerResponse } from 'node:http';
import { BadRequestException } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

export function configureJsonBodyParser(app: NestExpressApplication): void {
  // Register before Nest initializes so parse errors are sanitized before its error handler.
  app.useBodyParser('json');
  app.use((error: unknown, _request: IncomingMessage, _response: ServerResponse, next: (error?: unknown) => void) => {
    if (error instanceof SyntaxError && 'type' in error && error.type === 'entity.parse.failed') {
      next(new BadRequestException('请求体不是有效 JSON'));
      return;
    }
    next(error);
  });
}
