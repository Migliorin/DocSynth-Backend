import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import { AppModule, ObserveInstrument, observeEnabled } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    ...(observeEnabled ? { instrument: ObserveInstrument } : {}),
  });
  app.enableCors({ origin: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5173' });

  const openApiConfig = new DocumentBuilder()
    .setTitle('DocSynth API')
    .setDescription(
      'Upload de PDFs, acompanhamento da extração OCR em segundo plano e download do Markdown.',
    )
    .setVersion('1.0.0')
    .addTag('documents', 'Upload e download de documentos PDF')
    .addTag('auth', 'Cadastro e autenticação de usuários')
    .addBearerAuth()
    .build();
  const openApiDocument = SwaggerModule.createDocument(app, openApiConfig);
  app.use('/docs', apiReference({ content: openApiDocument }));

  await app.listen(process.env.PORT ?? 3000);
}
await bootstrap();
