import { Module } from '@nestjs/common';
import { PaymentsModule } from '../payments/payments.module';
import { AdminAuth } from './admin-auth';
import { AdminUpdate } from './admin.update';

@Module({
  imports: [PaymentsModule],
  providers: [AdminAuth, AdminUpdate],
})
export class AdminModule {}
