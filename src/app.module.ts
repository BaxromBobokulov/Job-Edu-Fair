import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TelegrafModule } from 'nestjs-telegraf';
import { AdminModule } from './admin/admin.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { BotModule } from './bot/bot.module';
import { createTelegrafOptions } from './config/telegraf.config';
import { PaymentsModule } from './payments/payments.module';
import { PrismaModule } from './prisma/prisma.module';
import { RetentionModule } from './retention/retention.module';
import { SheetsModule } from './sheets/sheets.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    TelegrafModule.forRootAsync({
      inject: [ConfigService],
      useFactory: createTelegrafOptions,
    }),
    BotModule,
    PaymentsModule,
    AdminModule,
    SheetsModule,
    RetentionModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
