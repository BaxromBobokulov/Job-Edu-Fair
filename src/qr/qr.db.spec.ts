/**
 * QR issuance on the `paid` transition and the `/status` resend, against real
 * Postgres (own `qrbot_test_qr` schema) and the real bot module with a faked
 * Telegram API. Click is simulated: Complete requests are signed here.
 */
import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TestingModule } from '@nestjs/testing';
import { PaymentStatus, Track } from '@prisma/client';
import QRCode from 'qrcode';
import { Telegraf, Telegram } from 'telegraf';
import { describeDb, setUpTestDatabase } from '../../test/test-db';
import {
  createTestBot,
  SentMessage,
  textUpdate,
} from '../../test/telegram-fakes';
import { BotModule } from '../bot/bot.module';
import { Lang, t } from '../i18n/i18n';
import { ParticipantsService } from '../participants/participants.service';
import { ClickSettings } from '../payments/click.config';
import {
  ClickError,
  ClickRawRequest,
  clickSignature,
  VerifiedClickRequest,
  verifyClickRequest,
} from '../payments/click.protocol';
import { PaymentsService } from '../payments/payments.service';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from './qr.service';

const TEST_SCHEMA = 'qrbot_test_qr';
const SECRET = 'test-secret';
const SERVICE_ID = '111';

/**
 * The image a participant must receive: `text` (normally `JEF26:<qrToken>`),
 * rendered with the track's colour. Written out here, not taken from
 * qr.service, so a wrong payload, prefix, colour or quiet zone in the service
 * fails the comparison.
 */
function expectedPng(text: string, dark: string): Promise<Buffer> {
  // Same pixels for any PNG filter; the filter only changes the bytes.
  const rendererOpts = { deflateLevel: 9, filterType: 2 };
  return QRCode.toBuffer(text, {
    type: 'png',
    errorCorrectionLevel: 'M',
    margin: 4,
    width: 600,
    color: { dark, light: '#FFFFFFFF' },
    rendererOpts,
  });
}
/** This event's QR text for a token. */
const jef26 = (qrToken: string) => `JEF26:${qrToken}`;
const GREEN = '#006B3CFF';
const BLUE = '#0047ABFF';

/** Polls until `check` holds — for the QR send, which handleComplete doesn't await. */
async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describeDb('QR issuance (Postgres + bot)', () => {
  jest.setTimeout(60_000);

  let prisma: PrismaService;
  let moduleRef: TestingModule;
  let bot: Telegraf;
  let sent: SentMessage[];
  let participants: ParticipantsService;
  let payments: PaymentsService;
  const errors: string[] = [];

  beforeAll(async () => {
    prisma = await setUpTestDatabase(TEST_SCHEMA);
    ({ moduleRef, bot, sent } = await createTestBot([
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
      BotModule,
    ]));
    participants = moduleRef.get(ParticipantsService);
    payments = moduleRef.get(PaymentsService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation((msg: unknown) => {
      errors.push(String(msg));
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
    errors.length = 0;
  });

  let nextTelegramId = 1;
  let nextClickTransId = 700_000_001n;

  async function register(lang: Lang, track: Track) {
    const telegramId = nextTelegramId++;
    const p = await participants.register({
      telegramId,
      languageCode: lang,
      phone: `+99894${String(telegramId).padStart(7, '0')}`,
      fullName: 'Aziz Karimov',
      birthYearOrCourse: '2003',
      direction: 'Backend',
      hasSkillAndPortfolio: track === Track.JOB,
      cvLink: track === Track.JOB ? 'https://github.com/aziz' : null,
    });
    const participant = await prisma.participant.findUniqueOrThrow({
      where: { id: p.id },
      include: { payments: true },
    });
    expect(participant.track).toBe(track);
    return { telegramId, participant, paymentId: participant.payments[0].id };
  }

  const CLICK: ClickSettings = {
    serviceId: SERVICE_ID,
    merchantId: '222',
    secretKey: SECRET,
  };

  /** A Click request signed with the test secret, through the real verifier. */
  function signed(
    paymentId: string,
    clickTransId: bigint,
    prepareId?: number,
  ): VerifiedClickRequest {
    const stage = prepareId === undefined ? 'prepare' : 'complete';
    const fields: Omit<ClickRawRequest, 'sign_string'> = {
      click_trans_id: String(clickTransId),
      service_id: SERVICE_ID,
      click_paydoc_id: '4242',
      merchant_trans_id: paymentId,
      amount: '50000',
      action: stage === 'prepare' ? '0' : '1',
      error: '0',
      error_note: 'Success',
      sign_time: '2026-10-20 12:00:00',
      ...(prepareId !== undefined && {
        merchant_prepare_id: String(prepareId),
      }),
    };
    const verified = verifyClickRequest(
      { ...fields, sign_string: clickSignature(fields, SECRET) },
      stage,
      CLICK,
    );
    if (!verified.ok) throw new Error(`signing failed: ${verified.error}`);
    return verified.request;
  }

  /** Prepare + Complete; returns Complete's answer and how to replay it. */
  async function payViaClick(paymentId: string) {
    const clickTransId = nextClickTransId++;
    const prepared = await payments.handlePrepare(
      signed(paymentId, clickTransId),
    );
    expect(prepared.error).toBe(ClickError.Success);
    const complete = signed(paymentId, clickTransId, prepared.merchantId);
    const { error } = await payments.handleComplete(complete);
    return { error, complete };
  }

  const photosTo = (chatId: number) =>
    sent.filter((m) => m.chatId === chatId && m.photo);
  const paymentStatus = async (id: string) =>
    (await prisma.payment.findUniqueOrThrow({ where: { id } })).status;

  it.each([
    ['uz', Track.JOB, GREEN],
    ['ru', Track.EDU, BLUE],
    ['en', Track.JOB, GREEN],
  ] as const)(
    'paid (%s, %s) → the QR of the participant’s qrToken, in the track colour, in their language',
    async (lang, track, colour) => {
      const { telegramId, participant, paymentId } = await register(
        lang,
        track,
      );

      expect((await payViaClick(paymentId)).error).toBe(ClickError.Success);
      await until(() => photosTo(telegramId).length === 1);

      const [qr] = photosTo(telegramId);
      expect(qr.text).toBe(t(`qr.issued.${track}`, lang));
      expect(
        qr.photo!.equals(await expectedPng(jef26(participant.qrToken), colour)),
      ).toBe(true);
      // Not the bare token, not the row id, not the other track's colour.
      const other = colour === GREEN ? BLUE : GREEN;
      expect(
        qr.photo!.equals(await expectedPng(participant.qrToken, colour)),
      ).toBe(false);
      expect(
        qr.photo!.equals(await expectedPng(jef26(participant.id), colour)),
      ).toBe(false);
      expect(
        qr.photo!.equals(await expectedPng(jef26(participant.qrToken), other)),
      ).toBe(false);
      expect(await paymentStatus(paymentId)).toBe(PaymentStatus.paid);
    },
  );

  it('a replayed Complete does not send the QR again', async () => {
    const { telegramId, paymentId } = await register('en', Track.EDU);
    const { error, complete } = await payViaClick(paymentId);
    expect(error).toBe(ClickError.Success);
    await until(() => photosTo(telegramId).length === 1);

    expect((await payments.handleComplete(complete)).error).toBe(
      ClickError.Success,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(photosTo(telegramId)).toHaveLength(1);
  });

  it('/status resends the same QR image to a paid participant, even with no session', async () => {
    const { telegramId, participant, paymentId } = await register(
      'ru',
      Track.JOB,
    );
    await payViaClick(paymentId);
    await until(() => photosTo(telegramId).length === 1);
    sent.length = 0;

    await bot.handleUpdate(textUpdate(telegramId, '/status'));

    expect(sent).toHaveLength(1);
    const [resent] = sent;
    expect(resent.chatId).toBe(telegramId);
    expect(resent.text).toBe(
      t('qr.resend', 'ru', { track: t('track.JOB', 'ru') }),
    );
    expect(
      resent.photo!.equals(
        await expectedPng(jef26(participant.qrToken), GREEN),
      ),
    ).toBe(true);
  });

  it('/status sends no QR once a refund is requested', async () => {
    const { telegramId, paymentId } = await register('en', Track.EDU);
    await payViaClick(paymentId);
    await until(() => photosTo(telegramId).length === 1);
    await payments.requestRefund(paymentId, 4242);
    sent.length = 0;

    await bot.handleUpdate(textUpdate(telegramId, '/status'));
    expect(sent).toEqual([
      { chatId: telegramId, text: t('status.refund_requested', 'en') },
    ]);
  });

  it('a QR generation failure leaves the payment paid, is logged, and /status recovers', async () => {
    const { telegramId, participant, paymentId } = await register(
      'uz',
      Track.EDU,
    );
    jest
      .spyOn(QrService.prototype, 'issueQr')
      .mockRejectedValueOnce(new Error('qrcode exploded'));

    // Click is still told the payment succeeded.
    expect((await payViaClick(paymentId)).error).toBe(ClickError.Success);
    await until(() => errors.length > 0);

    expect(await paymentStatus(paymentId)).toBe(PaymentStatus.paid);
    expect(errors).toEqual([
      `QR delivery FAILED for paid participant ${participant.id} — payment stays paid; the participant gets the QR via /status`,
    ]);
    expect(photosTo(telegramId)).toEqual([]);

    await bot.handleUpdate(textUpdate(telegramId, '/status'));
    const [recovered] = photosTo(telegramId);
    expect(
      recovered.photo!.equals(
        await expectedPng(jef26(participant.qrToken), BLUE),
      ),
    ).toBe(true);
  });

  it('a Telegram failure on send leaves the payment paid too', async () => {
    const { telegramId, paymentId } = await register('en', Track.JOB);
    // E.g. the participant blocked the bot right after paying.
    jest
      .spyOn(Telegram.prototype, 'callApi')
      .mockRejectedValueOnce(new Error('403: bot was blocked by the user'));

    expect((await payViaClick(paymentId)).error).toBe(ClickError.Success);
    await until(() => errors.length > 0);
    expect(errors[0]).toMatch(/^QR delivery FAILED for paid participant/);
    expect(await paymentStatus(paymentId)).toBe(PaymentStatus.paid);
    expect(photosTo(telegramId)).toEqual([]);
  });

  it('/status says so when the QR can’t be sent right now', async () => {
    const { telegramId, paymentId } = await register('en', Track.JOB);
    await payViaClick(paymentId);
    await until(() => photosTo(telegramId).length === 1);
    sent.length = 0;
    jest
      .spyOn(QrService.prototype, 'issueQr')
      .mockRejectedValueOnce(new Error('qrcode exploded'));

    await bot.handleUpdate(textUpdate(telegramId, '/status'));
    expect(sent).toEqual([
      { chatId: telegramId, text: t('qr.unavailable', 'en') },
    ]);
    expect(await paymentStatus(paymentId)).toBe(PaymentStatus.paid);
  });
});
