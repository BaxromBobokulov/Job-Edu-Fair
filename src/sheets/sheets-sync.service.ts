import { Inject, Injectable } from '@nestjs/common';
import type { JobQueue } from '../queue/job-queue';
import { SHEETS_SYNC_QUEUE } from '../queue/queue.module';
import {
  CHECK_IN_COLUMN,
  HR_STATUS_COLUMN,
  PAYMENT_STATUS_COLUMN,
  PII_COLUMNS,
  REGISTRATION_COLUMNS,
  SheetsSyncJob,
  SyncColumn,
} from './sheet-row';

/**
 * The write paths' only way to reach the sheet: each call enqueues the
 * changed cells of one participant's row. Call it after the Postgres write
 * committed. It never throws or waits — Sheets is a mirror, and a sync
 * problem must not fail or delay the write it mirrors.
 */
@Injectable()
export class SheetsSyncService {
  constructor(
    @Inject(SHEETS_SYNC_QUEUE) private readonly queue: JobQueue<SheetsSyncJob>,
  ) {}

  registered(participantId: string): void {
    this.enqueue(participantId, REGISTRATION_COLUMNS);
  }

  paymentStatusChanged(participantId: string): void {
    this.enqueue(participantId, [PAYMENT_STATUS_COLUMN]);
  }

  checkedIn(participantId: string): void {
    this.enqueue(participantId, [CHECK_IN_COLUMN]);
  }

  decisionRecorded(participantId: string): void {
    this.enqueue(participantId, [HR_STATUS_COLUMN]);
  }

  /** Retention purge: B, C and F are re-read from Postgres, now empty. */
  piiPurged(participantId: string): void {
    this.enqueue(participantId, PII_COLUMNS);
  }

  private enqueue(participantId: string, columns: readonly SyncColumn[]) {
    this.queue.add({ participantId, columns: [...columns] });
  }
}
