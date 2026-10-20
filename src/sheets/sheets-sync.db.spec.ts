/**
 * Sheets sync (Part 5) against real Postgres (own `qrbot_test_sheets`
 * schema): every write path enqueues the right cells, the processor upserts
 * them by Participant.id into a fake sheet, the qrToken never reaches it,
 * column J is never touched, and a failing
 * or hanging Sheets API never rolls back or blocks the Postgres write.
 * Queues run inline (no REDIS_URL in tests); Google is never called.
 */
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { PaymentStatus, ScanDecision } from '@prisma/client';
import { describeDb, setUpTestDatabase } from '../../test/test-db';
import { HrScannerModule } from '../hr/hr-scanner.module';
import { HrScannerService } from '../hr/hr-scanner.service';
import { ParticipantsModule } from '../participants/participants.module';
import { ParticipantsService } from '../participants/participants.service';
import { ClickConfig } from '../payments/click.config';
import {
  ClickRawRequest,
  clickSignature,
  verifyClickRequest,
} from '../payments/click.protocol';
import { PaymentsModule } from '../payments/payments.module';
import { PaymentsService } from '../payments/payments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from '../qr/qr.service';
import { InlineJobQueue } from '../queue/job-queue';
import { SHEETS_SYNC_QUEUE } from '../queue/queue.module';
import { SheetsSyncJob, SyncColumn } from './sheet-row';
import { SHEETS_CLIENT, SheetsClient } from './sheets.client';
import { SheetsModule } from './sheets.module';

const TEST_SCHEMA = 'qrbot_test_sheets';
const SECRET = 'test-secret';
const HR = 9001;
const COLUMNS = 'ABCDEFGHIJ';
const HEADER = [
  'ID',
  'Full name',
  'Phone',
  'Direction',
  'Track',
  'CV',
  'Payment',
  'Check-in',
  'HR status',
  'Placement (14/30d)',
];

type SheetCall =
  | { op: 'update'; row: number; cells: Partial<Record<SyncColumn, string>> }
  | { op: 'append'; values: string[] };

/** An in-memory sheet with the A–J contract; `rows[0]` is the header. */
class FakeSheet implements SheetsClient {
  rows: string[][] = [];
  calls: SheetCall[] = [];
  /** Set to make every API call throw, like a 429/5xx from Google. */
  failing = false;
  /** Set to make every API call hang until released. */
  hang?: Promise<void>;

  reset(): void {
    this.rows = [[...HEADER]];
    this.calls = [];
    this.failing = false;
    this.hang = undefined;
  }

  private async api(): Promise<void> {
    if (this.hang) await this.hang;
    if (this.failing) {
      throw Object.assign(new Error('Quota exceeded'), { status: 429 });
    }
  }

  async readKeys(): Promise<string[]> {
    await this.api();
    return this.rows.map((r) => r[0] ?? '');
  }

  async updateCells(
    row: number,
    cells: Partial<Record<SyncColumn, string>>,
  ): Promise<void> {
    await this.api();
    this.calls.push({ op: 'update', row, cells });
    for (const [column, value] of Object.entries(cells)) {
      this.rows[row - 1][COLUMNS.indexOf(column)] = value;
    }
  }

  async appendRow(values: string[]): Promise<void> {
    await this.api();
    this.calls.push({ op: 'append', values });
    this.rows.push([...values]);
  }

  rowOf(participantId: string): string[] {
    const row = this.rows.find((r) => r[0] === participantId);
    if (!row) throw new Error('row not in sheet');
    return row;
  }
}

let nextTelegramId = 1;
let nextClickTransId = 700_000_001n;

describeDb('Sheets sync (Postgres + fake Sheets)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaService;
  let moduleRef: TestingModule;
  let participants: ParticipantsService;
  let payments: PaymentsService;
  let hr: HrScannerService;
  let queue: InlineJobQueue<SheetsSyncJob>;
  let add: jest.SpyInstance<void, [SheetsSyncJob]>;
  const sheet = new FakeSheet();
  const errors: string[] = [];
  const qr = {
    decodeFromPhoto: jest.fn(),
    sendQr: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    prisma = await setUpTestDatabase(TEST_SCHEMA);
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              CLICK_SERVICE_ID: '111',
              CLICK_MERCHANT_ID: '222',
              CLICK_SECRET_KEY: SECRET,
            }),
          ],
        }),
        PrismaModule,
        ParticipantsModule,
        PaymentsModule,
        HrScannerModule,
        SheetsModule,
      ],
    })
      .overrideProvider(QrService)
      .useValue(qr)
      .overrideProvider(SHEETS_CLIENT)
      .useValue(sheet)
      .compile();
    await moduleRef.init();
    participants = moduleRef.get(ParticipantsService);
    payments = moduleRef.get(PaymentsService);
    hr = moduleRef.get(HrScannerService);
    queue = moduleRef.get(SHEETS_SYNC_QUEUE);
    add = jest.spyOn(queue, 'add');
    for (const level of ['log', 'warn', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
    jest.spyOn(Logger.prototype, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
  });

  afterAll(async () => {
    await moduleRef?.close();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "Participant", "Company" CASCADE');
    await hr.registerHr({
      adminTelegramId: 1,
      hrTelegramId: HR,
      languageCode: 'en',
      companyName: 'Acme',
    });
    sheet.reset();
    add.mockClear();
    errors.length = 0;
  });

  const register = () => {
    const telegramId = nextTelegramId++;
    return participants.register({
      telegramId,
      languageCode: 'en',
      phone: `99890${String(telegramId).padStart(7, '0')}`,
      fullName: 'Aziz Karimov',
      birthYearOrCourse: '2003',
      direction: 'Backend',
      hasSkillAndPortfolio: true,
      cvLink: 'https://github.com/aziz',
    });
  };
  const enqueued = () => add.mock.calls.map(([job]) => job);

  /** A verified Click Prepare + Complete of the current payment, as Click would send. */
  async function pay(participantId: string): Promise<void> {
    const paymentId = await currentPaymentId(participantId);
    const settings = moduleRef.get(ClickConfig).get();
    const base = {
      click_trans_id: String(nextClickTransId++),
      service_id: '111',
      click_paydoc_id: '1',
      merchant_trans_id: paymentId,
      amount: '50000',
      error: '0',
      error_note: 'Success',
      sign_time: '2026-10-19 12:00:00',
    };
    const signed = (fields: Omit<ClickRawRequest, 'sign_string'>) => ({
      ...fields,
      sign_string: clickSignature(fields, SECRET),
    });
    const prepare = verifyClickRequest(
      signed({ ...base, action: '0' }),
      'prepare',
      settings,
    );
    if (!prepare.ok) throw new Error('prepare not verified');
    const { merchantId } = await payments.handlePrepare(prepare.request);
    const complete = verifyClickRequest(
      signed({ ...base, action: '1', merchant_prepare_id: String(merchantId) }),
      'complete',
      settings,
    );
    if (!complete.ok) throw new Error('complete not verified');
    await payments.handleComplete(complete.request);
  }

  async function currentPaymentId(participantId: string): Promise<string> {
    const p = await prisma.payment.findFirstOrThrow({
      where: { participantId },
      orderBy: { createdAt: 'desc' },
    });
    return p.id;
  }

  it('a registration enqueues its row (A–G) and the processor appends A–I, never J', async () => {
    const p = await register();

    expect(enqueued()).toEqual([
      { participantId: p.id, columns: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] },
    ]);
    await queue.idle();
    expect(sheet.calls).toEqual([
      {
        op: 'append',
        values: [
          p.id,
          'Aziz Karimov',
          p.phone,
          'Backend',
          'Job Track',
          'https://github.com/aziz',
          'Unpaid',
          'No',
          '',
        ],
      },
    ]);
  });

  it('payment, check-in and decision each enqueue and update only their own column', async () => {
    const p = await register();
    await queue.idle();
    // The client fills J by hand weeks later; nothing may overwrite it.
    sheet.rowOf(p.id)[9] = 'Hired (14 days)';
    const step = async (action: () => Promise<unknown>) => {
      add.mockClear();
      sheet.calls = [];
      await action();
      const jobs = enqueued();
      await queue.idle();
      return { jobs, calls: sheet.calls };
    };

    expect(await step(() => pay(p.id).then(() => undefined))).toEqual({
      jobs: [{ participantId: p.id, columns: ['G'] }],
      calls: [{ op: 'update', row: 2, cells: { G: 'Paid' } }],
    });

    qr.decodeFromPhoto.mockResolvedValue({
      kind: 'ok',
      participant: {
        id: p.id,
        fullName: p.fullName,
        direction: p.direction,
        track: p.track,
      },
    });
    const checkIn = await step(() => hr.scan(HR, Buffer.from('photo')));
    expect(checkIn.jobs).toEqual([{ participantId: p.id, columns: ['H'] }]);
    expect(checkIn.calls).toEqual([
      {
        op: 'update',
        row: 2,
        cells: {
          H: expect.stringMatching(
            /^Yes, \d{4}-\d\d-\d\d \d\d:\d\d$/,
          ) as string,
        },
      },
    ]);
    // A re-scan isn't a check-in: nothing to sync.
    expect(await step(() => hr.scan(HR, Buffer.from('photo')))).toEqual({
      jobs: [],
      calls: [],
    });

    expect(
      await step(() => hr.decide(HR, p.id, ScanDecision.interview)),
    ).toEqual({
      jobs: [{ participantId: p.id, columns: ['I'] }],
      calls: [
        { op: 'update', row: 2, cells: { I: 'Acme: Invited to interview' } },
      ],
    });

    const paymentId = await currentPaymentId(p.id);
    expect(await step(() => payments.requestRefund(paymentId, 1))).toEqual({
      jobs: [{ participantId: p.id, columns: ['G'] }],
      calls: [{ op: 'update', row: 2, cells: { G: 'Refund requested' } }],
    });
    expect(await step(() => payments.approveRefund(paymentId, 1))).toEqual({
      jobs: [{ participantId: p.id, columns: ['G'] }],
      calls: [{ op: 'update', row: 2, cells: { G: 'Refunded' } }],
    });

    expect(sheet.rowOf(p.id)).toEqual([
      p.id,
      'Aziz Karimov',
      p.phone,
      'Backend',
      'Job Track',
      'https://github.com/aziz',
      'Refunded',
      expect.stringMatching(/^Yes, /),
      'Acme: Invited to interview',
      'Hired (14 days)',
    ]);
    // The admission credential appears in no cell, in no call.
    expect(JSON.stringify(sheet.rows)).not.toContain(p.qrToken);
    expect(JSON.stringify(sheet.calls)).not.toContain(p.qrToken);
  });

  it('upserts by Participant.id, not by row order (the sheet was re-sorted by hand)', async () => {
    const a = await register();
    const b = await register();
    await queue.idle();
    // Someone sorted the sheet: b's row is now above a's, plus a manual row.
    sheet.rows = [
      sheet.rows[0],
      sheet.rowOf(b.id),
      ['manual note'],
      sheet.rowOf(a.id),
    ];
    sheet.calls = [];

    await prisma.payment.updateMany({
      where: { participantId: a.id },
      data: { status: PaymentStatus.paid, paidAt: new Date() },
    });
    await payments.requestRefund(await currentPaymentId(a.id), 1);
    await queue.idle();

    expect(sheet.calls).toEqual([
      { op: 'update', row: 4, cells: { G: 'Refund requested' } },
    ]);
    expect(sheet.rowOf(b.id)[6]).toBe('Unpaid');
  });

  it('a row missing from the sheet is appended in full on its next update', async () => {
    const p = await register();
    await queue.idle();
    sheet.rows = [sheet.rows[0]]; // deleted by hand
    sheet.calls = [];

    await pay(p.id);
    await queue.idle();
    expect(sheet.calls).toEqual([
      {
        op: 'append',
        values: expect.arrayContaining([p.id, 'Paid']) as string[],
      },
    ]);
    expect(sheet.rowOf(p.id)).toHaveLength(9);
  });

  it('a failing Sheets API never rolls back the Postgres write', async () => {
    sheet.failing = true;

    const p = await register();
    await pay(p.id);
    await queue.idle();

    // Every sync job failed …
    expect(sheet.calls).toEqual([]);
    expect(errors.filter((e) => e.includes('Job failed'))).toHaveLength(2);
    // … and Postgres has everything regardless.
    const row = await prisma.participant.findUniqueOrThrow({
      where: { id: p.id },
      include: { payments: true },
    });
    expect(row.fullName).toBe('Aziz Karimov');
    expect(row.payments.map((x) => x.status)).toEqual([PaymentStatus.paid]);
  });

  it('a hanging Sheets API never blocks the Postgres write', async () => {
    let release!: () => void;
    sheet.hang = new Promise((resolve) => (release = resolve));

    const p = await register(); // resolves while the sync job is stuck
    await pay(p.id);
    expect(await prisma.participant.count({ where: { id: p.id } })).toBe(1);
    expect(sheet.calls).toEqual([]);

    release();
    await queue.idle();
    expect(sheet.rowOf(p.id)[6]).toBe('Paid');
  });
});
