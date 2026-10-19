import { ConfigModule } from '@nestjs/config';
import { Telegraf } from 'telegraf';
import {
  createTestBot,
  SentMessage,
  textUpdate,
} from '../../test/telegram-fakes';
import { BotModule } from '../bot/bot.module';
import { ParticipantsService } from '../participants/participants.service';
import { InvalidPaymentTransitionError } from '../payments/payments.errors';
import { PaymentsService } from '../payments/payments.service';
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
          .useValue({}),
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
});
