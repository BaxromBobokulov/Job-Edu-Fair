import { Module } from '@nestjs/common';
import { QrModule } from '../qr/qr.module';
import { SheetsSyncModule } from '../sheets/sheets.module';
import { ClickConfig } from './click.config';
import { ClickController } from './click.controller';
import { PaymentsService } from './payments.service';

@Module({
  imports: [QrModule, SheetsSyncModule],
  controllers: [ClickController],
  providers: [ClickConfig, PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
