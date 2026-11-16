import { Controller, Get, Headers, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { IdentityAccountsService } from './identity-accounts.service';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly accounts: IdentityAccountsService) {}

  /** Identity check only. It does not authorize access to any project. */
  @Get('whoami')
  whoami(@Headers('authorization') authorization: string | undefined) {
    return this.auth.whoami(authorization);
  }

  /** Idempotent explicit enrollment; a signed-in browser alone cannot create a user. */
  @Post('account')
  async initializeAccount(@Headers('authorization') authorization: string | undefined) {
    const identity = await this.auth.authenticate(authorization);
    return this.accounts.initializeAccount({ mode: 'oidc', ...identity });
  }
}
