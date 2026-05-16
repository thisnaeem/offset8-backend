import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({ origin: '*' });
  app.setGlobalPrefix('api');
  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  console.log(`\n🚀 KB Processor running on http://localhost:${port}/api\n`);
}
bootstrap();
