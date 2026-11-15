import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { DatabaseService } from './database.service';

@Controller('api/v1')
export class ReadyController {
  constructor(private readonly database: DatabaseService) {}

  @Get('ready')
  async ready(): Promise<{ status: 'ready'; database: 'ok' }> {
    try {
      await this.database.ping();
      return { status: 'ready', database: 'ok' };
    } catch {
      // Never expose raw driver errors, DB URLs or credentials in API responses.
      throw new ServiceUnavailableException({ status: 'unavailable', database: 'unavailable' });
    }
  }
}
