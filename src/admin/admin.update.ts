import { Logger } from '@nestjs/common';
import { Command, Ctx, Update } from 'nestjs-telegraf';
import { logUnexpected } from '../bot/scenes/registration.helpers';
import type { BotContext } from '../bot/bot.context';
import { parsePhone } from '../participants/registration.rules';
import {
  InvalidPaymentTransitionError,
  PaymentNotFoundError,
} from '../payments/payments.errors';
import {
  PaymentsService,
  PaymentWithParticipant,
} from '../payments/payments.service';
import { AdminAuth } from './admin-auth';

const USAGE = {
  payment_lookup: '/payment_lookup <phone>',
  refund_request: '/refund_request <paymentId>',
  refund_approve: '/refund_approve <paymentId>',
};

/** Text after the command, e.g. "/refund_approve abc" → "abc". */
function argOf(ctx: BotContext): string {
  const msg = ctx.message;
  if (!msg || !('text' in msg)) return '';
  return msg.text.replace(/^\/\S+\s*/, '').trim();
}

function describe(p: PaymentWithParticipant): string {
  return [
    `${p.id}`,
    `  ${p.participant.fullName}, ${p.participant.phone}`,
    `  status: ${p.status}, amount: ${p.amount}`,
    ...(p.refundRequestedAt
      ? [
          `  refund requested ${p.refundRequestedAt.toISOString()} by ${p.refundRequestedBy}`,
        ]
      : []),
  ].join('\n');
}

/**
 * Minimal admin commands, gated by ADMIN_TELEGRAM_IDS. Non-admins get no
 * reply, so the commands aren't discoverable. Replies are in English.
 */
@Update()
export class AdminUpdate {
  private readonly logger = new Logger(AdminUpdate.name);

  constructor(
    private readonly auth: AdminAuth,
    private readonly payments: PaymentsService,
  ) {}

  @Command('payment_lookup')
  async onLookup(@Ctx() ctx: BotContext): Promise<void> {
    if (!this.allowed(ctx, 'payment_lookup')) return;
    const phone = parsePhone(argOf(ctx));
    if (!phone) {
      await ctx.reply(`Usage: ${USAGE.payment_lookup}`);
      return;
    }
    await this.run(ctx, async () => {
      const found = await this.payments.findByPhone(phone);
      return found.length > 0
        ? found.map(describe).join('\n\n')
        : 'No payment for that phone number.';
    });
  }

  @Command('refunds')
  async onRefunds(@Ctx() ctx: BotContext): Promise<void> {
    if (!this.allowed(ctx, 'refunds')) return;
    await this.run(ctx, async () => {
      const pending = await this.payments.listRefundRequests();
      return pending.length > 0
        ? `Refunds awaiting approval:\n\n${pending.map(describe).join('\n\n')}`
        : 'No refunds awaiting approval.';
    });
  }

  @Command('refund_request')
  async onRefundRequest(@Ctx() ctx: BotContext): Promise<void> {
    const adminId = ctx.from?.id;
    if (!this.allowed(ctx, 'refund_request') || !adminId) return;
    const paymentId = argOf(ctx);
    if (!paymentId) {
      await ctx.reply(`Usage: ${USAGE.refund_request}`);
      return;
    }
    await this.run(ctx, async () => {
      const p = await this.payments.requestRefund(paymentId, adminId);
      return (
        `Refund requested for payment ${p.id}.\n` +
        'Refund it in the Click merchant cabinet, then confirm with ' +
        `/refund_approve ${p.id}`
      );
    });
  }

  @Command('refund_approve')
  async onRefundApprove(@Ctx() ctx: BotContext): Promise<void> {
    const adminId = ctx.from?.id;
    if (!this.allowed(ctx, 'refund_approve') || !adminId) return;
    const paymentId = argOf(ctx);
    if (!paymentId) {
      await ctx.reply(`Usage: ${USAGE.refund_approve}`);
      return;
    }
    await this.run(ctx, async () => {
      const p = await this.payments.approveRefund(paymentId, adminId);
      return `Payment ${p.id} marked refunded (approved by ${adminId} at ${p.refundedAt?.toISOString()}).`;
    });
  }

  private allowed(ctx: BotContext, command: string): boolean {
    if (this.auth.isAdmin(ctx.from?.id)) return true;
    this.logger.warn(
      `Non-admin ${ctx.from?.id ?? 'unknown'} tried /${command}`,
    );
    return false;
  }

  /** Runs an admin action and replies with its result or a readable error. */
  private async run(
    ctx: BotContext,
    action: () => Promise<string>,
  ): Promise<void> {
    let reply: string;
    try {
      reply = await action();
    } catch (err) {
      if (err instanceof PaymentNotFoundError) {
        reply = 'No payment with that id.';
      } else if (err instanceof InvalidPaymentTransitionError) {
        reply = `Not allowed: the payment is ${err.from}, it cannot become ${err.to}.`;
      } else {
        logUnexpected('admin command', err);
        reply = 'Something went wrong; check the server logs.';
      }
    }
    await ctx.reply(reply);
  }
}
