import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LanguageCode, Payment, PaymentStatus, Prisma } from '@prisma/client';
import {
  countActiveHolds,
  holdCutoff,
  lockCap,
  readMaxParticipants,
} from '../participants/participant-cap';
import { RegistrationClosedError } from '../participants/participants.errors';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from '../qr/qr.service';
import { SheetsSyncService } from '../sheets/sheets-sync.service';
import { ClickConfig } from './click.config';
import { ClickError, VerifiedClickRequest } from './click.protocol';
import { assertTransition } from './payment-state';
import { PAYMENT_AMOUNT_UZS } from './payments.constants';
import {
  ClickNotConfiguredError,
  InvalidPaymentTransitionError,
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
  participantId: string;
  languageCode: LanguageCode;
  /** null: the last invoice expired and no place is free for a new one. */
  invoice: Invoice | null;
}

/** Outcome of a Prepare/Complete call, turned into Click's JSON by the controller. */
export interface ClickResult {
  error: ClickError;
  /** merchant_prepare_id (Prepare) / merchant_confirm_id (Complete). */
  merchantId?: number;
}

/** One payment the expiry job moved to `expired`, with what's needed to notify. */
export interface ExpiredPayment {
  paymentId: string;
  participantId: string;
  /** Null once the retention job purged the participant's PII. */
  telegramId: bigint | null;
  languageCode: LanguageCode;
  expiredAt: Date;
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

/** A pending invoice past the 2-hour hold: no longer counted, must not be paid. */
function isOverdue(payment: Payment, now: Date): boolean {
  return (
    payment.status === PaymentStatus.pending &&
    payment.createdAt <= holdCutoff(now)
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
    private readonly config: ConfigService,
    private readonly qr: QrService,
    private readonly sheets: SheetsSyncService,
  ) {}

  /**
   * Returns the participant's current Payment. Registration creates the first
   * one; a new `pending` one is created only when there is none or the last
   * one expired (or is past its window) — and only if a place is free right
   * now, checked under the cap lock, since the old place may have been taken.
   *
   * @throws PaymentNotAllowedError | RegistrationClosedError
   */
  async createInvoice(participantId: string): Promise<Invoice> {
    const participant = await this.prisma.participant.findUnique({
      where: { id: participantId },
      select: {
        track: true,
        payments: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    if (!participant || participant.track === null) {
      throw new PaymentNotAllowedError();
    }

    const latest = participant.payments[0];
    if (
      latest &&
      latest.status !== PaymentStatus.expired &&
      !isOverdue(latest, new Date())
    ) {
      return this.toInvoice(latest);
    }
    return this.toInvoice(await this.reinvoice(participantId));
  }

  /**
   * For `/status` and the retry button: null if this Telegram account never
   * registered. Creates a fresh invoice after expiry when a place is free.
   */
  async getStatusByTelegramId(
    telegramId: number,
  ): Promise<ParticipantPaymentStatus | null> {
    const participant = await this.prisma.participant.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: { id: true, languageCode: true },
    });
    if (!participant) return null;
    try {
      return {
        participantId: participant.id,
        languageCode: participant.languageCode,
        invoice: await this.createInvoice(participant.id),
      };
    } catch (err) {
      if (!(err instanceof RegistrationClosedError)) throw err;
      return {
        participantId: participant.id,
        languageCode: participant.languageCode,
        invoice: null,
      };
    }
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
        if (isOverdue(payment, new Date())) {
          // Its place may already be someone else's; the expiry job will expire it.
          return { error: ClickError.TransactionCancelled };
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

    let paidParticipantId: string | undefined;
    const result = await this.prisma.$transaction(async (tx) => {
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

      if (isOverdue(payment, new Date())) {
        // Past the 2-hour hold: its place may already be someone else's.
        return { error: ClickError.TransactionCancelled };
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
      this.logger.log(`Payment ${payment.id} paid`);
      paidParticipantId = payment.participantId;
      return { error: ClickError.Success, ...confirm };
    });

    // QR issuance: the side effect of this call's `pending → paid`, run once
    // the transition is committed (a QR failure can't roll back `paid`) and
    // not awaited (Click's answer doesn't wait on Telegram). A replay never
    // gets here, so the QR is sent once; /status resends it on demand.
    if (paidParticipantId) {
      this.sheets.paymentStatusChanged(paidParticipantId);
      this.issueQrAfterPaid(paidParticipantId);
    }
    return result;
  }

  /**
   * Fire-and-forget QR delivery. A failure is logged at error level, with
   * the recovery path, and never surfaces into the payment flow.
   */
  private issueQrAfterPaid(participantId: string): void {
    this.qr.sendQr(participantId, 'issued').catch((err: unknown) => {
      this.logger.error(
        `QR delivery FAILED for paid participant ${participantId} — payment stays paid; ` +
          `the participant gets the QR via /status`,
        err instanceof Error ? err.stack : String(err),
      );
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

  /** `pending → expired`, logged. Called by the expiry job for overdue invoices. */
  async expire(paymentId: string): Promise<Payment> {
    const payment = await this.transition(paymentId, PaymentStatus.expired, {
      expiredAt: new Date(),
    });
    this.logExpiry(payment);
    return payment;
  }

  /**
   * Expires every invoice still `pending` after the 2-hour hold. A payment
   * paid (or expired) between the lookup and its row lock is skipped.
   */
  async expireOverdue(now = new Date()): Promise<ExpiredPayment[]> {
    const overdue = await this.prisma.payment.findMany({
      where: {
        status: PaymentStatus.pending,
        createdAt: { lte: holdCutoff(now) },
      },
      select: {
        id: true,
        participant: { select: { telegramId: true, languageCode: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    const expired: ExpiredPayment[] = [];
    for (const row of overdue) {
      try {
        const payment = await this.expire(row.id);
        expired.push({
          paymentId: payment.id,
          participantId: payment.participantId,
          telegramId: row.participant.telegramId,
          languageCode: row.participant.languageCode,
          expiredAt: payment.expiredAt ?? now,
        });
      } catch (err) {
        if (!(err instanceof InvalidPaymentTransitionError)) throw err;
      }
    }
    return expired;
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

  /**
   * New pending payment after none/an expired one, under the cap lock. The
   * previous payment is row-locked too, so a Click Complete that just
   * committed is seen rather than raced. A stale pending invoice is expired
   * here too (and stays expired even when no place is free).
   *
   * @throws RegistrationClosedError
   */
  private async reinvoice(participantId: string): Promise<Payment> {
    const { payment, expired } = await this.prisma.$transaction(async (tx) => {
      await lockCap(tx);
      const now = new Date();
      const latest = await tx.payment.findFirst({
        where: { participantId },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      const current = latest && (await this.lock(tx, latest.id));
      let expired: Payment | undefined;
      if (current && isOverdue(current, now)) {
        assertTransition(current.status, PaymentStatus.expired);
        expired = await tx.payment.update({
          where: { id: current.id },
          data: { status: PaymentStatus.expired, expiredAt: now },
        });
      } else if (current && current.status !== PaymentStatus.expired) {
        // A concurrent retry (or a payment) got here first.
        return { payment: current, expired };
      }

      const full =
        (await countActiveHolds(tx, now)) >= readMaxParticipants(this.config);
      // No throw inside the transaction: that would roll back the expiry above.
      const payment = full
        ? null
        : await tx.payment.create({
            data: { participantId, amount: PAYMENT_AMOUNT_UZS },
          });
      return { payment, expired };
    });

    if (expired) this.logExpiry(expired);
    // Column G shows the current payment: the new pending one, or the expiry.
    if (expired || payment) this.sheets.paymentStatusChanged(participantId);
    if (!payment) throw new RegistrationClosedError();
    return payment;
  }

  private logExpiry(payment: Payment): void {
    this.logger.log(
      `Payment ${payment.id} (participant ${payment.participantId}) expired at ${payment.expiredAt?.toISOString()}`,
    );
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
    const updated = await this.prisma.$transaction(async (tx) => {
      const payment = await this.lock(tx, paymentId);
      if (!payment) throw new PaymentNotFoundError();
      assertTransition(payment.status, to);
      return tx.payment.update({
        where: { id: paymentId },
        data: { ...data, status: to },
      });
    });
    this.sheets.paymentStatusChanged(updated.participantId);
    return updated;
  }
}
