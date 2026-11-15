import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  app.enableCors({ origin: process.env.CONSOLE_ORIGIN ?? 'http://localhost:5173' });
  // Development defaults to loopback until authentication is in place.
  await app.listen(Number(process.env.PORT ?? 3001), process.env.API_HOST ?? '127.0.0.1');
}

bootstrap().catch((error: unknown) => {
  console.error('ForgeKit API failed to start', error);
  process.exitCode = 1;
});
