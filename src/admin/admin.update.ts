import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Command, Ctx, Update } from 'nestjs-telegraf';
import { logUnexpected } from '../bot/scenes/registration.helpers';
import type { BotContext } from '../bot/bot.context';
import { HrAlreadyBoundError } from '../hr/hr.errors';
import { HrScannerService } from '../hr/hr-scanner.service';
import { isLang, t } from '../i18n/i18n';
import { parsePhone } from '../participants/registration.rules';
import { devPaymentBypassEnabled } from '../payments/dev-payment-bypass';
import {
  InvalidPaymentTransitionError,
  PaymentNotFoundError,
  PaymentOverdueError,
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
  hr_add: '/hr_add <telegramId> <uz|ru|en> <company name>',
  dev_mark_paid: '/dev_mark_paid <participantId>',
};

/** "/hr_add 123 uz Acme Corp" → { 123, 'uz', 'Acme Corp' }, or null. */
export function parseHrAdd(
  arg: string,
): { telegramId: number; lang: 'uz' | 'ru' | 'en'; company: string } | null {
  const m = /^(\d{1,15})\s+(\S+)\s+(.+)$/.exec(arg);
  if (!m || !isLang(m[2]) || m[3].trim() === '') return null;
  return { telegramId: Number(m[1]), lang: m[2], company: m[3] };
}

/** Text after the command, e.g. "/refund_approve abc" → "abc". */
function argOf(ctx: BotContext): string {
  const msg = ctx.message;
  if (!msg || !('text' in msg)) return '';
  return msg.text.replace(/^\/\S+\s*/, '').trim();
}

function describe(p: PaymentWithParticipant): string {
  return [
    `${p.id}`,
    `  ${p.participant.fullName ?? '(PII purged)'}, ${p.participant.phone ?? '—'}`,
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
    private readonly hr: HrScannerService,
    private readonly config: ConfigService,
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
      // The participant id is what /dev_mark_paid takes.
      return found.length > 0
        ? found
            .map((p) => `${describe(p)}\n  participant id: ${p.participantId}`)
            .join('\n\n')
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

  /**
   * Binds a Telegram user to a company as its HR scanner. A bot command
   * rather than a seed script so organizers can add HR on event day from
   * their phone, with the adding admin recorded (HrUser.addedBy).
   */
  @Command('hr_add')
  async onHrAdd(@Ctx() ctx: BotContext): Promise<void> {
    const adminId = ctx.from?.id;
    if (!this.allowed(ctx, 'hr_add') || !adminId) return;
    const input = parseHrAdd(argOf(ctx));
    if (!input) {
      await ctx.reply(`Usage: ${USAGE.hr_add}`);
      return;
    }
    await this.run(ctx, async () => {
      const hr = await this.hr.registerHr({
        adminTelegramId: adminId,
        hrTelegramId: input.telegramId,
        languageCode: input.lang,
        companyName: input.company,
      });
      let notified = true;
      try {
        await ctx.telegram.sendMessage(
          input.telegramId,
          t('hr.welcome', hr.languageCode, { company: hr.companyName }),
        );
      } catch {
        notified = false; // they haven't started the bot yet
      }
      return (
        `HR ${hr.telegramId} is bound to "${hr.companyName}" (${hr.languageCode}).` +
        (notified
          ? ''
          : '\nCouldn’t message them: they must open the bot and send /start first.')
      );
    });
  }

  /**
   * DEV ONLY: marks a participant's pending invoice paid without Click, to
   * test QR issuance and Sheets locally. Admin-only and off unless
   * devPaymentBypassEnabled; refusals log but never reply, like non-admins.
   */
  @Command('dev_mark_paid')
  async onDevMarkPaid(@Ctx() ctx: BotContext): Promise<void> {
    const adminId = ctx.from?.id;
    if (!this.allowed(ctx, 'dev_mark_paid') || !adminId) return;
    if (!devPaymentBypassEnabled(this.config)) {
      this.logger.warn(
        `DEV BYPASS refused: /dev_mark_paid by admin ${adminId} — disabled (needs ALLOW_DEV_PAYMENT_BYPASS=true and NODE_ENV not production)`,
      );
      return;
    }
    const participantId = argOf(ctx);
    if (!participantId) {
      await ctx.reply(`Usage: ${USAGE.dev_mark_paid}`);
      return;
    }
    await this.run(ctx, async () => {
      try {
        const p = await this.payments.devMarkPaid(participantId, adminId);
        return `DEV BYPASS: payment ${p.id} marked paid (no Click transaction). QR and Sheets sync triggered.`;
      } catch (err) {
        if (err instanceof PaymentNotFoundError) {
          return 'No payment for that participant id.';
        }
        throw err;
      }
    });
  }

  @Command('hr_list')
  async onHrList(@Ctx() ctx: BotContext): Promise<void> {
    if (!this.allowed(ctx, 'hr_list')) return;
    await this.run(ctx, async () => {
      const all = await this.hr.listHr();
      return all.length > 0
        ? all
            .map((h) => `${h.companyName}: ${h.telegramId} (${h.languageCode})`)
            .join('\n')
        : 'No HR users yet.';
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
      } else if (err instanceof HrAlreadyBoundError) {
        reply = `Not allowed: that user is already HR for "${err.companyName}".`;
      } else if (err instanceof InvalidPaymentTransitionError) {
        reply = `Not allowed: the payment is ${err.from}, it cannot become ${err.to}.`;
      } else if (err instanceof PaymentOverdueError) {
        reply =
          'Not allowed: that invoice is past its 2-hour hold. The participant needs a new one (/status) first.';
      } else {
        logUnexpected('admin command', err);
        reply = 'Something went wrong; check the server logs.';
      }
    }
    await ctx.reply(reply);
  }
}
