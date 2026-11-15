import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DatabaseService } from './database.service';
import { ReadyController } from './ready.controller';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectAssetsController } from './project-assets.controller';
import { ProjectAssetsService } from './project-assets.service';

@Module({
  controllers: [HealthController, ReadyController, ProjectsController, ProjectAssetsController],
  providers: [DatabaseService, ProjectsService, ProjectAssetsService],
})
export class AppModule {}
