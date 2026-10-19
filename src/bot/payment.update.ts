import { Command, Ctx, Update } from 'nestjs-telegraf';
import { Markup } from 'telegraf';
import { Lang, t } from '../i18n/i18n';
import { Invoice, PaymentsService } from '../payments/payments.service';
import { LANGUAGE_SCENE_ID } from './bot.constants';
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

/** `/status`: the participant's current payment state, with the pay button while unpaid. */
@Update()
export class PaymentUpdate {
  constructor(private readonly payments: PaymentsService) {}

  @Command('status')
  async onStatus(@Ctx() ctx: BotContext): Promise<void> {
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
    await sendInvoice(
      ctx,
      status.invoice,
      status.languageCode,
      'status.pending',
    );
  }
}
