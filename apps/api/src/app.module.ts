import { RuntimeLogsController } from './runtime-logs.controller';
import { RuntimeLogsService } from './runtime-logs.service';
import { RuntimeLogQueueService } from './runtime-log-queue.service';
import { RuntimeStreamTickets } from './runtime-stream-tickets';
import { RuntimeStreamsController } from './runtime-streams.controller';
import { RuntimeStreamsService } from './runtime-streams.service';
import { EnvironmentVariablesController } from './environment-variables.controller';
import { EnvironmentVariablesService } from './environment-variables.service';
import { DomainsController } from './domains.controller';
import { DomainsService } from './domains.service';
import { DomainQueueService } from './domain-queue.service';
import { DomainStreamsController } from './domain-streams.controller';
import { DomainStreamsService } from './domain-streams.service';
import { DomainStreamTickets } from './domain-stream-tickets';
import { DeploysController } from './deploys.controller';
import { DeploysService } from './deploys.service';
import { DeployQueueService } from './deploy-queue.service';
import { DeployStreamsController } from './deploy-streams.controller';
import { DeployStreamsService } from './deploy-streams.service';
import { DeployStreamTickets } from './deploy-stream-tickets';
import { PreviewLinksController } from './preview-links.controller';
import { PreviewLinksService } from './preview-links.service';
import { PreviewArtifactsService } from './preview-artifacts.service';
import { BuildStreamsController } from './build-streams.controller';
import { BuildStreamsService } from './build-streams.service';
import { BuildStreamTickets } from './build-stream-tickets';
import { BuildsController } from './builds.controller';
import { BuildsService } from './builds.service';
import { BuildQueueService } from './build-queue.service';
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
import { InvitationRedemptionController, ProjectInvitationsController } from './project-invitations.controller';
import { ProjectInvitationsService } from './project-invitations.service';
import { InvitationRateLimiter } from './invitation-rate-limiter';
import { IdentityAccountsService } from './identity-accounts.service';

@Module({
  controllers: [RuntimeLogsController, RuntimeStreamsController, EnvironmentVariablesController, DomainsController, DomainStreamsController, DeploysController, DeployStreamsController, PreviewLinksController, BuildStreamsController, BuildsController, HealthController, ReadyController, ProjectsController, ProjectAssetsController, ProjectMembersController, ProjectInvitationsController, InvitationRedemptionController, AuthController],
  providers: [RuntimeLogsService, RuntimeLogQueueService, RuntimeStreamTickets, RuntimeStreamsService, EnvironmentVariablesService, DomainsService, DomainQueueService, DomainStreamsService, DomainStreamTickets, DeploysService, DeployQueueService, DeployStreamsService, DeployStreamTickets, PreviewLinksService, PreviewArtifactsService, BuildStreamsService, BuildStreamTickets, BuildsService, BuildQueueService, DatabaseService, IdentityAccountsService, ProjectsService, ProjectAssetsService, ProjectMembersService, ProjectInvitationsService, InvitationRateLimiter, AuthService, ProjectApiGuard],
})
export class AppModule {}
