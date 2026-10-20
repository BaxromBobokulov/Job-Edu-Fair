/**
 * Retention purge (Part 6) against real Postgres (own `qrbot_test_retention`
 * schema): refuses without EVENT_DATE, does nothing before EVENT_DATE +
 * 3 months, then nulls PII (keeping rows, stats and history), clears sheet
 * cells B/C/F through the sync queue without touching J, and is a no-op when
 * run again. Queues run inline; Google is never called.
 */
import { Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
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
import { SheetsSyncJob, SyncColumn } from '../sheets/sheet-row';
import { SHEETS_CLIENT, SheetsClient } from '../sheets/sheets.client';
import { SheetsModule } from '../sheets/sheets.module';
import { RetentionModule } from './retention.module';
import { RetentionService } from './retention.service';

const TEST_SCHEMA = 'qrbot_test_retention';
const SECRET = 'test-secret';
const HR = 9001;
const COLUMNS = 'ABCDEFGHIJ';
const EVENT_DATE = '2026-11-15';
// Purge date 2027-02-15; Asia/Tashkent is UTC+5.
const LAST_MOMENT_BEFORE = new Date('2027-02-14T18:59:59.999Z');
const PURGE_DAY = new Date('2027-02-14T19:00:00.000Z');
const DAY_AFTER = new Date('2027-02-16T03:00:00.000Z');

/** In-memory sheet; `rows[0]` is the header. */
class FakeSheet implements SheetsClient {
  rows: string[][] = [];
  calls: Array<Partial<Record<SyncColumn, string>> | string[]> = [];

  reset(): void {
    this.rows = [COLUMNS.split('')];
    this.calls = [];
  }

  readKeys(): Promise<string[]> {
    return Promise.resolve(this.rows.map((r) => r[0] ?? ''));
  }

  updateCells(
    row: number,
    cells: Partial<Record<SyncColumn, string>>,
  ): Promise<void> {
    this.calls.push(cells);
    for (const [column, value] of Object.entries(cells)) {
      this.rows[row - 1][COLUMNS.indexOf(column)] = value;
    }
    return Promise.resolve();
  }

  appendRow(values: string[]): Promise<void> {
    this.calls.push(values);
    this.rows.push([...values]);
    return Promise.resolve();
  }

  rowOf(participantId: string): string[] {
    const row = this.rows.find((r) => r[0] === participantId);
    if (!row) throw new Error('row not in sheet');
    return row;
  }
}

let nextTelegramId = 1;
let nextClickTransId = 800_000_001n;

describeDb('Retention purge (Postgres + fake Sheets)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaService;
  let moduleRef: TestingModule;
  let participants: ParticipantsService;
  let payments: PaymentsService;
  let hr: HrScannerService;
  let retention: RetentionService;
  let queue: InlineJobQueue<SheetsSyncJob>;
  let add: jest.SpyInstance<void, [SheetsSyncJob]>;
  const sheet = new FakeSheet();
  const eventDate: { value: string | undefined } = { value: EVENT_DATE };
  const logs: string[] = [];
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
        RetentionModule,
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
    retention = moduleRef.get(RetentionService);
    queue = moduleRef.get(SHEETS_SYNC_QUEUE);
    add = jest.spyOn(queue, 'add');

    // EVENT_DATE per test, never from the developer's .env (which Prisma
    // loads into process.env, where ConfigService would find it).
    const config = moduleRef.get(ConfigService);
    const realGet =
      ConfigService.prototype.get.bind<(key: string) => unknown>(config);
    jest
      .spyOn(config, 'get')
      .mockImplementation((key: string) =>
        key === 'EVENT_DATE' ? eventDate.value : realGet(key),
      );

    jest.spyOn(Logger.prototype, 'log').mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    jest.spyOn(Logger.prototype, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
    });
    for (const level of ['warn', 'debug'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined);
    }
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
    eventDate.value = EVENT_DATE;
    sheet.reset();
    add.mockClear();
    logs.length = 0;
    errors.length = 0;
  });

  /** A verified Click Prepare + Complete of the current payment. */
  async function pay(participantId: string): Promise<void> {
    const { id: paymentId } = await prisma.payment.findFirstOrThrow({
      where: { participantId },
      orderBy: { createdAt: 'desc' },
    });
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

  /** Registered, paid, checked in and decided on by Acme; synced to the sheet with J filled by hand. */
  async function fullParticipant() {
    const telegramId = nextTelegramId++;
    const p = await participants.register({
      telegramId,
      languageCode: 'en',
      phone: `99890${String(telegramId).padStart(7, '0')}`,
      fullName: 'Aziz Karimov',
      birthYearOrCourse: '2003',
      direction: 'Backend',
      hasSkillAndPortfolio: true,
      cvLink: 'https://github.com/aziz',
    });
    await pay(p.id);
    qr.decodeFromPhoto.mockResolvedValue({
      kind: 'ok',
      participant: {
        id: p.id,
        fullName: p.fullName,
        direction: p.direction,
        track: p.track,
      },
    });
    await hr.scan(HR, Buffer.from('photo'));
    await hr.decide(HR, p.id, ScanDecision.interview);
    await queue.idle();
    sheet.rowOf(p.id)[9] = 'Hired (14 days)';
    add.mockClear();
    sheet.calls = [];
    logs.length = 0;
    return p;
  }

  const snapshot = () =>
    prisma.participant.findMany({
      orderBy: { createdAt: 'asc' },
      include: { payments: true, scanEvents: true },
    });

  it('refuses and logs loudly when EVENT_DATE is missing or malformed — even long after any plausible purge date', async () => {
    await fullParticipant();
    const before = await snapshot();
    const sheetBefore = structuredClone(sheet.rows);

    for (const [value, reason] of [
      [undefined, 'EVENT_DATE is not set'],
      ['', 'EVENT_DATE is not set'],
      ['15.11.2026', 'EVENT_DATE is not a valid YYYY-MM-DD date'],
      ['2026-02-30', 'EVENT_DATE is not a valid YYYY-MM-DD date'],
    ] as const) {
      eventDate.value = value;
      errors.length = 0;
      expect(await retention.run(new Date('2030-01-01T00:00:00Z'))).toEqual({
        kind: 'refused',
        reason,
      });
      expect(errors).toEqual([
        expect.stringContaining(`RETENTION PURGE REFUSED: ${reason}`),
      ]);
    }

    await queue.idle();
    expect(await snapshot()).toEqual(before);
    expect(add).not.toHaveBeenCalled();
    expect(sheet.rows).toEqual(sheetBefore);
  });

  it('does nothing before EVENT_DATE + 3 months, and logs that it was a no-op', async () => {
    await fullParticipant();
    const before = await snapshot();

    for (const now of [new Date('2026-11-15T12:00:00Z'), LAST_MOMENT_BEFORE]) {
      expect(await retention.run(now)).toEqual({
        kind: 'not_due',
        purgeDate: '2027-02-15',
        today: now === LAST_MOMENT_BEFORE ? '2027-02-14' : '2026-11-15',
      });
    }

    expect(await snapshot()).toEqual(before);
    expect(add).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
    expect(logs).toEqual([
      expect.stringContaining('Retention purge not due: purge date 2027-02-15'),
      expect.stringContaining('Retention purge not due: purge date 2027-02-15'),
    ]);
  });

  it('on the purge date nulls PII, keeps rows, stats and history, and clears sheet B/C/F but never J', async () => {
    const paid = await fullParticipant();
    const unpaid = await participants.register({
      telegramId: nextTelegramId++,
      languageCode: 'ru',
      phone: '998901112233',
      fullName: 'Dilnoza Rahimova',
      birthYearOrCourse: '2nd course',
      direction: 'QA',
      hasSkillAndPortfolio: false,
    });
    await queue.idle();
    add.mockClear();
    sheet.calls = [];
    const before = await snapshot();

    expect(await retention.run(PURGE_DAY)).toEqual({
      kind: 'purged',
      purgeDate: '2027-02-15',
      participants: 2,
      payments: 1,
    });

    const after = await snapshot();
    expect(after).toHaveLength(2);
    for (const [i, row] of after.entries()) {
      const old = before[i];
      // PII gone…
      expect(row).toMatchObject({
        fullName: null,
        phone: null,
        cvLink: null,
        telegramId: null,
        piiPurgedAt: PURGE_DAY,
      });
      // …aggregate-safe fields and history kept.
      expect(row).toMatchObject({
        id: old.id,
        track: old.track,
        direction: old.direction,
        languageCode: old.languageCode,
        checkedInAt: old.checkedInAt,
        scanEvents: old.scanEvents,
      });
      expect(row.payments).toEqual(
        old.payments.map((p) => ({ ...p, clickTransId: null })),
      );
    }
    const paidRow = after.find((r) => r.id === paid.id);
    expect(paidRow?.payments[0]).toMatchObject({
      status: PaymentStatus.paid,
      amount: 50_000,
      paidAt: expect.any(Date) as Date,
    });
    expect(paidRow?.scanEvents).toHaveLength(1);

    expect(add.mock.calls.map(([job]) => job)).toEqual(
      expect.arrayContaining([
        { participantId: paid.id, columns: ['B', 'C', 'F'] },
        { participantId: unpaid.id, columns: ['B', 'C', 'F'] },
      ]),
    );
    await queue.idle();
    expect(sheet.calls).toEqual([
      { B: '', C: '', F: '' },
      { B: '', C: '', F: '' },
    ]);
    const row = sheet.rowOf(paid.id);
    expect(row.slice(1, 3)).toEqual(['', '']);
    expect(row[5]).toBe('');
    expect(row[3]).toBe('Backend'); // D–I untouched
    expect(row[6]).toBe('Paid');
    expect(row[8]).toBe('Acme: Invited to interview');
    expect(row[9]).toBe('Hired (14 days)'); // J never touched
    expect(sheet.rowOf(unpaid.id).slice(1, 3)).toEqual(['', '']);

    expect(errors).toEqual([]);
    expect(logs).toContainEqual(
      expect.stringContaining(
        'purge date 2027-02-15, 2 participant(s) and 1 payment(s) anonymized',
      ),
    );
  });

  it('running again after the purge date is a harmless no-op', async () => {
    await fullParticipant();
    await retention.run(PURGE_DAY);
    await queue.idle();
    const purged = await snapshot();
    const sheetAfterFirst = structuredClone(sheet.rows);
    add.mockClear();
    sheet.calls = [];
    logs.length = 0;

    for (const now of [PURGE_DAY, DAY_AFTER]) {
      expect(await retention.run(now)).toEqual({
        kind: 'purged',
        purgeDate: '2027-02-15',
        participants: 0,
        payments: 0,
      });
    }

    await queue.idle();
    // piiPurgedAt keeps the first run's time.
    expect(await snapshot()).toEqual(purged);
    expect(add).not.toHaveBeenCalled();
    expect(sheet.calls).toEqual([]);
    expect(sheet.rows).toEqual(sheetAfterFirst);
    expect(errors).toEqual([]);
    expect(logs).toEqual([
      expect.stringContaining('already purged, no-op'),
      expect.stringContaining('already purged, no-op'),
    ]);
  });

  it("a late sync job for a purged participant whose row isn't in the sheet doesn't re-create it", async () => {
    const p = await participants.register({
      telegramId: nextTelegramId++,
      languageCode: 'en',
      phone: '998907654321',
      fullName: 'Late Sync',
      birthYearOrCourse: '2001',
      direction: 'Frontend',
      hasSkillAndPortfolio: false,
    });
    await queue.idle();
    sheet.reset(); // the row never made it into the sheet
    await retention.run(PURGE_DAY);
    await queue.idle();

    expect(sheet.rows).toHaveLength(1);
    expect(sheet.calls).toEqual([]);
    expect(
      (await prisma.participant.findUniqueOrThrow({ where: { id: p.id } }))
        .piiPurgedAt,
    ).toEqual(PURGE_DAY);
  });
});
