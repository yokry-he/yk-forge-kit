import { Controller, Get, Headers } from '@nestjs/common';
import { AuthService } from './auth.service';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Identity check only. It does not authorize access to any project. */
  @Get('whoami')
  whoami(@Headers('authorization') authorization: string | undefined) {
    return this.auth.whoami(authorization);
  }
}
