import { ADMIN_COMMANDS } from '../admin/admin.constants';

export const LANGUAGE_SCENE_ID = 'language';
export const ONBOARDING_SCENE_ID = 'onboarding';
export const TRACK_SPLIT_SCENE_ID = 'track-split';

/** Callback data of the language picker's inline buttons: `lang:uz` etc. */
export const LANGUAGE_CALLBACK_PREFIX = 'lang:';
export const LANGUAGE_CALLBACK_RE = /^lang:(uz|ru|en)$/;

/**
 * Commands that work before a language is picked in this session: `/status`
 * answers in the language stored at registration, admin commands in English.
 */
export const LANGUAGE_FREE_COMMANDS: readonly string[] = [
  'status',
  ...ADMIN_COMMANDS,
];
