import { Inject, CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { resolveAuthConfig } from './auth.config';
import { AuthService } from './auth.service';
import type { ProjectAuthRequest } from './project-auth-context';

@Injectable()
export class ProjectApiGuard implements CanActivate {
  private readonly mode = resolveAuthConfig(process.env).mode;
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ProjectAuthRequest>();
    if (this.mode === 'local') {
      request.projectAuth = { mode: 'local' };
    } else {
      const subject = await this.auth.authenticate(request.headers.authorization);
      request.projectAuth = { mode: 'oidc', ...subject };
    }
    return true;
  }
}
