import { Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import {
  createTestBot,
  SentMessage,
  textUpdate,
} from '../../test/telegram-fakes';
import { BotModule } from '../bot/bot.module';
import { ParticipantsService } from '../participants/participants.service';
import { HrScannerService } from '../hr/hr-scanner.service';
import { InvalidPaymentTransitionError } from '../payments/payments.errors';
import { PaymentsService } from '../payments/payments.service';
import { QrService } from '../qr/qr.service';
import { AdminModule } from './admin.module';

const ADMIN = 4242;
const OTHER_ADMIN = 4343;
const STRANGER = 777;
const PAYMENT_ID = '0b3f6c1e-8d7a-4c2b-9f1e-2a3b4c5d6e7f';

describe('admin refund commands', () => {
  let bot: Telegraf;
  let sent: SentMessage[];
  const payments = {
    requestRefund: jest.fn(),
    approveRefund: jest.fn(),
    listRefundRequests: jest.fn(),
    findByPhone: jest.fn(),
    createInvoice: jest.fn(),
    getStatusByTelegramId: jest.fn(),
    devMarkPaid: jest.fn(),
  };

  beforeAll(async () => {
    // BotModule included so the language gate is in play (admins never pick one).
    const testBot = await createTestBot(
      [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ ADMIN_TELEGRAM_IDS: `${ADMIN}, ${OTHER_ADMIN}` })],
        }),
        BotModule,
        AdminModule,
      ],
      (b) =>
        b
          .overrideProvider(PaymentsService)
          .useValue(payments)
          .overrideProvider(ParticipantsService)
          .useValue({})
          .overrideProvider(QrService)
          .useValue({})
          .overrideProvider(HrScannerService)
          .useValue({ findHr: () => Promise.resolve(null) }),
    );
    bot = testBot.bot;
    sent = testBot.sent;
  });

  beforeEach(() => {
    sent.length = 0;
    for (const fn of Object.values(payments)) fn.mockReset();
  });

  const send = (from: number, text: string) =>
    bot.handleUpdate(textUpdate(from, text));

  it('ignores refund commands from non-admins', async () => {
    await send(STRANGER, `/refund_request ${PAYMENT_ID}`);
    await send(STRANGER, `/refund_approve ${PAYMENT_ID}`);
    await send(STRANGER, '/refunds');
    await send(STRANGER, '/payment_lookup +998901234567');

    expect(payments.requestRefund).not.toHaveBeenCalled();
    expect(payments.approveRefund).not.toHaveBeenCalled();
    expect(payments.listRefundRequests).not.toHaveBeenCalled();
    expect(payments.findByPhone).not.toHaveBeenCalled();
    // Not even an error reply — but the language gate may show its picker.
    expect(sent.every((m) => !m.text.includes('Refund'))).toBe(true);
  });

  it('records the requesting and the approving admin separately', async () => {
    payments.requestRefund.mockResolvedValue({ id: PAYMENT_ID });
    payments.approveRefund.mockResolvedValue({
      id: PAYMENT_ID,
      refundedAt: new Date('2026-10-20T10:00:00.000Z'),
    });

    await send(ADMIN, `/refund_request ${PAYMENT_ID}`);
    expect(payments.requestRefund).toHaveBeenCalledWith(PAYMENT_ID, ADMIN);
    expect(sent.at(-1)?.text).toContain(`/refund_approve ${PAYMENT_ID}`);

    await send(OTHER_ADMIN, `/refund_approve ${PAYMENT_ID}`);
    expect(payments.approveRefund).toHaveBeenCalledWith(
      PAYMENT_ID,
      OTHER_ADMIN,
    );
    expect(sent.at(-1)?.text).toBe(
      `Payment ${PAYMENT_ID} marked refunded (approved by ${OTHER_ADMIN} at 2026-10-20T10:00:00.000Z).`,
    );
  });

  it('explains a rejected transition instead of failing silently', async () => {
    payments.approveRefund.mockRejectedValue(
      new InvalidPaymentTransitionError('pending', 'refunded'),
    );
    await send(ADMIN, `/refund_approve ${PAYMENT_ID}`);
    expect(sent.at(-1)?.text).toBe(
      'Not allowed: the payment is pending, it cannot become refunded.',
    );
  });

  it('shows usage when the argument is missing', async () => {
    await send(ADMIN, '/refund_approve');
    expect(sent.at(-1)?.text).toBe('Usage: /refund_approve <paymentId>');
    expect(payments.approveRefund).not.toHaveBeenCalled();
  });

  it('looks payments up by normalized phone', async () => {
    payments.findByPhone.mockResolvedValue([]);
    await send(ADMIN, '/payment_lookup 998 90 123 45 67');
    expect(payments.findByPhone).toHaveBeenCalledWith('+998901234567');
    expect(sent.at(-1)?.text).toBe('No payment for that phone number.');
  });

  it('labels the participant id in a lookup result (for /dev_mark_paid)', async () => {
    const participantId = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
    payments.findByPhone.mockResolvedValue([
      {
        id: PAYMENT_ID,
        participantId,
        status: 'paid',
        amount: 50_000,
        refundRequestedAt: null,
        participant: { fullName: 'Aziz Karimov', phone: '+998901234567' },
      },
    ]);
    await send(ADMIN, '/payment_lookup +998901234567');
    expect(sent.at(-1)?.text).toBe(
      [
        PAYMENT_ID,
        '  Aziz Karimov, +998901234567',
        '  status: paid, amount: 50000',
        `  participant id: ${participantId}`,
      ].join('\n'),
    );
  });
});

describe('/dev_mark_paid (dev-only payment bypass)', () => {
  const PARTICIPANT_ID = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
  let bot: Telegraf;
  let sent: SentMessage[];
  let warnings: string[];
  const payments = { devMarkPaid: jest.fn() };
  const savedEnv = {
    NODE_ENV: process.env.NODE_ENV,
    ALLOW_DEV_PAYMENT_BYPASS: process.env.ALLOW_DEV_PAYMENT_BYPASS,
  };

  // Both gate variables come from process.env (not `load`), so each test can set them.
  function setEnv(nodeEnv: string, allow: string | undefined) {
    process.env.NODE_ENV = nodeEnv;
    if (allow === undefined) delete process.env.ALLOW_DEV_PAYMENT_BYPASS;
    else process.env.ALLOW_DEV_PAYMENT_BYPASS = allow;
  }

  beforeAll(async () => {
    const testBot = await createTestBot(
      [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ ADMIN_TELEGRAM_IDS: String(ADMIN) })],
        }),
        BotModule,
        AdminModule,
      ],
      (b) =>
        b
          .overrideProvider(PaymentsService)
          .useValue(payments)
          .overrideProvider(ParticipantsService)
          .useValue({})
          .overrideProvider(QrService)
          .useValue({})
          .overrideProvider(HrScannerService)
          .useValue({ findHr: () => Promise.resolve(null) }),
    );
    bot = testBot.bot;
    sent = testBot.sent;
  });

  beforeEach(() => {
    sent.length = 0;
    warnings = [];
    payments.devMarkPaid.mockReset().mockResolvedValue({ id: PAYMENT_ID });
    jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((message: unknown) => {
        warnings.push(String(message));
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setEnv(savedEnv.NODE_ENV ?? 'test', savedEnv.ALLOW_DEV_PAYMENT_BYPASS);
  });

  const send = (from: number, text: string) =>
    bot.handleUpdate(textUpdate(from, text));

  it('marks paid for an admin when enabled outside production', async () => {
    setEnv('development', 'true');
    await send(ADMIN, `/dev_mark_paid ${PARTICIPANT_ID}`);
    expect(payments.devMarkPaid).toHaveBeenCalledWith(PARTICIPANT_ID, ADMIN);
    expect(sent.at(-1)?.text).toBe(
      `DEV BYPASS: payment ${PAYMENT_ID} marked paid (no Click transaction). QR and Sheets sync triggered.`,
    );
  });

  it('refuses a non-admin even when enabled — no reply, logged', async () => {
    setEnv('development', 'true');
    await send(STRANGER, `/dev_mark_paid ${PARTICIPANT_ID}`);
    expect(payments.devMarkPaid).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(warnings).toContain(`Non-admin ${STRANGER} tried /dev_mark_paid`);
  });

  it('refuses an admin when NODE_ENV is production, even with the flag set', async () => {
    setEnv('production', 'true');
    await send(ADMIN, `/dev_mark_paid ${PARTICIPANT_ID}`);
    expect(payments.devMarkPaid).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(warnings.some((w) => w.startsWith('DEV BYPASS refused'))).toBe(true);
  });

  it.each([undefined, 'false', '1'])(
    'refuses an admin outside production when ALLOW_DEV_PAYMENT_BYPASS is %p',
    async (allow) => {
      setEnv('development', allow);
      await send(ADMIN, `/dev_mark_paid ${PARTICIPANT_ID}`);
      expect(payments.devMarkPaid).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
      expect(warnings.some((w) => w.startsWith('DEV BYPASS refused'))).toBe(
        true,
      );
    },
  );
});
