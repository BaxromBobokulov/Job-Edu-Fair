import { Injectable, Logger } from '@nestjs/common';
import { LanguageCode, Payment, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClickConfig } from './click.config';
import { ClickError, VerifiedClickRequest } from './click.protocol';
import { assertTransition } from './payment-state';
import { PAYMENT_AMOUNT_UZS } from './payments.constants';
import {
  ClickNotConfiguredError,
  PaymentNotAllowedError,
  PaymentNotFoundError,
} from './payments.errors';

/** What the bot needs to show a participant their payment. */
export interface Invoice {
  paymentId: string;
  status: PaymentStatus;
  amount: number;
  /** Click checkout link while `pending`; null otherwise, or if Click isn't configured. */
  payUrl: string | null;
}

export interface ParticipantPaymentStatus {
  languageCode: LanguageCode;
  invoice: Invoice;
}

/** Outcome of a Prepare/Complete call, turned into Click's JSON by the controller. */
export interface ClickResult {
  error: ClickError;
  /** merchant_prepare_id (Prepare) / merchant_confirm_id (Complete). */
  merchantId?: number;
}

export type PaymentWithParticipant = Prisma.PaymentGetPayload<{
  include: { participant: { select: { fullName: true; phone: true } } };
}>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'
  );
}

/** Both the stored amount and the constant must match what Click charged. */
function amountMatches(clickAmount: number, payment: Payment): boolean {
  return (
    clickAmount === payment.amount && payment.amount === PAYMENT_AMOUNT_UZS
  );
}

/**
 * Owns every Payment.status change. Webhook entry points only accept a
 * `VerifiedClickRequest`, which only the signature check can produce.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly click: ClickConfig,
  ) {}

  /**
   * Returns the participant's Payment, creating it as `pending` on first call.
   * The participant's place was already reserved under the cap lock at
   * registration, so an invoice can never be issued for a place beyond the cap.
   *
   * @throws PaymentNotAllowedError
   */
  async createInvoice(participantId: string): Promise<Invoice> {
    const participant = await this.prisma.participant.findUnique({
      where: { id: participantId },
      select: { track: true, payment: true },
    });
    if (!participant || participant.track === null) {
      throw new PaymentNotAllowedError();
    }

    let payment = participant.payment;
    if (!payment) {
      try {
        payment = await this.prisma.payment.create({
          data: { participantId, amount: PAYMENT_AMOUNT_UZS },
        });
      } catch (err) {
        // A concurrent call created it first (participantId is unique).
        if (!isUniqueViolation(err)) throw err;
        payment = await this.prisma.payment.findUniqueOrThrow({
          where: { participantId },
        });
      }
    }
    return this.toInvoice(payment);
  }

  /** For `/status`: null if this Telegram account never registered. */
  async getStatusByTelegramId(
    telegramId: number,
  ): Promise<ParticipantPaymentStatus | null> {
    const participant = await this.prisma.participant.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: { id: true, languageCode: true },
    });
    if (!participant) return null;
    return {
      languageCode: participant.languageCode,
      invoice: await this.createInvoice(participant.id),
    };
  }

  /** Click Prepare (action=0): records Click's transaction id on a pending payment. */
  async handlePrepare(req: VerifiedClickRequest): Promise<ClickResult> {
    if (req.clickError < 0) return { error: ClickError.TransactionCancelled };
    if (!UUID_RE.test(req.merchantTransId)) {
      return { error: ClickError.OrderNotFound };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const payment = await this.lock(tx, req.merchantTransId);
        if (!payment) return { error: ClickError.OrderNotFound };
        if (!amountMatches(req.amount, payment)) {
          return { error: ClickError.IncorrectAmount };
        }
        if (payment.status === PaymentStatus.expired) {
          return { error: ClickError.TransactionCancelled };
        }
        if (payment.status !== PaymentStatus.pending) {
          return { error: ClickError.AlreadyPaid };
        }
        // A new click_trans_id replaces an earlier attempt that never completed.
        if (payment.clickTransId !== req.clickTransId || !payment.preparedAt) {
          await tx.payment.update({
            where: { id: payment.id },
            data: { clickTransId: req.clickTransId, preparedAt: new Date() },
          });
        }
        return {
          error: ClickError.Success,
          merchantId: payment.clickPrepareId,
        };
      });
    } catch (err) {
      // click_trans_id already recorded on a different payment.
      if (isUniqueViolation(err)) return { error: ClickError.BadRequest };
      throw err;
    }
  }

  /**
   * Click Complete (action=1): `pending → paid`. Idempotent — a replay of the
   * same completed transaction answers success again without re-processing.
   */
  async handleComplete(req: VerifiedClickRequest): Promise<ClickResult> {
    if (!UUID_RE.test(req.merchantTransId)) {
      return { error: ClickError.OrderNotFound };
    }

    return this.prisma.$transaction(async (tx) => {
      const payment = await this.lock(tx, req.merchantTransId);
      if (!payment) return { error: ClickError.OrderNotFound };
      if (
        !payment.preparedAt ||
        payment.clickTransId !== req.clickTransId ||
        payment.clickPrepareId !== req.merchantPrepareId
      ) {
        return { error: ClickError.TransactionNotFound };
      }
      if (!amountMatches(req.amount, payment)) {
        return { error: ClickError.IncorrectAmount };
      }
      if (payment.status === PaymentStatus.expired) {
        return { error: ClickError.TransactionCancelled };
      }

      const confirm = { merchantId: payment.clickPrepareId };
      if (payment.status !== PaymentStatus.pending) {
        if (req.clickError < 0) return { error: ClickError.AlreadyPaid };
        this.logger.log(`Click Complete replay for payment ${payment.id}`);
        return { error: ClickError.Success, ...confirm };
      }

      if (req.clickError < 0) {
        // Click cancelled this attempt (declined card, timeout…). The payment
        // stays pending so the participant can pay again with the same link.
        this.logger.log(`Click cancelled an attempt for payment ${payment.id}`);
        return { error: ClickError.TransactionCancelled };
      }

      assertTransition(payment.status, PaymentStatus.paid);
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.paid, paidAt: new Date() },
      });
      // Part 3: QR issuance hooks in here, as a side effect of this transition.
      this.logger.log(`Payment ${payment.id} paid`);
      return { error: ClickError.Success, ...confirm };
    });
  }

  /** `paid → refund_requested`, by an admin. The operator then refunds in the Click cabinet. */
  async requestRefund(
    paymentId: string,
    adminTelegramId: number,
  ): Promise<Payment> {
    const payment = await this.transition(
      paymentId,
      PaymentStatus.refund_requested,
      {
        refundRequestedAt: new Date(),
        refundRequestedBy: BigInt(adminTelegramId),
      },
    );
    this.logger.warn(
      `Refund requested: payment ${payment.id} by admin ${adminTelegramId} at ${payment.refundRequestedAt?.toISOString()} — refund it in the Click merchant cabinet, then /refund_approve`,
    );
    return payment;
  }

  /**
   * `refund_requested → refunded`. A separate, explicit admin call confirming
   * the money went back via the Click cabinet — never automatic.
   */
  async approveRefund(
    paymentId: string,
    adminTelegramId: number,
  ): Promise<Payment> {
    const payment = await this.transition(paymentId, PaymentStatus.refunded, {
      refundedAt: new Date(),
      refundApprovedBy: BigInt(adminTelegramId),
    });
    this.logger.warn(
      `Refund approved: payment ${payment.id} by admin ${adminTelegramId} at ${payment.refundedAt?.toISOString()}`,
    );
    return payment;
  }

  /**
   * `pending → expired`. Not triggered by anything yet: Click's SHOP API has no
   * "invoice expired" callback (see the Part 2 notes) — wire a trigger once one is agreed.
   */
  async expire(paymentId: string): Promise<Payment> {
    return this.transition(paymentId, PaymentStatus.expired, {});
  }

  /** Admin lookup by the participant's phone (normalized `+digits`). */
  findByPhone(phone: string): Promise<PaymentWithParticipant[]> {
    return this.prisma.payment.findMany({
      where: { participant: { phone } },
      include: { participant: { select: { fullName: true, phone: true } } },
    });
  }

  listRefundRequests(): Promise<PaymentWithParticipant[]> {
    return this.prisma.payment.findMany({
      where: { status: PaymentStatus.refund_requested },
      include: { participant: { select: { fullName: true, phone: true } } },
      orderBy: { refundRequestedAt: 'asc' },
    });
  }

  private toInvoice(payment: Payment): Invoice {
    let payUrl: string | null = null;
    if (payment.status === PaymentStatus.pending) {
      try {
        payUrl = this.click.payUrl(payment.id, payment.amount);
      } catch (err) {
        if (!(err instanceof ClickNotConfiguredError)) throw err;
        this.logger.warn(err.message);
      }
    }
    return {
      paymentId: payment.id,
      status: payment.status,
      amount: payment.amount,
      payUrl,
    };
  }

  /** Row-locks the payment for the rest of the transaction; serializes concurrent webhooks. */
  private async lock(
    tx: Prisma.TransactionClient,
    paymentId: string,
  ): Promise<Payment | null> {
    await tx.$queryRaw`SELECT "id" FROM "Payment" WHERE "id" = ${paymentId} FOR UPDATE`;
    return tx.payment.findUnique({ where: { id: paymentId } });
  }

  /** @throws PaymentNotFoundError | InvalidPaymentTransitionError */
  private async transition(
    paymentId: string,
    to: PaymentStatus,
    data: Omit<Prisma.PaymentUpdateInput, 'status'>,
  ): Promise<Payment> {
    if (!UUID_RE.test(paymentId)) throw new PaymentNotFoundError();
    return this.prisma.$transaction(async (tx) => {
      const payment = await this.lock(tx, paymentId);
      if (!payment) throw new PaymentNotFoundError();
      assertTransition(payment.status, to);
      return tx.payment.update({
        where: { id: paymentId },
        data: { ...data, status: to },
      });
    });
  }
}
