import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { DatabaseService } from './database.service';
import { ReadyController } from './ready.controller';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectAssetsController } from './project-assets.controller';
import { ProjectAssetsService } from './project-assets.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ProjectApiGuard } from './project-api.guard';
import { ProjectMembersController } from './project-members.controller';
import { ProjectMembersService } from './project-members.service';

@Module({
  controllers: [HealthController, ReadyController, ProjectsController, ProjectAssetsController, ProjectMembersController, AuthController],
  providers: [DatabaseService, ProjectsService, ProjectAssetsService, ProjectMembersService, AuthService, ProjectApiGuard],
})
export class AppModule {}
