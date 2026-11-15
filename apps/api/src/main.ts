import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: process.env.CONSOLE_ORIGIN ?? 'http://localhost:5173' });
  await app.listen(Number(process.env.PORT ?? 3001), '0.0.0.0');
}

bootstrap().catch((error: unknown) => {
  console.error('ForgeKit API failed to start', error);
  process.exitCode = 1;
});
