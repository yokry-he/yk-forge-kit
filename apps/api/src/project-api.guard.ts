import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { allowUnauthenticatedProjectRoutes, resolveAuthConfig } from './auth.config';

@Injectable()
export class ProjectApiGuard implements CanActivate {
  private readonly localOnly = allowUnauthenticatedProjectRoutes(resolveAuthConfig(process.env));

  canActivate(_context: ExecutionContext): boolean {
    if (!this.localOnly) {
      // Safe default until trusted subject -> membership -> action checks exist.
      throw new ForbiddenException('项目资源授权尚未启用，暂不开放访问。');
    }
    return true;
  }
}
