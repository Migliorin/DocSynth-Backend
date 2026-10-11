import { Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { DocumentsModule } from './documents/documents.module.js';
import { AuthModule } from './auth/auth.module.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();
const observeCredentials =
  process.env.OBSERVE_APP_KEY && process.env.OBSERVE_APP_SECRET
    ? {
        appKey: process.env.OBSERVE_APP_KEY,
        appSecret: process.env.OBSERVE_APP_SECRET,
        serviceId: 'backend',
      }
    : null;
export const observeEnabled = observeCredentials !== null;

@Module({
  imports: [
    PrismaModule,
    DocumentsModule,
    AuthModule,
    ...(observeCredentials
      ? [ObserveModule.forRoot(observeCredentials)]
      : []),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
