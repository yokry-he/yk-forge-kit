import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DatabaseService } from './database.service';
import { ReadyController } from './ready.controller';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({ controllers: [HealthController, ReadyController, ProjectsController], providers: [DatabaseService, ProjectsService] })
export class AppModule {}
