import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureJsonBodyParser } from './json-body-parser';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureJsonBodyParser(app);
  app.enableShutdownHooks();
  app.enableCors({ origin: process.env.CONSOLE_ORIGIN ?? 'http://localhost:5173' });
  // Development defaults to loopback until authentication is in place.
  await app.listen(Number(process.env.PORT ?? 3001), process.env.API_HOST ?? '127.0.0.1');
}

bootstrap().catch((error: unknown) => {
  console.error('YKForgeKit API failed to start', error);
  process.exitCode = 1;
});
