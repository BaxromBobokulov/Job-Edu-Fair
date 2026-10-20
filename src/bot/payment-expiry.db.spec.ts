/**
 * Expiry job + moving-window cap + retry, against real Postgres (own
 * `qrbot_test_expiry` schema) and the real bot module with a faked Telegram API.
 */
import { Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TestingModule } from '@nestjs/testing';
import { PaymentStatus } from '@prisma/client';
import { Telegraf } from 'telegraf';
import { describeDb, setUpTestDatabase } from '../../test/test-db';
import {
  callbackUpdate,
  createTestBot,
  SentMessage,
  textUpdate,
} from '../../test/telegram-fakes';
import { Lang, t } from '../i18n/i18n';
import { RegistrationClosedError } from '../participants/participants.errors';
import { ParticipantsService } from '../participants/participants.service';
import { InvalidPaymentTransitionError } from '../payments/payments.errors';
import { PaymentsService } from '../payments/payments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { BotModule } from './bot.module';
import { PaymentExpiryCron } from './payment-expiry.cron';

const TEST_SCHEMA = 'qrbot_test_expiry';
const MINUTE = 60_000;

describeDb('payment expiry (Postgres + bot)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaService;
  let moduleRef: TestingModule;
  let bot: Telegraf;
  let sent: SentMessage[];
  let participants: ParticipantsService;
  let cron: PaymentExpiryCron;
  const cap = { value: 2 };
  const logged: string[] = [];

  beforeAll(async () => {
    prisma = await setUpTestDatabase(TEST_SCHEMA);
    ({ moduleRef, bot, sent } = await createTestBot([
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [
          () => ({
            CLICK_SERVICE_ID: '111',
            CLICK_MERCHANT_ID: '222',
            CLICK_SECRET_KEY: 'test-secret',
          }),
        ],
      }),
      PrismaModule,
      BotModule,
    ]));
    participants = moduleRef.get(ParticipantsService);
    cron = moduleRef.get(PaymentExpiryCron);
    // MAX_PARTICIPANTS is read per call, so each test can set its own cap.
    const config = moduleRef.get(ConfigService);
    // The prototype method, untouched by the instance spy below.
    // Explicit signature: `.call` on the overloaded `get` resolves to its 4-argument form.
    const realGet =
      ConfigService.prototype.get.bind<(key: string) => unknown>(config);
    jest
      .spyOn(config, 'get')
      .mockImplementation((key: string) =>
        key === 'MAX_PARTICIPANTS' ? cap.value : realGet(key),
      );
    jest.spyOn(Logger.prototype, 'log').mockImplementation((msg: unknown) => {
      logged.push(String(msg));
    });
  });

  afterAll(async () => {
    // Not moduleRef.close(): the test bot was never launched, so stopping it throws.
    await moduleRef?.get(PrismaService).$disconnect();
    await prisma?.$disconnect();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE "Participant" CASCADE');
    sent.length = 0;
    logged.length = 0;
  });

  let nextTelegramId = 1;
  async function register(lang: Lang) {
    const telegramId = nextTelegramId++;
    const p = await participants.register({
      telegramId,
      languageCode: lang,
      phone: `+99893${String(telegramId).padStart(7, '0')}`,
      fullName: 'Aziz Karimov',
      birthYearOrCourse: '2003',
      direction: 'Backend',
      hasSkillAndPortfolio: false,
    });
    const payment = await prisma.payment.findFirstOrThrow({
      where: { participantId: p.id },
    });
    return { telegramId, participantId: p.id, paymentId: payment.id };
  }

  /** Moves a payment's createdAt into the past. */
  const age = (paymentId: string, minutes: number) =>
    prisma.payment.update({
      where: { id: paymentId },
      data: { createdAt: new Date(Date.now() - minutes * MINUTE) },
    });

  const paymentsOf = (participantId: string) =>
    prisma.payment.findMany({
      where: { participantId },
      orderBy: { createdAt: 'asc' },
    });

  const sentTo = (chatId: number) => sent.filter((m) => m.chatId === chatId);

  it('expires an invoice unpaid >2h; its place goes to someone else', async () => {
    cap.value = 2;
    const a = await register('uz');
    const b = await register('ru');
    await expect(register('en')).rejects.toBeInstanceOf(
      RegistrationClosedError,
    );

    await age(a.paymentId, 121); // past the window
    await age(b.paymentId, 119); // still inside it
    await cron.run();

    const [aPayment] = await paymentsOf(a.participantId);
    expect(aPayment).toMatchObject({ status: PaymentStatus.expired });
    expect(aPayment.expiredAt).toBeInstanceOf(Date);
    expect((await paymentsOf(b.participantId))[0].status).toBe('pending');
    expect(logged).toContain(
      `Payment ${a.paymentId} (participant ${a.participantId}) expired at ${aPayment.expiredAt!.toISOString()}`,
    );

    // A is told, in uz, with a retry button; B hears nothing.
    expect(sentTo(a.telegramId)).toEqual([
      {
        chatId: a.telegramId,
        text: t('payment.expired', 'uz'),
        buttons: [t('payment.retryButton', 'uz')],
      },
    ]);
    expect(sentTo(b.telegramId)).toEqual([]);

    // A's place is free again.
    const c = await register('en');
    expect((await paymentsOf(c.participantId))[0].status).toBe('pending');

    // A second run neither re-expires nor re-notifies.
    sent.length = 0;
    await cron.run();
    expect(sent).toEqual([]);
  });

  it('retry after expiry: a fresh invoice when a place is free', async () => {
    cap.value = 2;
    const a = await register('ru');
    await age(a.paymentId, 180);
    await cron.run();

    await bot.handleUpdate(callbackUpdate(a.telegramId, 'pay:retry'));

    const [old, fresh] = await paymentsOf(a.participantId);
    expect(old).toMatchObject({ id: a.paymentId, status: 'expired' });
    expect(fresh).toMatchObject({ status: 'pending', amount: 50_000 });
    expect(fresh.id).not.toBe(old.id);
    expect(sentTo(a.telegramId).at(-1)).toEqual({
      chatId: a.telegramId,
      text: t('status.pending', 'ru', { amount: '50 000' }),
      buttons: [t('payment.button', 'ru', { amount: '50 000' })],
      urls: [
        `https://my.click.uz/services/pay?service_id=111&merchant_id=222&amount=50000&transaction_param=${fresh.id}`,
      ],
    });

    // Pressing again (or /status) reuses that invoice instead of adding more.
    await bot.handleUpdate(textUpdate(a.telegramId, '/status'));
    expect(await paymentsOf(a.participantId)).toHaveLength(2);
  });

  it('retry after expiry is refused when the place was taken meanwhile', async () => {
    cap.value = 1;
    const a = await register('en');
    await age(a.paymentId, 180);
    await cron.run();
    const b = await register('uz'); // takes the only place

    await bot.handleUpdate(callbackUpdate(a.telegramId, 'pay:retry'));
    await bot.handleUpdate(textUpdate(a.telegramId, '/status'));

    expect(sentTo(a.telegramId).slice(-2)).toEqual([
      { chatId: a.telegramId, text: t('registration.closed', 'en') },
      { chatId: a.telegramId, text: t('registration.closed', 'en') },
    ]);
    expect(await paymentsOf(a.participantId)).toEqual([
      expect.objectContaining({ id: a.paymentId, status: 'expired' }),
    ]);
    expect((await paymentsOf(b.participantId))[0].status).toBe('pending');
  });

  it('the place frees at 2h even before the job runs; a late retry expires the stale invoice itself', async () => {
    cap.value = 1;
    const a = await register('en');
    await age(a.paymentId, 125);
    const b = await register('ru'); // no cron run in between

    await bot.handleUpdate(textUpdate(a.telegramId, '/status'));
    expect(sentTo(a.telegramId).at(-1)?.text).toBe(
      t('registration.closed', 'en'),
    );
    expect((await paymentsOf(a.participantId))[0]).toMatchObject({
      status: 'expired',
    });
    expect((await paymentsOf(b.participantId))[0].status).toBe('pending');
  });

  /** Marks a pending payment paid, as a verified Click Complete would. */
  const markPaid = (paymentId: string, createdMinutesAgo = 0) =>
    prisma.payment.update({
      where: { id: paymentId },
      data: {
        status: 'paid',
        paidAt: new Date(),
        createdAt: new Date(Date.now() - createdMinutesAgo * MINUTE),
      },
    });

  it('only paid and fresh pending participants hold a place; refund_requested, refunded and expired don’t', async () => {
    cap.value = 4;
    const payments = moduleRef.get(PaymentsService);
    const paid = await register('en');
    const refundRequested = await register('en');
    const refunded = await register('en');
    await register('en'); // fresh pending: holds a place
    await markPaid(paid.paymentId, 600);
    await markPaid(refundRequested.paymentId);
    await markPaid(refunded.paymentId);
    await expect(register('en')).rejects.toBeInstanceOf(
      RegistrationClosedError,
    );

    // A refund request frees the place right away — no waiting for `refunded`.
    await payments.requestRefund(refundRequested.paymentId, 4242);
    await register('en');
    await expect(register('en')).rejects.toBeInstanceOf(
      RegistrationClosedError,
    );

    // A full refund frees one too.
    await payments.requestRefund(refunded.paymentId, 4242);
    await payments.approveRefund(refunded.paymentId, 4343);
    await register('en');
    await expect(register('en')).rejects.toBeInstanceOf(
      RegistrationClosedError,
    );

    await cron.run(); // paid long ago, but paid: never expired
    expect((await paymentsOf(paid.participantId))[0].status).toBe('paid');
  });

  it('a freed refund_requested place, once taken, can’t be re-claimed: there is no way back to paid', async () => {
    cap.value = 1;
    const payments = moduleRef.get(PaymentsService);
    const a = await register('ru');
    await markPaid(a.paymentId);
    await payments.requestRefund(a.paymentId, 4242);
    const b = await register('uz'); // takes A's freed place immediately

    // Every path that changes a payment refuses to move A back to holding a place.
    await expect(payments.expire(a.paymentId)).rejects.toBeInstanceOf(
      InvalidPaymentTransitionError,
    );
    await expect(payments.requestRefund(a.paymentId, 4242)).rejects.toThrow(
      InvalidPaymentTransitionError,
    );
    // A retry (/status, the retry button) neither re-invoices nor re-activates.
    expect(await payments.createInvoice(a.participantId)).toMatchObject({
      paymentId: a.paymentId,
      status: 'refund_requested',
      payUrl: null,
    });
    await bot.handleUpdate(callbackUpdate(a.telegramId, 'pay:retry'));
    expect(sentTo(a.telegramId).at(-1)?.text).toBe(
      t('status.refund_requested', 'ru'),
    );
    // A second payment row is impossible too (the "one active payment" index).
    await expect(
      prisma.payment.create({
        data: { participantId: a.participantId, amount: 50_000 },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    expect(await paymentsOf(a.participantId)).toEqual([
      expect.objectContaining({ id: a.paymentId, status: 'refund_requested' }),
    ]);
    expect((await paymentsOf(b.participantId))[0].status).toBe('pending');

    // The only way forward is refunded, which is terminal.
    await payments.approveRefund(a.paymentId, 4343);
    await expect(payments.approveRefund(a.paymentId, 4343)).rejects.toThrow(
      InvalidPaymentTransitionError,
    );
  });
});
