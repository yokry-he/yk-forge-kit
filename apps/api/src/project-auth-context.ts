import { UnauthorizedException } from '@nestjs/common';
import type { AuthenticatedSubject } from '@forgekit/identity-core';

export type ProjectAuthContext = { mode: 'local' } | ({ mode: 'oidc' } & AuthenticatedSubject);
export interface ProjectAuthRequest {
  headers: { authorization?: string };
  projectAuth?: ProjectAuthContext;
}

export function requireProjectAuth(request: ProjectAuthRequest): ProjectAuthContext {
  if (!request.projectAuth) throw new UnauthorizedException('项目请求缺少身份上下文。');
  return request.projectAuth;
}
