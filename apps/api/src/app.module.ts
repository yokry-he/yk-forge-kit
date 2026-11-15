import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DatabaseService } from './database.service';
import { ReadyController } from './ready.controller';

@Module({ controllers: [HealthController, ReadyController], providers: [DatabaseService] })
export class AppModule {}
