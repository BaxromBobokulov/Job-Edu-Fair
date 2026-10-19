import { createHash } from 'node:crypto';
import type { ClickSettings } from './click.config';
import {
  ClickError,
  ClickRawRequest,
  clickSignature,
  verifyClickRequest,
} from './click.protocol';

const SETTINGS: ClickSettings = {
  serviceId: '111',
  merchantId: '222',
  secretKey: 'test-secret',
};

function prepareBody(
  overrides: Partial<ClickRawRequest> = {},
): Record<string, string> {
  const body: Omit<ClickRawRequest, 'sign_string'> = {
    click_trans_id: '987654321',
    service_id: '111',
    click_paydoc_id: '555',
    merchant_trans_id: '0b3f6c1e-8d7a-4c2b-9f1e-2a3b4c5d6e7f',
    amount: '50000',
    action: '0',
    error: '0',
    error_note: 'Success',
    sign_time: '2026-10-19 12:00:00',
    ...overrides,
  };
  return {
    ...body,
    sign_string:
      overrides.sign_string ?? clickSignature(body, SETTINGS.secretKey),
  };
}

describe('clickSignature', () => {
  it('is md5 of the fields in Click’s documented order', () => {
    const md5 = (s: string) => createHash('md5').update(s).digest('hex');
    const base = {
      click_trans_id: '1',
      service_id: '2',
      merchant_trans_id: 'm',
      amount: '50000',
      sign_time: '2026-10-19 12:00:00',
    };
    expect(clickSignature({ ...base, action: '0' }, 'S')).toBe(
      md5('12Sm500000' + '2026-10-19 12:00:00'),
    );
    // Complete adds merchant_prepare_id after merchant_trans_id.
    expect(
      clickSignature({ ...base, action: '1', merchant_prepare_id: '7' }, 'S'),
    ).toBe(md5('12Sm7500001' + '2026-10-19 12:00:00'));
  });
});

describe('verifyClickRequest', () => {
  it('accepts a correctly signed Prepare and parses its values', () => {
    const result = verifyClickRequest(prepareBody(), 'prepare', SETTINGS);
    expect(result).toEqual({
      ok: true,
      request: {
        clickTransId: 987654321n,
        merchantTransId: '0b3f6c1e-8d7a-4c2b-9f1e-2a3b4c5d6e7f',
        amount: 50_000,
        clickError: 0,
      },
    });
  });

  it('accepts an upper-case hex signature and a decimal amount', () => {
    const body = prepareBody({ amount: '50000.00' });
    body.sign_string = body.sign_string.toUpperCase();
    const result = verifyClickRequest(body, 'prepare', SETTINGS);
    expect(result.ok && result.request.amount).toBe(50_000);
  });

  it.each([
    ['a wrong signature', { sign_string: '0'.repeat(32) }],
    ['a truncated signature', { sign_string: 'abc' }],
  ])('rejects %s with SIGN CHECK FAILED', (_label, overrides) => {
    expect(
      verifyClickRequest(prepareBody(overrides), 'prepare', SETTINGS),
    ).toMatchObject({ ok: false, error: ClickError.SignCheckFailed });
  });

  it('rejects a body signed with another secret', () => {
    const body = prepareBody();
    expect(
      verifyClickRequest(body, 'prepare', { ...SETTINGS, secretKey: 'other' }),
    ).toMatchObject({ ok: false, error: ClickError.SignCheckFailed });
  });

  it('rejects a field changed after signing (amount tampering)', () => {
    const body = { ...prepareBody(), amount: '1' };
    expect(verifyClickRequest(body, 'prepare', SETTINGS)).toMatchObject({
      ok: false,
      error: ClickError.SignCheckFailed,
    });
  });

  it('rejects another service id even when correctly signed', () => {
    expect(
      verifyClickRequest(
        prepareBody({ service_id: '999' }),
        'prepare',
        SETTINGS,
      ),
    ).toMatchObject({ ok: false, error: ClickError.BadRequest });
  });

  it('rejects a Complete request posted to the Prepare endpoint', () => {
    // Prepare's signature has no merchant_prepare_id, so it can't match.
    expect(
      verifyClickRequest(
        prepareBody({ action: '1', merchant_prepare_id: '1' }),
        'prepare',
        SETTINGS,
      ),
    ).toMatchObject({ ok: false, error: ClickError.SignCheckFailed });
  });

  it('rejects an unknown action with Action not found', () => {
    expect(
      verifyClickRequest(prepareBody({ action: '2' }), 'prepare', SETTINGS),
    ).toMatchObject({ ok: false, error: ClickError.ActionNotFound });
  });

  it.each([
    ['a non-object body', 'click_trans_id=1'],
    [
      'a missing field',
      (() => {
        const body = prepareBody();
        delete body.sign_time;
        return body;
      })(),
    ],
    ['an array field', { ...prepareBody(), amount: ['50000', '1'] }],
    ['Complete without merchant_prepare_id', prepareBody({ action: '1' })],
  ])('rejects %s as a bad request', (_label, body) => {
    const stage = _label.startsWith('Complete') ? 'complete' : 'prepare';
    expect(verifyClickRequest(body, stage, SETTINGS)).toMatchObject({
      ok: false,
      error: ClickError.BadRequest,
    });
  });
});
