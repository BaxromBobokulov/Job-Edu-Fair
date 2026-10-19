import { Module } from '@nestjs/common';
import { ClickConfig } from './click.config';
import { ClickController } from './click.controller';
import { PaymentsService } from './payments.service';

@Module({
  controllers: [ClickController],
  providers: [ClickConfig, PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
