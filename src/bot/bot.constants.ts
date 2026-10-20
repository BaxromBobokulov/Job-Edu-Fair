import { ADMIN_COMMANDS } from '../admin/admin.constants';

export const LANGUAGE_SCENE_ID = 'language';
export const ONBOARDING_SCENE_ID = 'onboarding';
export const TRACK_SPLIT_SCENE_ID = 'track-split';

/** Callback data of the language picker's inline buttons: `lang:uz` etc. */
export const LANGUAGE_CALLBACK_PREFIX = 'lang:';
export const LANGUAGE_CALLBACK_RE = /^lang:(uz|ru|en)$/;

/** Inline button on the expiry notice: get a fresh invoice if a place is free. */
export const PAY_RETRY_CALLBACK = 'pay:retry';

/**
 * HR decision buttons: `hr:<ScanDecision>:<participantId>`. The company is
 * never in the callback — it always comes from the pressing HR user's binding.
 */
export const HR_DECISION_CALLBACK_PREFIX = 'hr:';
export const HR_DECISION_CALLBACK_RE =
  /^hr:(interview|internship|reserve):([0-9a-f-]{36})$/;

/** Event-day clock for times shown to HR (check-in, decisions). */
export const EVENT_TIME_ZONE = 'Asia/Tashkent';

/**
 * Commands that work before a language is picked in this session: `/status`
 * answers in the language stored at registration, admin commands in English.
 */
export const LANGUAGE_FREE_COMMANDS: readonly string[] = [
  'status',
  ...ADMIN_COMMANDS,
];
