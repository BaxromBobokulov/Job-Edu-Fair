import { Action, Command, Ctx, Update } from 'nestjs-telegraf';
import { Markup } from 'telegraf';
import { Lang, t } from '../i18n/i18n';
import { RegistrationClosedError } from '../participants/participants.errors';
import { Invoice, PaymentsService } from '../payments/payments.service';
import { QrService } from '../qr/qr.service';
import { LANGUAGE_SCENE_ID, PAY_RETRY_CALLBACK } from './bot.constants';
import type { BotContext } from './bot.context';
import { logUnexpected, replyT } from './scenes/registration.helpers';

/** 50000 → "50 000", the way the amount is written everywhere else in the bot. */
export function formatAmount(amount: number): string {
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function payKeyboard(invoice: Invoice, lang: Lang) {
  return invoice.payUrl
    ? Markup.inlineKeyboard([
        Markup.button.url(
          t('payment.button', lang, { amount: formatAmount(invoice.amount) }),
          invoice.payUrl,
        ),
      ])
    : undefined;
}

/** Sent by the expiry job (outside any conversation, hence no ctx). */
export function expiryNotice(lang: Lang) {
  return {
    text: t('payment.expired', lang),
    extra: Markup.inlineKeyboard([
      Markup.button.callback(
        t('payment.retryButton', lang),
        PAY_RETRY_CALLBACK,
      ),
    ]),
  };
}

/** The message right after registration: fee + Click pay button. */
export async function sendPaymentOffer(
  ctx: BotContext,
  payments: PaymentsService,
  participantId: string,
  lang: Lang,
): Promise<void> {
  let invoice: Invoice;
  try {
    invoice = await payments.createInvoice(participantId);
  } catch (err) {
    if (err instanceof RegistrationClosedError) {
      await ctx.reply(t('registration.closed', lang));
      return;
    }
    logUnexpected('createInvoice', err);
    await ctx.reply(t('payment.unavailable', lang));
    return;
  }
  await sendInvoice(ctx, invoice, lang, 'payment.offer');
}

async function sendInvoice(
  ctx: BotContext,
  invoice: Invoice,
  lang: Lang,
  pendingKey: 'payment.offer' | 'status.pending',
): Promise<void> {
  if (invoice.status !== 'pending') {
    await ctx.reply(t(`status.${invoice.status}`, lang));
  } else if (!invoice.payUrl) {
    await ctx.reply(t('payment.unavailable', lang));
  } else {
    await ctx.reply(
      t(pendingKey, lang, { amount: formatAmount(invoice.amount) }),
      payKeyboard(invoice, lang),
    );
  }
}

/**
 * `/status` and the "new payment link" button: the participant's current
 * payment state, with the pay button while unpaid. After an expiry this is
 * where a fresh invoice is created — if a place is still free. Once paid it
 * resends the QR image: the "I lost my QR" (or "it never arrived") path.
 */
@Update()
export class PaymentUpdate {
  constructor(
    private readonly payments: PaymentsService,
    private readonly qr: QrService,
  ) {}

  @Command('status')
  async onStatus(@Ctx() ctx: BotContext): Promise<void> {
    await this.showStatus(ctx);
  }

  @Action(PAY_RETRY_CALLBACK)
  async onRetry(@Ctx() ctx: BotContext): Promise<void> {
    await ctx.answerCbQuery();
    await this.showStatus(ctx);
  }

  private async showStatus(ctx: BotContext): Promise<void> {
    if (!ctx.from) return;

    let status: Awaited<ReturnType<PaymentsService['getStatusByTelegramId']>>;
    try {
      status = await this.payments.getStatusByTelegramId(ctx.from.id);
    } catch (err) {
      logUnexpected('getStatusByTelegramId', err);
      if (ctx.session.language) await replyT(ctx, 'error.tryAgainLater');
      return;
    }

    if (!status) {
      // Not registered: reply in the session language, or start with the picker.
      if (ctx.session.language) {
        await replyT(ctx, 'status.notRegistered');
      } else {
        await ctx.scene.enter(LANGUAGE_SCENE_ID);
      }
      return;
    }

    // The stored registration language survives a bot restart; the session doesn't.
    ctx.session.language ??= status.languageCode;
    if (!status.invoice) {
      await ctx.reply(t('registration.closed', status.languageCode));
      return;
    }
    if (status.invoice.status === 'paid') {
      try {
        await this.qr.sendQr(status.participantId, 'resend');
      } catch (err) {
        logUnexpected(`QR resend for participant ${status.participantId}`, err);
        await ctx.reply(t('qr.unavailable', status.languageCode));
      }
      return;
    }
    await sendInvoice(
      ctx,
      status.invoice,
      status.languageCode,
      'status.pending',
    );
  }
}
