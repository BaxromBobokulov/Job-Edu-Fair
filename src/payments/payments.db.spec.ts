/**
 * Click webhook flow end-to-end over HTTP (supertest → ClickController →
 * PaymentsService → real Postgres, own `qrbot_test_payments` schema).
 * Click itself is simulated: requests are signed here with a test secret.
 */
import { INestApplication, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Participant, PaymentStatus, Track } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { describeDb, setUpTestDatabase } from '../../test/test-db';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from '../qr/qr.service';
import { SheetsSyncService } from '../sheets/sheets-sync.service';
import {
  ClickError,
  ClickRawRequest,
  clickSignature,
  ClickResponse,
} from './click.protocol';
import {
  DevPaymentBypassDisabledError,
  InvalidPaymentTransitionError,
  PaymentNotAllowedError,
  PaymentOverdueError,
} from './payments.errors';
import { PaymentsModule } from './payments.module';
import { PaymentsService } from './payments.service';

const TEST_SCHEMA = 'qrbot_test_payments';
const SECRET = 'test-secret-do-not-log';
const SERVICE_ID = '111';

let nextTelegramId = 1;
let nextClickTransId = 900_000_001n;

describeDb('Click payments (Postgres + HTTP)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaService;
  let app: INestApplication<App>;
  let payments: PaymentsService;
  const logged: string[] = [];
  // QR rendering + Telegram are covered by src/qr/qr.db.spec.ts; here only the hook.
  const qr = { sendQr: jest.fn() };

  beforeAll(async () => {
    prisma = await setUpTestDatabase(TEST_SCHEMA);
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              CLICK_SERVICE_ID: SERVICE_ID,
              CLICK_MERCHANT_ID: '222',
              CLICK_SECRET_KEY: SECRET,
            }),
          ],
        }),
        PrismaModule,
        PaymentsModule,
      ],
    })
      .overrideProvider(QrService)
      .useValue(qr)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    payments = app.get(PaymentsService);

    // Capture every log line to check that no secret / signature leaks.
    for (const level of ['log', 'warn', 'error', 'debug'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((message: unknown) => {
          logged.push(String(message));
        });
    }
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "Participant" CASCADE');
    qr.sendQr.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const line of logged) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toMatch(/[0-9a-f]{32}/); // no md5 sign_string
    }
    logged.length = 0;
  });

  function createParticipant(track: Track | null = Track.EDU) {
    const telegramId = nextTelegramId++;
    return prisma.participant.create({
      data: {
        telegramId: BigInt(telegramId),
        languageCode: 'en',
        phone: `+99890${String(telegramId).padStart(7, '0')}`,
        fullName: 'Aziz Karimov',
        birthYearOrCourse: '2003',
        direction: 'Backend',
        track,
        qrToken: randomBytes(32).toString('base64url'),
      },
    });
  }

  interface ClickCall {
    paymentId: string;
    clickTransId?: bigint;
    amount?: string;
    prepareId?: number;
    error?: string;
    /** Overrides the computed signature. */
    sign?: string;
  }

  /** Posts a form-urlencoded, Click-signed request (as Click does). */
  async function click(
    stage: 'prepare' | 'complete',
    call: ClickCall,
  ): Promise<ClickResponse> {
    const fields: Omit<ClickRawRequest, 'sign_string'> = {
      click_trans_id: String(call.clickTransId ?? 1n),
      service_id: SERVICE_ID,
      click_paydoc_id: '4242',
      merchant_trans_id: call.paymentId,
      amount: call.amount ?? '50000',
      action: stage === 'prepare' ? '0' : '1',
      error: call.error ?? '0',
      error_note: call.error ? 'Cancelled' : 'Success',
      sign_time: '2026-10-19 12:00:00',
      ...(stage === 'complete' && {
        merchant_prepare_id: String(call.prepareId),
      }),
    };
    const sign_string = call.sign ?? clickSignature(fields, SECRET);
    const res = await request(app.getHttpServer())
      .post(`/click/${stage}`)
      .type('form')
      .send({ ...fields, sign_string })
      .expect(200);
    return res.body as ClickResponse;
  }

  /** Invoice → Prepare, returning what Complete needs. */
  async function invoiceAndPrepare(participant?: Participant) {
    const p = participant ?? (await createParticipant());
    const invoice = await payments.createInvoice(p.id);
    const clickTransId = nextClickTransId++;
    const prepared = await click('prepare', {
      paymentId: invoice.paymentId,
      clickTransId,
    });
    expect(prepared.error).toBe(ClickError.Success);
    return {
      paymentId: invoice.paymentId,
      clickTransId,
      prepareId: prepared.merchant_prepare_id as number,
    };
  }

  const paymentRow = (id: string) =>
    prisma.payment.findUniqueOrThrow({ where: { id } });

  it('invoice → signed Prepare → signed Complete → paid', async () => {
    const participant = await createParticipant();
    const invoice = await payments.createInvoice(participant.id);
    expect(invoice).toMatchObject({ status: 'pending', amount: 50_000 });
    expect(invoice.payUrl).toBe(
      `https://my.click.uz/services/pay?service_id=111&merchant_id=222&amount=50000&transaction_param=${invoice.paymentId}`,
    );

    const clickTransId = nextClickTransId++;
    const prepared = await click('prepare', {
      paymentId: invoice.paymentId,
      clickTransId,
    });
    const row = await paymentRow(invoice.paymentId);
    expect(prepared).toEqual({
      click_trans_id: Number(clickTransId),
      merchant_trans_id: invoice.paymentId,
      merchant_prepare_id: row.clickPrepareId,
      error: 0,
      error_note: 'Success',
    });
    expect(row).toMatchObject({ status: 'pending', clickTransId });

    const completed = await click('complete', {
      paymentId: invoice.paymentId,
      clickTransId,
      prepareId: row.clickPrepareId,
    });
    expect(completed).toEqual({
      click_trans_id: Number(clickTransId),
      merchant_trans_id: invoice.paymentId,
      merchant_confirm_id: row.clickPrepareId,
      error: 0,
      error_note: 'Success',
    });

    const paid = await paymentRow(invoice.paymentId);
    expect(paid.status).toBe(PaymentStatus.paid);
    expect(paid.paidAt).toBeInstanceOf(Date);
    expect(qr.sendQr.mock.calls).toEqual([[participant.id, 'issued']]);

    // /status view after payment: no pay link any more.
    expect(
      await payments.getStatusByTelegramId(Number(participant.telegramId)),
    ).toEqual({
      participantId: participant.id,
      languageCode: 'en',
      invoice: {
        paymentId: invoice.paymentId,
        status: 'paid',
        amount: 50_000,
        payUrl: null,
      },
    });
  });

  it('a replayed Complete is idempotent — answered again, not re-processed', async () => {
    const { paymentId, clickTransId, prepareId } = await invoiceAndPrepare();
    const call = { paymentId, clickTransId, prepareId };

    // Two concurrent Completes, then a late replay.
    const [a, b] = await Promise.all([
      click('complete', call),
      click('complete', call),
    ]);
    const firstPaidAt = (await paymentRow(paymentId)).paidAt;
    const replay = await click('complete', call);

    for (const res of [a, b, replay]) {
      expect(res).toMatchObject({ error: 0, merchant_confirm_id: prepareId });
    }
    const row = await paymentRow(paymentId);
    expect(row.status).toBe(PaymentStatus.paid);
    expect(row.paidAt).toEqual(firstPaidAt);
    expect(
      logged.filter((l) => l === `Payment ${paymentId} paid`),
    ).toHaveLength(1);
    expect(qr.sendQr).toHaveBeenCalledTimes(1);
  });

  it('rejects a bad signature without changing anything', async () => {
    const participant = await createParticipant();
    const { paymentId } = await payments.createInvoice(participant.id);

    const prepare = await click('prepare', {
      paymentId,
      clickTransId: 5n,
      sign: 'f'.repeat(32),
    });
    expect(prepare.error).toBe(ClickError.SignCheckFailed);
    expect(await paymentRow(paymentId)).toMatchObject({
      status: 'pending',
      clickTransId: null,
      preparedAt: null,
    });

    // A forged Complete on a properly prepared payment.
    const prepared = await invoiceAndPrepare(participant);
    const complete = await click('complete', {
      ...prepared,
      sign: '0'.repeat(32),
    });
    expect(complete).toMatchObject({
      error: ClickError.SignCheckFailed,
      error_note: 'SIGN CHECK FAILED!',
    });
    const row = await paymentRow(paymentId);
    expect(row.status).toBe(PaymentStatus.pending);
    expect(row.paidAt).toBeNull();
    expect(qr.sendQr).not.toHaveBeenCalled();
  });

  it('rejects a correctly signed wrong amount on Prepare and on Complete', async () => {
    const participant = await createParticipant();
    const { paymentId } = await payments.createInvoice(participant.id);

    const prepare = await click('prepare', {
      paymentId,
      clickTransId: nextClickTransId++,
      amount: '1000',
    });
    expect(prepare).toMatchObject({
      error: ClickError.IncorrectAmount,
      error_note: 'Incorrect parameter amount',
    });
    expect((await paymentRow(paymentId)).preparedAt).toBeNull();

    const prepared = await invoiceAndPrepare(participant);
    for (const amount of ['49999', '50001', '500000', '5000.00']) {
      const complete = await click('complete', { ...prepared, amount });
      expect(complete.error).toBe(ClickError.IncorrectAmount);
    }
    expect((await paymentRow(paymentId)).status).toBe(PaymentStatus.pending);

    // The real amount, as Click formats it, still goes through afterwards.
    const ok = await click('complete', { ...prepared, amount: '50000.00' });
    expect(ok.error).toBe(ClickError.Success);
  });

  it('a Click-cancelled attempt leaves the payment pending; a retry can pay', async () => {
    const first = await invoiceAndPrepare();
    const cancelled = await click('complete', { ...first, error: '-5017' });
    expect(cancelled.error).toBe(ClickError.TransactionCancelled);
    expect((await paymentRow(first.paymentId)).status).toBe('pending');

    // The participant taps the same link again → a new Click transaction.
    const clickTransId = nextClickTransId++;
    const retry = await click('prepare', {
      paymentId: first.paymentId,
      clickTransId,
    });
    expect(retry.error).toBe(ClickError.Success);
    // The old transaction can no longer complete.
    expect((await click('complete', first)).error).toBe(
      ClickError.TransactionNotFound,
    );
    const done = await click('complete', {
      paymentId: first.paymentId,
      clickTransId,
      prepareId: first.prepareId,
    });
    expect(done.error).toBe(ClickError.Success);
    expect((await paymentRow(first.paymentId)).status).toBe('paid');
  });

  it('answers unknown orders, Complete-before-Prepare and already-paid with Click’s codes', async () => {
    const unknown = await click('prepare', {
      paymentId: '00000000-0000-4000-8000-000000000000',
    });
    expect(unknown.error).toBe(ClickError.OrderNotFound);
    const notUuid = await click('prepare', { paymentId: '1 OR 1=1' });
    expect(notUuid.error).toBe(ClickError.OrderNotFound);

    const participant = await createParticipant();
    const { paymentId } = await payments.createInvoice(participant.id);
    const row = await paymentRow(paymentId);
    const early = await click('complete', {
      paymentId,
      clickTransId: 77n,
      prepareId: row.clickPrepareId,
    });
    expect(early.error).toBe(ClickError.TransactionNotFound);

    const prepared = await invoiceAndPrepare(participant);
    await click('complete', prepared);
    const again = await click('prepare', {
      paymentId,
      clickTransId: nextClickTransId++,
    });
    expect(again.error).toBe(ClickError.AlreadyPaid);
  });

  it('refuses Click on an invoice past its 2-hour hold (its place may be gone)', async () => {
    const prepared = await invoiceAndPrepare();
    await prisma.payment.update({
      where: { id: prepared.paymentId },
      data: { createdAt: new Date(Date.now() - 121 * 60_000) },
    });

    expect((await click('complete', prepared)).error).toBe(
      ClickError.TransactionCancelled,
    );
    const prepare = await click('prepare', {
      paymentId: prepared.paymentId,
      clickTransId: nextClickTransId++,
    });
    expect(prepare.error).toBe(ClickError.TransactionCancelled);
    expect((await paymentRow(prepared.paymentId)).paidAt).toBeNull();
  });

  it('refund: paid → refund_requested → refunded, recording who and when', async () => {
    const prepared = await invoiceAndPrepare();
    await click('complete', prepared);

    const before = Date.now();
    const requested = await payments.requestRefund(prepared.paymentId, 4242);
    expect(requested).toMatchObject({
      status: 'refund_requested',
      refundRequestedBy: 4242n,
      refundedAt: null,
      refundApprovedBy: null,
    });
    expect(requested.refundRequestedAt!.getTime()).toBeGreaterThanOrEqual(
      before,
    );

    const approved = await payments.approveRefund(prepared.paymentId, 4343);
    const row = await paymentRow(prepared.paymentId);
    expect(row).toEqual(approved);
    expect(row).toMatchObject({
      status: 'refunded',
      refundRequestedBy: 4242n,
      refundApprovedBy: 4343n,
    });
    expect(row.refundedAt!.getTime()).toBeGreaterThanOrEqual(
      row.refundRequestedAt!.getTime(),
    );
    expect(logged).toContain(
      `Refund approved: payment ${row.id} by admin 4343 at ${row.refundedAt!.toISOString()}`,
    );

    // Terminal: can't be approved twice or paid again.
    await expect(
      payments.approveRefund(prepared.paymentId, 4343),
    ).rejects.toBeInstanceOf(InvalidPaymentTransitionError);
    expect((await click('complete', prepared)).error).toBe(ClickError.Success);
    expect((await paymentRow(prepared.paymentId)).status).toBe('refunded');
  });

  it('rejects pending → refunded and pending → refund_requested', async () => {
    const participant = await createParticipant();
    const { paymentId } = await payments.createInvoice(participant.id);

    await expect(payments.approveRefund(paymentId, 1)).rejects.toMatchObject({
      from: 'pending',
      to: 'refunded',
    });
    await expect(payments.requestRefund(paymentId, 1)).rejects.toBeInstanceOf(
      InvalidPaymentTransitionError,
    );
    expect(await paymentRow(paymentId)).toMatchObject({
      status: 'pending',
      refundApprovedBy: null,
      refundRequestedBy: null,
    });
  });

  describe('devMarkPaid (dev-only bypass)', () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      ALLOW: process.env.ALLOW_DEV_PAYMENT_BYPASS,
    };
    afterEach(() => {
      process.env.NODE_ENV = saved.NODE_ENV;
      if (saved.ALLOW === undefined) {
        delete process.env.ALLOW_DEV_PAYMENT_BYPASS;
      } else process.env.ALLOW_DEV_PAYMENT_BYPASS = saved.ALLOW;
    });

    it('runs the same pending → paid as Click, QR + Sheets included, logged loudly', async () => {
      process.env.NODE_ENV = 'development';
      process.env.ALLOW_DEV_PAYMENT_BYPASS = 'true';
      const sheetsSpy = jest.spyOn(
        app.get(SheetsSyncService),
        'paymentStatusChanged',
      );
      const participant = await createParticipant();
      const { paymentId } = await payments.createInvoice(participant.id);
      sheetsSpy.mockClear();

      const paid = await payments.devMarkPaid(participant.id, 4242);
      expect(paid.id).toBe(paymentId);
      const row = await paymentRow(paymentId);
      expect(row.status).toBe(PaymentStatus.paid);
      expect(row.paidAt).toBeInstanceOf(Date);
      // Distinguishable from a real Click payment: no Click transaction recorded.
      expect(row).toMatchObject({ clickTransId: null, preparedAt: null });
      expect(qr.sendQr.mock.calls).toEqual([[participant.id, 'issued']]);
      expect(sheetsSpy).toHaveBeenCalledWith(participant.id);
      expect(logged).toContain(`Payment ${paymentId} paid`);
      expect(logged).toContain(
        `DEV BYPASS: payment ${paymentId} marked paid manually by admin 4242 — not a Click transaction`,
      );

      // A second use is a rejected paid → paid, not a second QR.
      await expect(
        payments.devMarkPaid(participant.id, 4242),
      ).rejects.toBeInstanceOf(InvalidPaymentTransitionError);
      expect(qr.sendQr).toHaveBeenCalledTimes(1);
      sheetsSpy.mockRestore();
    });

    it.each([
      ['production', 'true'],
      ['development', undefined],
    ])(
      'is refused (NODE_ENV=%s, flag=%p) without touching the payment',
      async (nodeEnv, allow) => {
        process.env.NODE_ENV = nodeEnv;
        if (allow === undefined) delete process.env.ALLOW_DEV_PAYMENT_BYPASS;
        else process.env.ALLOW_DEV_PAYMENT_BYPASS = allow;
        const participant = await createParticipant();
        const { paymentId } = await payments.createInvoice(participant.id);

        await expect(
          payments.devMarkPaid(participant.id, 4242),
        ).rejects.toBeInstanceOf(DevPaymentBypassDisabledError);
        expect((await paymentRow(paymentId)).status).toBe('pending');
        expect(qr.sendQr).not.toHaveBeenCalled();
      },
    );

    it('refuses an invoice past its 2-hour hold, like Click', async () => {
      process.env.NODE_ENV = 'development';
      process.env.ALLOW_DEV_PAYMENT_BYPASS = 'true';
      const participant = await createParticipant();
      const { paymentId } = await payments.createInvoice(participant.id);
      await prisma.payment.update({
        where: { id: paymentId },
        data: { createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
      });

      await expect(
        payments.devMarkPaid(participant.id, 4242),
      ).rejects.toBeInstanceOf(PaymentOverdueError);
      expect((await paymentRow(paymentId)).status).toBe('pending');
      expect(qr.sendQr).not.toHaveBeenCalled();
    });
  });

  it('createInvoice is idempotent per participant, also under concurrency', async () => {
    const participant = await createParticipant();
    const invoices = await Promise.all(
      Array.from({ length: 5 }, () => payments.createInvoice(participant.id)),
    );
    expect(new Set(invoices.map((i) => i.paymentId)).size).toBe(1);
    expect(await prisma.payment.count()).toBe(1);
  });

  it('refuses to invoice a participant without a capped place', async () => {
    const participant = await createParticipant(null);
    await expect(payments.createInvoice(participant.id)).rejects.toBeInstanceOf(
      PaymentNotAllowedError,
    );
    await expect(
      payments.createInvoice('00000000-0000-4000-8000-000000000000'),
    ).rejects.toBeInstanceOf(PaymentNotAllowedError);
  });

  it('rejects a malformed body without touching the database', async () => {
    const res = await request(app.getHttpServer())
      .post('/click/complete')
      .type('form')
      .send({ click_trans_id: '1', amount: '50000' })
      .expect(200);
    expect(res.body).toMatchObject({ error: ClickError.BadRequest });
  });
});
