import { Module } from '@nestjs/common';
import { SheetsSyncModule } from '../sheets/sheets.module';
import { RetentionCron } from './retention.cron';
import { RetentionService } from './retention.service';

@Module({
  imports: [SheetsSyncModule],
  providers: [RetentionService, RetentionCron],
})
export class RetentionModule {}
