import * as dotenv from 'dotenv';
dotenv.config();

import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './modules/app.module';
import { join } from 'path';
import { ValidationPipe } from '@nestjs/common';
import helmet from 'helmet';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { getUploadsRootPath } from './common/utils/upload-path.util';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  app.setGlobalPrefix('api');

  // Filtro de seguridad para acceso a imágenes: bloquea bóveda, buzón y archivos cifrados
  app.use('/api/images', (req, res, next) => {
    const rawPath = (req.path || '').toLowerCase();
    if (
      rawPath.includes('vault') ||
      rawPath.includes('quarantine') ||
      rawPath.includes('inbox') ||
      rawPath.endsWith('.enc') ||
      rawPath.endsWith('.pdf')
    ) {
      return res.status(403).json({ statusCode: 403, message: 'Acceso no autorizado' });
    }
    next();
  });

  // Exponer directorio de uploads (backend/uploads)
  app.useStaticAssets(getUploadsRootPath(), {
    prefix: '/api/images/',
  });

  // Habilitar cabeceras de seguridad permitiendo recursos cross-origin
  app.use(
    helmet({
      crossOriginResourcePolicy: false,
    }),
  );

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableCors({
    origin: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'Origin',
      'x-api-key',
      'x-company-id',
      'x-tenant-id',
      'x-requested-with',
      'cache-control',
    ],
    credentials: true,
  });

  const port = Number(process.env.PORT) || 5002;
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen(port, host);

  console.log(
    `🚀 Server running on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`,
  );
}

bootstrap();
