import { BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Inject, Post, Put, Req, UseGuards } from '@nestjs/common';
import { BeginnerConfigInputSchema, BeginnerDescriptionSchema } from '@forgekit/contracts';
import { BeginnerService } from './beginner.service';
import { ProjectApiGuard } from './project-api.guard';
import { requireProjectAuth, type ProjectAuthRequest } from './project-auth-context';
function parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try { return schema.parse(value); } catch { throw new BadRequestException('新手模式请求参数无效。'); }
}
@Controller('api/v1/beginner')
@UseGuards(ProjectApiGuard)
export class BeginnerController {
  constructor(@Inject(BeginnerService) private readonly beginner: BeginnerService) {}
  @Post('classify') @HttpCode(200) @Header('Cache-Control', 'no-store')
  classify(@Body() body: unknown, @Req() req: ProjectAuthRequest) {
    const input = parse(BeginnerDescriptionSchema, body);
    return this.beginner.classify(input.description, requireProjectAuth(req));
  }
  @Get('ai-config') @Header('Cache-Control', 'no-store')
  config(@Req() req: ProjectAuthRequest) { return this.beginner.config(requireProjectAuth(req)); }
  @Put('ai-config') @Header('Cache-Control', 'no-store')
  save(@Body() body: unknown, @Req() req: ProjectAuthRequest) {
    return this.beginner.save(parse(BeginnerConfigInputSchema, body), requireProjectAuth(req));
  }
  @Delete('ai-config') @HttpCode(204) @Header('Cache-Control', 'no-store')
  remove(@Req() req: ProjectAuthRequest) { return this.beginner.remove(requireProjectAuth(req)); }
}
