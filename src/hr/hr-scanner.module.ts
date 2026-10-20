import { Module } from '@nestjs/common';
import { QrModule } from '../qr/qr.module';
import { SheetsSyncModule } from '../sheets/sheets.module';
import { HrScannerService } from './hr-scanner.service';

@Module({
  imports: [QrModule, SheetsSyncModule],
  providers: [HrScannerService],
  exports: [HrScannerService],
})
export class HrScannerModule {}
