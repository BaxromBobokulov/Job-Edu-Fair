import { LANGUAGES, Lang, MessageKey, translations } from './translations';

export { LANGUAGES };
export type { Lang, MessageKey };

export function isLang(value: unknown): value is Lang {
  return LANGUAGES.includes(value as Lang);
}

/**
 * The only place a message key is resolved to user-facing text.
 * `{param}` placeholders are replaced from `params`.
 */
export function t(
  key: MessageKey,
  lang: Lang,
  params: Record<string, string> = {},
): string {
  return translations[lang][key].replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? params[name] : match,
  );
}
