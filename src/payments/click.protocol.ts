/**
 * Click SHOP API (Prepare + Complete) wire format and signature check.
 * https://docs.click.uz/en/click-api-request/
 *
 * Nothing here may log a request field: sign_string and its inputs must never
 * reach a log line (.claude/rules/payments.md).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { ClickSettings } from './click.config';

export type ClickStage = 'prepare' | 'complete';

export const CLICK_ACTION: Record<ClickStage, string> = {
  prepare: '0',
  complete: '1',
};

/** Click's merchant-side error codes, returned in the `error` field. */
export enum ClickError {
  Success = 0,
  SignCheckFailed = -1,
  IncorrectAmount = -2,
  ActionNotFound = -3,
  AlreadyPaid = -4,
  /** merchant_trans_id doesn't match any order. */
  OrderNotFound = -5,
  TransactionNotFound = -6,
  UpdateFailed = -7,
  BadRequest = -8,
  TransactionCancelled = -9,
}

export const CLICK_ERROR_NOTE: Record<ClickError, string> = {
  [ClickError.Success]: 'Success',
  [ClickError.SignCheckFailed]: 'SIGN CHECK FAILED!',
  [ClickError.IncorrectAmount]: 'Incorrect parameter amount',
  [ClickError.ActionNotFound]: 'Action not found',
  [ClickError.AlreadyPaid]: 'Already paid',
  [ClickError.OrderNotFound]: 'User does not exist',
  [ClickError.TransactionNotFound]: 'Transaction does not exist',
  [ClickError.UpdateFailed]: 'Failed to update user',
  [ClickError.BadRequest]: 'Error in request from click',
  [ClickError.TransactionCancelled]: 'Transaction cancelled',
};

/** Raw string fields as Click posts them (form-urlencoded). */
export interface ClickRawRequest {
  click_trans_id: string;
  service_id: string;
  click_paydoc_id: string;
  merchant_trans_id: string;
  /** Complete only. */
  merchant_prepare_id?: string;
  amount: string;
  action: string;
  error: string;
  error_note: string;
  sign_time: string;
  sign_string: string;
}

type SignedFields = Pick<
  ClickRawRequest,
  | 'click_trans_id'
  | 'service_id'
  | 'merchant_trans_id'
  | 'merchant_prepare_id'
  | 'amount'
  | 'action'
  | 'sign_time'
>;

const REQUIRED_FIELDS = [
  'click_trans_id',
  'service_id',
  'click_paydoc_id',
  'merchant_trans_id',
  'amount',
  'action',
  'error',
  'sign_time',
  'sign_string',
] as const;

declare const verifiedBrand: unique symbol;

/**
 * A request whose signature, service id and action were checked. Only
 * `verifyClickRequest` can produce one, so PaymentsService's webhook methods
 * can't be handed an unverified body.
 */
export interface VerifiedClickRequest {
  readonly [verifiedBrand]: true;
  clickTransId: bigint;
  merchantTransId: string;
  amount: number;
  /** Click's own status for the transaction; < 0 means Click cancelled it. */
  clickError: number;
  /** Complete only. */
  merchantPrepareId?: number;
}

export interface ClickResponse {
  click_trans_id?: number | string;
  merchant_trans_id?: string;
  merchant_prepare_id?: number;
  merchant_confirm_id?: number;
  error: ClickError;
  error_note: string;
}

export type ClickVerification =
  | { ok: true; request: VerifiedClickRequest }
  | { ok: false; error: ClickError; raw: Partial<ClickRawRequest> };

/**
 * sign_string per Click: md5 of the fields in this exact order, the secret key
 * third; Complete adds merchant_prepare_id after merchant_trans_id.
 */
export function clickSignature(raw: SignedFields, secretKey: string): string {
  const prepareId =
    raw.action === CLICK_ACTION.complete ? (raw.merchant_prepare_id ?? '') : '';
  return createHash('md5')
    .update(
      raw.click_trans_id +
        raw.service_id +
        secretKey +
        raw.merchant_trans_id +
        prepareId +
        raw.amount +
        raw.action +
        raw.sign_time,
      'utf8',
    )
    .digest('hex');
}

function signatureMatches(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(given.toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reads the fields as strings; arrays, objects or a missing field → raw: null. */
function readRaw(
  body: unknown,
  stage: ClickStage,
): { raw: ClickRawRequest | null; partial: Partial<ClickRawRequest> } {
  const partial: Partial<ClickRawRequest> = {};
  if (typeof body !== 'object' || body === null) return { raw: null, partial };
  const record = body as Record<string, unknown>;
  const required: ReadonlyArray<keyof ClickRawRequest> =
    stage === 'complete'
      ? [...REQUIRED_FIELDS, 'merchant_prepare_id']
      : REQUIRED_FIELDS;

  let complete = true;
  for (const name of [...required, 'error_note'] as const) {
    const value = record[name];
    if (typeof value === 'string' && value.length <= 256) {
      partial[name] = value;
    } else if (name !== 'error_note') {
      complete = false;
    }
  }
  partial.error_note ??= '';
  return { raw: complete ? (partial as ClickRawRequest) : null, partial };
}

/**
 * Checks shape, signature, service id and action — in that order, before any
 * value from the body is trusted.
 */
export function verifyClickRequest(
  body: unknown,
  stage: ClickStage,
  settings: ClickSettings,
): ClickVerification {
  const { raw, partial } = readRaw(body, stage);
  if (!raw) return { ok: false, error: ClickError.BadRequest, raw: partial };

  const expected = clickSignature(raw, settings.secretKey);
  if (!signatureMatches(expected, raw.sign_string)) {
    return { ok: false, error: ClickError.SignCheckFailed, raw };
  }
  if (raw.service_id !== settings.serviceId) {
    return { ok: false, error: ClickError.BadRequest, raw };
  }
  if (raw.action !== CLICK_ACTION[stage]) {
    return { ok: false, error: ClickError.ActionNotFound, raw };
  }
  if (
    !/^\d{1,18}$/.test(raw.click_trans_id) ||
    !/^\d{1,12}(\.\d{1,2})?$/.test(raw.amount) ||
    !/^-?\d{1,9}$/.test(raw.error) ||
    (stage === 'complete' && !/^\d{1,9}$/.test(raw.merchant_prepare_id ?? ''))
  ) {
    return { ok: false, error: ClickError.BadRequest, raw };
  }

  const request = {
    clickTransId: BigInt(raw.click_trans_id),
    merchantTransId: raw.merchant_trans_id,
    amount: Number(raw.amount),
    clickError: Number(raw.error),
    ...(stage === 'complete' && {
      merchantPrepareId: Number(raw.merchant_prepare_id),
    }),
  } as VerifiedClickRequest;
  return { ok: true, request };
}

/** click_trans_id is echoed back as a number, the way Click sends it. */
export function echoClickTransId(
  raw: string | undefined,
): number | string | undefined {
  return raw !== undefined && /^\d{1,15}$/.test(raw) ? Number(raw) : raw;
}
