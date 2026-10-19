import { Command, Ctx, Next, On, Wizard, WizardStep } from 'nestjs-telegraf';
import { Markup } from 'telegraf';
import { Lang, t } from '../../i18n/i18n';
import {
  DIRECTIONS,
  parseBirthYearOrCourse,
  parseFullName,
  parsePhone,
} from '../../participants/registration.rules';
import { ONBOARDING_SCENE_ID, TRACK_SPLIT_SCENE_ID } from '../bot.constants';
import type { BotContext } from '../bot.context';
import {
  cancelRegistration,
  directionFromLabel,
  directionLabel,
  draftOf,
  isCommand,
  langOf,
  replyT,
  textOf,
} from './registration.helpers';

function phoneKeyboard(lang: Lang) {
  return Markup.keyboard([
    Markup.button.contactRequest(t('phone.button', lang)),
  ])
    .resize()
    .oneTime();
}

function directionKeyboard(lang: Lang) {
  const labels = DIRECTIONS.map((d) => directionLabel(d, lang));
  const rows: string[][] = [];
  // Two buttons per row.
  for (let i = 0; i < labels.length; i += 2) rows.push(labels.slice(i, i + 2));
  return Markup.keyboard(rows).resize().oneTime();
}

/** Phone → full name → birth year/course → direction, then hands off to track-split. */
@Wizard(ONBOARDING_SCENE_ID)
export class OnboardingScene {
  @Command('cancel')
  async onCancel(@Ctx() ctx: BotContext): Promise<void> {
    await cancelRegistration(ctx);
  }

  @WizardStep(1)
  async askPhone(@Ctx() ctx: BotContext): Promise<void> {
    await replyT(ctx, 'phone.prompt', phoneKeyboard(langOf(ctx)));
    ctx.wizard.next();
  }

  @WizardStep(2)
  @On('message')
  async onPhone(
    @Ctx() ctx: BotContext,
    @Next() next: () => Promise<void>,
  ): Promise<void> {
    if (isCommand(ctx)) return next();
    const lang = langOf(ctx);
    const msg = ctx.message;
    if (!msg || !('contact' in msg)) {
      await replyT(ctx, 'phone.useButton', phoneKeyboard(lang), {
        button: t('phone.button', lang),
      });
      return;
    }
    // Only the account's own number — not a forwarded contact card.
    const phone =
      msg.contact.user_id === ctx.from?.id
        ? parsePhone(msg.contact.phone_number)
        : null;
    if (!phone) {
      await replyT(ctx, 'phone.notOwn', phoneKeyboard(lang));
      return;
    }
    draftOf(ctx).phone = phone;
    await replyT(ctx, 'fullName.prompt', Markup.removeKeyboard());
    ctx.wizard.next();
  }

  @WizardStep(3)
  @On('message')
  async onFullName(
    @Ctx() ctx: BotContext,
    @Next() next: () => Promise<void>,
  ): Promise<void> {
    if (isCommand(ctx)) return next();
    const fullName = parseFullName(textOf(ctx) ?? '');
    if (!fullName) {
      await replyT(ctx, 'fullName.invalid');
      return;
    }
    draftOf(ctx).fullName = fullName;
    await replyT(ctx, 'birthYearOrCourse.prompt');
    ctx.wizard.next();
  }

  @WizardStep(4)
  @On('message')
  async onBirthYearOrCourse(
    @Ctx() ctx: BotContext,
    @Next() next: () => Promise<void>,
  ): Promise<void> {
    if (isCommand(ctx)) return next();
    const value = parseBirthYearOrCourse(textOf(ctx) ?? '');
    if (!value) {
      await replyT(ctx, 'birthYearOrCourse.invalid');
      return;
    }
    draftOf(ctx).birthYearOrCourse = value;
    await replyT(ctx, 'direction.prompt', directionKeyboard(langOf(ctx)));
    ctx.wizard.next();
  }

  @WizardStep(5)
  @On('message')
  async onDirection(
    @Ctx() ctx: BotContext,
    @Next() next: () => Promise<void>,
  ): Promise<void> {
    if (isCommand(ctx)) return next();
    const lang = langOf(ctx);
    // The button shows a translated label; the draft keeps the stored value.
    const direction = directionFromLabel(textOf(ctx) ?? '', lang);
    if (!direction) {
      await replyT(ctx, 'common.pickButton', directionKeyboard(lang));
      return;
    }
    draftOf(ctx).direction = direction;
    await ctx.scene.enter(TRACK_SPLIT_SCENE_ID);
  }
}
