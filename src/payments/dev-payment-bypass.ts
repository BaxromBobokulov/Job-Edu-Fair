import { ConfigService } from '@nestjs/config';

/**
 * Gate for /dev_mark_paid (marking a payment paid without Click). Needs both
 * an explicit ALLOW_DEV_PAYMENT_BYPASS=true and NODE_ENV other than
 * production: the flag alone keeps it off by default, and NODE_ENV alone
 * would turn it on in a production deploy that forgot to set NODE_ENV.
 * Read on every call, never cached.
 */
export function devPaymentBypassEnabled(config: ConfigService): boolean {
  return (
    config.get<string>('ALLOW_DEV_PAYMENT_BYPASS') === 'true' &&
    config.get<string>('NODE_ENV') !== 'production'
  );
}
