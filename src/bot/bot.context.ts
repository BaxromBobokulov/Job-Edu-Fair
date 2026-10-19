import { Scenes } from 'telegraf';
import type { Lang } from '../i18n/i18n';

/** Data scoped to the currently active wizard scene (`ctx.scene.session`). */
export type BotWizardSessionData = Scenes.WizardSessionData;

/** Answers collected by the onboarding scene, consumed by the track-split scene. */
export interface RegistrationDraft {
  phone?: string;
  fullName?: string;
  birthYearOrCourse?: string;
  direction?: string;
}

/** Data persisted per chat/user across messages (`ctx.session`). */
export interface BotSession extends Scenes.WizardSession<BotWizardSessionData> {
  /** ISO timestamp of the last `/start`; used to verify session persistence. */
  startedAt?: string;
  /** Picked in the language scene; every bot message after that renders in it. */
  language?: Lang;
  registration?: RegistrationDraft;
}

/**
 * Bot context type, following Telegraf's wizard typing pattern:
 * a session-aware context with `scene` and `wizard` helpers.
 */
export interface BotContext extends Scenes.WizardContext<BotWizardSessionData> {
  session: BotSession;
  scene: Scenes.SceneContextScene<BotContext, BotWizardSessionData>;
  wizard: Scenes.WizardContextWizard<BotContext>;
}
