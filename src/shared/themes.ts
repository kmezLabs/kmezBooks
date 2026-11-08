// A company's theme (CO-11): its colours while it is open. Saved in the company
// file, so it is the same on every computer; the start screen follows the
// computer's light or dark setting. Each id except system is a [data-theme]
// block in src/app/app.css, which themes.test.ts checks is complete and readable.

export type ThemeGroup = 'Follows this computer' | 'Light' | 'Dark' | 'High contrast' | 'Colour';

export const THEME_GROUPS: readonly ThemeGroup[] = [
  'Follows this computer',
  'Light',
  'Dark',
  'High contrast',
  'Colour',
];

export const THEMES = [
  {
    id: 'system',
    name: 'Follow this computer',
    about: 'Light or dark, as this computer is set.',
    group: 'Follows this computer',
  },
  { id: 'light', name: 'Light', about: 'White pages, dark text.', group: 'Light' },
  { id: 'grey', name: 'Grey', about: 'Softer than Light, with less glare.', group: 'Light' },
  {
    id: 'warm',
    name: 'Warm',
    about: 'Cream paper and brown ink, for long sessions.',
    group: 'Light',
  },
  { id: 'sage', name: 'Sage', about: 'Soft green-grey, gentle on the eyes.', group: 'Light' },
  {
    id: 'lavender',
    name: 'Lavender',
    about: 'Soft violet-grey, gentle on the eyes.',
    group: 'Light',
  },
  { id: 'dark', name: 'Dark', about: 'Dark pages, light text, for dim rooms.', group: 'Dark' },
  { id: 'midnight', name: 'Midnight', about: 'Deep navy with light text.', group: 'Dark' },
  { id: 'charcoal', name: 'Charcoal', about: 'Neutral dark grey with light text.', group: 'Dark' },
  { id: 'espresso', name: 'Espresso', about: 'Warm dark brown with cream text.', group: 'Dark' },
  {
    id: 'contrast',
    name: 'High contrast',
    about: 'Black on white with strong lines, easiest to read.',
    group: 'High contrast',
  },
  {
    id: 'contrast-dark',
    name: 'High contrast dark',
    about: 'White on black with strong lines, for low vision in a dark room.',
    group: 'High contrast',
  },
  { id: 'ocean', name: 'Ocean', about: 'Light pages with a blue accent.', group: 'Colour' },
  { id: 'forest', name: 'Forest', about: 'Light pages with a green accent.', group: 'Colour' },
  { id: 'plum', name: 'Plum', about: 'Light pages with a purple accent.', group: 'Colour' },
  { id: 'rose', name: 'Rose', about: 'Light pages with a deep red accent.', group: 'Colour' },
] as const satisfies readonly { id: string; name: string; about: string; group: ThemeGroup }[];

export type ThemeId = (typeof THEMES)[number]['id'];

export const isThemeId = (id: unknown): id is ThemeId => THEMES.some((t) => t.id === id);

/** Show a theme: set data-theme on <html>, or remove it to follow the computer. */
export function applyTheme(id: ThemeId): void {
  const root = document.documentElement;
  if (id === 'system') delete root.dataset.theme;
  else root.dataset.theme = id;
}
