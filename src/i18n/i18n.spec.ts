import { DIRECTIONS } from '../participants/registration.rules';
import { isLang, LANGUAGES, MessageKey, t } from './i18n';
import { translations } from './translations';

const placeholders = (text: string) =>
  [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('translations', () => {
  const keys = Object.keys(translations.en) as MessageKey[];

  it.each(LANGUAGES)('%s has a non-empty text for every key', (lang) => {
    expect(Object.keys(translations[lang]).sort()).toEqual([...keys].sort());
    for (const key of keys) {
      expect(translations[lang][key].trim()).not.toBe('');
    }
  });

  it.each(LANGUAGES)('%s uses the same placeholders as en', (lang) => {
    for (const key of keys) {
      expect([key, placeholders(translations[lang][key])]).toEqual([
        key,
        placeholders(translations.en[key]),
      ]);
    }
  });

  it.each(LANGUAGES)('%s direction labels are unique', (lang) => {
    const labels = DIRECTIONS.map((d) => t(`direction.${d}`, lang));
    expect(new Set(labels).size).toBe(DIRECTIONS.length);
  });

  it.each(LANGUAGES)('%s filter answers are distinct', (lang) => {
    expect(t('filter.yes', lang)).not.toBe(t('filter.no', lang));
  });
});

describe('t()', () => {
  it('resolves a key in the requested language', () => {
    expect(t('direction.Other', 'uz')).toBe('Boshqa');
    expect(t('direction.Other', 'ru')).toBe('Другое');
    expect(t('direction.Other', 'en')).toBe('Other');
  });

  it('fills placeholders and leaves unknown ones untouched', () => {
    expect(t('phone.useButton', 'en', { button: 'X' })).toBe(
      'Please tap “X” below.',
    );
    expect(t('phone.useButton', 'en')).toBe('Please tap “{button}” below.');
  });

  it('recognizes only supported language codes', () => {
    expect(isLang('ru')).toBe(true);
    expect(isLang('de')).toBe(false);
    expect(isLang(undefined)).toBe(false);
  });
});
