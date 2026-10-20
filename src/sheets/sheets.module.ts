import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { GoogleSheetsClient, SHEETS_CLIENT } from './sheets.client';
import { SheetsConfig } from './sheets.config';
import { SheetsProcessor } from './sheets.processor';
import { SheetsSyncService } from './sheets-sync.service';

/** Producer side, for the write paths: enqueue only, no Sheets API access. */
@Module({
  imports: [QueueModule],
  providers: [SheetsSyncService],
  exports: [SheetsSyncService],
})
export class SheetsSyncModule {}

/** Consumer side: the sync worker. Imported once, by AppModule. */
@Module({
  imports: [QueueModule],
  providers: [
    SheetsConfig,
    {
      provide: SHEETS_CLIENT,
      inject: [SheetsConfig],
      useFactory: (config: SheetsConfig) =>
        config.isConfigured() ? new GoogleSheetsClient(config.get()) : null,
    },
    SheetsProcessor,
  ],
})
export class SheetsModule {}
