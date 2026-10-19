import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { ClickConfig } from './click.config';
import {
  CLICK_ERROR_NOTE,
  ClickError,
  ClickResponse,
  ClickStage,
  echoClickTransId,
  verifyClickRequest,
} from './click.protocol';
import { ClickNotConfiguredError } from './payments.errors';
import { ClickResult, PaymentsService } from './payments.service';

/**
 * The only place Click webhooks land. Configure in the Click merchant cabinet:
 * Prepare URL → POST /click/prepare, Complete URL → POST /click/complete.
 *
 * Never log the body or any signed field — only the verified payment id and
 * the result code.
 */
@Controller('click')
export class ClickController {
  private readonly logger = new Logger(ClickController.name);

  constructor(
    private readonly click: ClickConfig,
    private readonly payments: PaymentsService,
  ) {}

  @Post('prepare')
  @HttpCode(200)
  prepare(@Body() body: unknown): Promise<ClickResponse> {
    return this.handle('prepare', body);
  }

  @Post('complete')
  @HttpCode(200)
  complete(@Body() body: unknown): Promise<ClickResponse> {
    return this.handle('complete', body);
  }

  private async handle(
    stage: ClickStage,
    body: unknown,
  ): Promise<ClickResponse> {
    let settings;
    try {
      settings = this.click.get();
    } catch (err) {
      if (!(err instanceof ClickNotConfiguredError)) throw err;
      this.logger.error(`Click ${stage} received, but ${err.message}`);
      return {
        error: ClickError.BadRequest,
        error_note: CLICK_ERROR_NOTE[ClickError.BadRequest],
      };
    }

    const verification = verifyClickRequest(body, stage, settings);
    if (!verification.ok) {
      // Rejected before anything touches the database.
      this.logger.warn(
        `Click ${stage} rejected: ${CLICK_ERROR_NOTE[verification.error]}`,
      );
      return {
        click_trans_id: echoClickTransId(verification.raw.click_trans_id),
        merchant_trans_id: verification.raw.merchant_trans_id,
        error: verification.error,
        error_note: CLICK_ERROR_NOTE[verification.error],
      };
    }

    const { request } = verification;
    let result: ClickResult;
    try {
      result =
        stage === 'prepare'
          ? await this.payments.handlePrepare(request)
          : await this.payments.handleComplete(request);
    } catch (err) {
      const name = err instanceof Error ? err.name : typeof err;
      this.logger.error(
        `Click ${stage} failed for payment ${request.merchantTransId}: ${name}`,
      );
      result = { error: ClickError.UpdateFailed };
    }

    if (result.error !== ClickError.Success) {
      this.logger.warn(
        `Click ${stage} for payment ${request.merchantTransId}: ${CLICK_ERROR_NOTE[result.error]}`,
      );
    }
    return {
      click_trans_id: echoClickTransId(request.clickTransId.toString()),
      merchant_trans_id: request.merchantTransId,
      ...(result.merchantId !== undefined &&
        (stage === 'prepare'
          ? { merchant_prepare_id: result.merchantId }
          : { merchant_confirm_id: result.merchantId })),
      error: result.error,
      error_note: CLICK_ERROR_NOTE[result.error],
    };
  }
}
