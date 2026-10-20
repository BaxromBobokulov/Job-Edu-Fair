import { Module } from '@nestjs/common';
import { HrScannerModule } from '../hr/hr-scanner.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminAuth } from './admin-auth';
import { AdminUpdate } from './admin.update';

@Module({
  imports: [PaymentsModule, HrScannerModule],
  providers: [AdminAuth, AdminUpdate],
})
export class AdminModule {}
