import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf } from 'telegraf';
import { PaymentsService } from '../payments/payments.service';
import { expiryNotice } from './payment.update';
import { logUnexpected } from './scenes/registration.helpers';

/**
 * Every 10 minutes: expires invoices unpaid 2 hours after creation (their
 * place stopped counting at that moment already) and tells each participant,
 * in their stored language, that they can get a new link.
 *
 * Lives in the bot layer only for the notice — the expiry itself is
 * `PaymentsService.expireOverdue()`. Sending uses the bot's own Telegram
 * client, so no extra notification infrastructure is involved.
 */
@Injectable()
export class PaymentExpiryCron {
  private readonly logger = new Logger(PaymentExpiryCron.name);

  constructor(
    private readonly payments: PaymentsService,
    @InjectBot() private readonly bot: Telegraf,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'payment-expiry' })
  async run(): Promise<void> {
    let expired: Awaited<ReturnType<PaymentsService['expireOverdue']>>;
    try {
      expired = await this.payments.expireOverdue();
    } catch (err) {
      logUnexpected('expireOverdue', err);
      return;
    }
    if (expired.length > 0) {
      this.logger.log(`Expired ${expired.length} unpaid invoice(s)`);
    }

    for (const payment of expired) {
      if (payment.telegramId === null) continue; // PII purged: nobody to tell
      const { text, extra } = expiryNotice(payment.languageCode);
      try {
        await this.bot.telegram.sendMessage(
          Number(payment.telegramId),
          text,
          extra,
        );
      } catch (err) {
        // E.g. the participant blocked the bot; /status still works for them.
        logUnexpected(`expiry notice for payment ${payment.paymentId}`, err);
      }
    }
  }
}
