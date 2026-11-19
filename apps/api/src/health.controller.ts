import { Controller, Get } from '@nestjs/common';
import type { HealthResponse } from '@forgekit/contracts';

@Controller('api/v1')
export class HealthController {
  @Get('health')
  health(): HealthResponse {
    return { status: 'ok', service: 'forgekit-api', timestamp: new Date().toISOString() };
  }
}
