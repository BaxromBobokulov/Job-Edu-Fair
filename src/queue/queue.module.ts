import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { createJobQueue } from './job-queue';
import type { JobQueue, JobQueueOptions } from './job-queue';

/** Injection tokens — also the BullMQ queue names. */
export const SHEETS_SYNC_QUEUE = 'sheets-sync';
export const QR_DECODE_QUEUE = 'qr-decode';

/**
 * Sheets API quota is 60 reads + 60 writes per minute per service account;
 * a sync job is one read (column A) + one write, so 50 jobs/min stays under
 * it. One job at a time across all instances: two jobs for a participant
 * whose row doesn't exist yet would otherwise both append it.
 * Backoff 10 s × 2^n over 10 tries ≈ 2.8 h of Sheets outage covered.
 */
const SHEETS_SYNC_OPTIONS: JobQueueOptions = {
  attempts: 10,
  backoffMs: 10_000,
  concurrency: 1,
  globalConcurrency: 1,
  limiter: { max: 50, duration: 60_000 },
};

/**
 * One try: the job replies to HR itself in every outcome, and HR resends the
 * photo on "try again". The CPU-bound decode runs in a worker thread, so
 * several jobs at once don't stall the bot.
 */
const QR_DECODE_OPTIONS: JobQueueOptions = {
  attempts: 1,
  backoffMs: 0,
  concurrency: 8,
};

function queueProvider(name: string, options: JobQueueOptions) {
  return {
    provide: name,
    inject: [ConfigService],
    useFactory: (config: ConfigService) =>
      createJobQueue(
        name,
        config.get<string>('REDIS_URL')?.trim() || undefined,
        options,
        process.env.NODE_ENV,
      ),
  };
}

@Module({
  imports: [ConfigModule],
  providers: [
    queueProvider(SHEETS_SYNC_QUEUE, SHEETS_SYNC_OPTIONS),
    queueProvider(QR_DECODE_QUEUE, QR_DECODE_OPTIONS),
  ],
  exports: [SHEETS_SYNC_QUEUE, QR_DECODE_QUEUE],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(
    @Inject(SHEETS_SYNC_QUEUE) private readonly sheets: JobQueue<object>,
    @Inject(QR_DECODE_QUEUE) private readonly qrDecode: JobQueue<object>,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all([this.sheets.close(), this.qrDecode.close()]);
  }
}
