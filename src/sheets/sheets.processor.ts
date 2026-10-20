import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { JobQueue } from '../queue/job-queue';
import { SHEETS_SYNC_QUEUE } from '../queue/queue.module';
import {
  ParticipantSnapshot,
  SheetsSyncJob,
  SYNC_COLUMNS,
  sheetRowValues,
} from './sheet-row';
import { SHEETS_CLIENT, SheetsClient } from './sheets.client';

export type SyncOutcome = 'appended' | 'updated' | 'skipped';

async function loadSnapshot(
  prisma: PrismaService,
  participantId: string,
): Promise<ParticipantSnapshot | null> {
  const p = await prisma.participant.findUnique({
    where: { id: participantId },
    select: {
      id: true,
      fullName: true,
      phone: true,
      direction: true,
      track: true,
      cvLink: true,
      checkedInAt: true,
      piiPurgedAt: true,
      payments: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { status: true },
      },
      scanEvents: {
        orderBy: [{ createdAt: 'desc' }, { seq: 'desc' }],
        select: { decision: true, company: { select: { name: true } } },
      },
    },
  });
  if (!p) return null;
  const { payments, scanEvents, ...rest } = p;
  // Newest first: the first row seen per company is its current decision.
  const latest = new Map<string, ParticipantSnapshot['decisions'][number]>();
  for (const e of scanEvents) {
    if (!latest.has(e.company.name)) {
      latest.set(e.company.name, {
        companyName: e.company.name,
        decision: e.decision,
      });
    }
  }
  return {
    ...rest,
    paymentStatus: payments[0]?.status ?? null,
    decisions: [...latest.values()],
  };
}

/**
 * One sync job: reads the participant's current state from Postgres (so a
 * late retry never writes stale values), finds its row by Participant.id in
 * column A, and updates only the job's cells — or appends the full A–I row if it
 * isn't in the sheet yet (unless its PII was purged). Column J is never written.
 */
export async function syncParticipantRow(
  prisma: PrismaService,
  client: SheetsClient,
  job: SheetsSyncJob,
): Promise<SyncOutcome> {
  const snapshot = await loadSnapshot(prisma, job.participantId);
  if (!snapshot) return 'skipped';
  const values = sheetRowValues(snapshot);

  const index = (await client.readKeys()).indexOf(snapshot.id);
  // A purged participant's row is only ever cleared, never (re)created.
  if (index === -1 && snapshot.piiPurgedAt) return 'skipped';
  if (index === -1) {
    await client.appendRow(SYNC_COLUMNS.map((c) => values[c]));
    return 'appended';
  }
  const cells = Object.fromEntries(
    job.columns
      .filter((c) => SYNC_COLUMNS.includes(c))
      .map((c) => [c, values[c]]),
  );
  await client.updateCells(index + 1, cells);
  return 'updated';
}

/** HTTP status of a googleapis (gaxios) error, without its request/response body. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  const status =
    (err as { status?: unknown }).status ??
    (err as { response?: { status?: unknown } }).response?.status;
  return typeof status === 'number' ? `${err.name} (HTTP ${status})` : err.name;
}

/**
 * The sheets-sync worker — the only code that calls the Sheets API. Without
 * Google credentials it doesn't start, and jobs wait in Redis until an
 * instance that has them does. Failures are retried by the queue.
 */
@Injectable()
export class SheetsProcessor implements OnApplicationBootstrap {
  private readonly logger = new Logger(SheetsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SHEETS_SYNC_QUEUE) private readonly queue: JobQueue<SheetsSyncJob>,
    @Inject(SHEETS_CLIENT) private readonly client: SheetsClient | null,
  ) {}

  onApplicationBootstrap(): void {
    const client = this.client;
    if (!client) {
      this.logger.warn(
        'Google Sheets not configured (GOOGLE_SHEETS_SPREADSHEET_ID / GOOGLE_SERVICE_ACCOUNT_JSON): sync jobs wait in the queue',
      );
      return;
    }
    this.queue.process(async (job) => {
      try {
        const outcome = await syncParticipantRow(this.prisma, client, job);
        this.logger.debug(
          `Participant ${job.participantId} [${job.columns.join('')}]: ${outcome}`,
        );
      } catch (err) {
        this.logger.warn(
          `Sync of participant ${job.participantId} [${job.columns.join('')}] failed: ${describeError(err)}`,
        );
        throw err; // the queue retries with backoff
      }
    });
  }
}
