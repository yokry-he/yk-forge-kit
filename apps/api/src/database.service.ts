import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createDatabaseClient, type DatabaseClient } from '@forgekit/db';

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private readonly client: DatabaseClient | null;

  constructor() {
    // Local UI can start before MySQL is configured. Readiness remains unavailable.
    this.client = process.env.DATABASE_URL ? createDatabaseClient(process.env.DATABASE_URL) : null;
  }

  async ping(): Promise<void> {
    if (!this.client) throw new Error('MySQL connection is not configured');
    await this.client.ping();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close();
  }
}
