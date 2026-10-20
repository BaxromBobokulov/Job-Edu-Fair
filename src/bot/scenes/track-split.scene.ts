import { Command, Ctx, Next, On, Wizard, WizardStep } from 'nestjs-telegraf';
import { Markup } from 'telegraf';
import { Lang, MessageKey, t } from '../../i18n/i18n';
import {
  AlreadyRegisteredError,
  InvalidRegistrationError,
  RegistrationClosedError,
} from '../../participants/participants.errors';
import { ParticipantsService } from '../../participants/participants.service';
import { PaymentsService } from '../../payments/payments.service';
import { parseCvLink } from '../../participants/registration.rules';
import { TRACK_SPLIT_SCENE_ID } from '../bot.constants';
import type { BotContext } from '../bot.context';
import { sendPaymentOffer } from '../payment.update';
import {
  cancelRegistration,
  isCommand,
  langOf,
  logUnexpected,
  replyT,
  textOf,
} from './registration.helpers';

function filterKeyboard(lang: Lang) {
  return Markup.keyboard([[t('filter.yes', lang)], [t('filter.no', lang)]])
    .resize()
    .oneTime();
}

/**
 * The Job/Edu filter question; saves the participant at the end of either
 * branch, then offers the Click payment.
 */
@Wizard(TRACK_SPLIT_SCENE_ID)
export class TrackSplitScene {
  constructor(
    private readonly participants: ParticipantsService,
    private readonly payments: PaymentsService,
  ) {}

  @Command('cancel')
  async onCancel(@Ctx() ctx: BotContext): Promise<void> {
    await cancelRegistration(ctx);
  }

  @WizardStep(1)
  async askFilter(@Ctx() ctx: BotContext): Promise<void> {
    await replyT(ctx, 'filter.prompt', filterKeyboard(langOf(ctx)));
    ctx.wizard.next();
  }

  @WizardStep(2)
  @On('message')
  async onFilterAnswer(
    @Ctx() ctx: BotContext,
    @Next() next: () => Promise<void>,
  ): Promise<void> {
    if (isCommand(ctx)) return next();
    const lang = langOf(ctx);
    const answer = textOf(ctx);
    if (answer === t('filter.yes', lang)) {
      await replyT(ctx, 'cvLink.prompt', Markup.removeKeyboard());
      ctx.wizard.next();
    } else if (answer === t('filter.no', lang)) {
      await this.complete(ctx, false, null);
    } else {
      await replyT(ctx, 'common.pickButton', filterKeyboard(lang));
    }
  }

  @WizardStep(3)
  @On('message')
  async onCvLink(
    @Ctx() ctx: BotContext,
    @Next() next: () => Promise<void>,
  ): Promise<void> {
    if (isCommand(ctx)) return next();
    const cvLink = parseCvLink(textOf(ctx) ?? '');
    if (!cvLink) {
      await replyT(ctx, 'cvLink.invalid');
      return;
    }
    await this.complete(ctx, true, cvLink);
  }

  private async complete(
    ctx: BotContext,
    hasSkillAndPortfolio: boolean,
    cvLink: string | null,
  ): Promise<void> {
    const draft = ctx.session.registration;
    const languageCode = ctx.session.language;
    if (
      !ctx.from ||
      !languageCode ||
      !draft?.phone ||
      !draft.fullName ||
      !draft.birthYearOrCourse ||
      !draft.direction
    ) {
      // Draft lost (e.g. in-memory session reset) — start over rather than save partial data.
      await ctx.scene.leave();
      await replyT(ctx, 'registration.sessionExpired', Markup.removeKeyboard());
      return;
    }

    let key: MessageKey;
    let params: Record<string, string> | undefined;
    let participantId: string | undefined;
    try {
      const participant = await this.participants.register({
        telegramId: ctx.from.id,
        languageCode,
        phone: draft.phone,
        fullName: draft.fullName,
        birthYearOrCourse: draft.birthYearOrCourse,
        direction: draft.direction,
        hasSkillAndPortfolio,
        cvLink,
      });
      participantId = participant.id;
      key = 'registration.success';
      params = {
        name: participant.fullName ?? draft.fullName,
        track: participant.track
          ? t(`track.${participant.track}`, languageCode)
          : '—',
      };
    } catch (err) {
      if (err instanceof RegistrationClosedError) {
        key = 'registration.closed';
      } else if (err instanceof AlreadyRegisteredError) {
        key = 'registration.alreadyRegistered';
      } else if (err instanceof InvalidRegistrationError) {
        key = 'registration.invalid';
      } else {
        // Stay on this step with the draft intact so the user can simply retry.
        logUnexpected('register', err);
        await replyT(ctx, 'error.tryAgainLater');
        return;
      }
    }

    delete ctx.session.registration;
    await ctx.scene.leave();
    await replyT(ctx, key, Markup.removeKeyboard(), params);
    if (participantId) {
      await sendPaymentOffer(ctx, this.payments, participantId, languageCode);
    }
  }
}
