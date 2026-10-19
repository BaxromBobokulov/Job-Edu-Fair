import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClickNotConfiguredError } from './payments.errors';

export interface ClickSettings {
  serviceId: string;
  merchantId: string;
  secretKey: string;
  /** Where Click sends the payer after paying (e.g. https://t.me/<bot>). Optional. */
  returnUrl?: string;
}

const CLICK_PAY_URL = 'https://my.click.uz/services/pay';

/**
 * Click env, validated on first use rather than at boot, so the bot runs for
 * local onboarding work without Click credentials.
 */
@Injectable()
export class ClickConfig {
  private cached?: ClickSettings;

  constructor(private readonly config: ConfigService) {}

  /** @throws ClickNotConfiguredError */
  get(): ClickSettings {
    if (this.cached) return this.cached;

    const read = (key: string) =>
      String(this.config.get<string | number>(key) ?? '').trim();
    const serviceId = read('CLICK_SERVICE_ID');
    const merchantId = read('CLICK_MERCHANT_ID');
    const secretKey = read('CLICK_SECRET_KEY');
    const returnUrl = read('CLICK_RETURN_URL');

    const invalid: string[] = [];
    if (!/^\d+$/.test(serviceId)) invalid.push('CLICK_SERVICE_ID');
    if (!/^\d+$/.test(merchantId)) invalid.push('CLICK_MERCHANT_ID');
    if (!secretKey) invalid.push('CLICK_SECRET_KEY');
    if (returnUrl && !returnUrl.startsWith('https://')) {
      invalid.push('CLICK_RETURN_URL');
    }
    if (invalid.length > 0) throw new ClickNotConfiguredError(invalid);

    this.cached = {
      serviceId,
      merchantId,
      secretKey,
      ...(returnUrl && { returnUrl }),
    };
    return this.cached;
  }

  /**
   * The my.click.uz checkout link. `transaction_param` comes back to us as
   * merchant_trans_id in Prepare/Complete.
   *
   * @throws ClickNotConfiguredError
   */
  payUrl(paymentId: string, amount: number): string {
    const { serviceId, merchantId, returnUrl } = this.get();
    const url = new URL(CLICK_PAY_URL);
    url.searchParams.set('service_id', serviceId);
    url.searchParams.set('merchant_id', merchantId);
    url.searchParams.set('amount', String(amount));
    url.searchParams.set('transaction_param', paymentId);
    if (returnUrl) url.searchParams.set('return_url', returnUrl);
    return url.toString();
  }
}
