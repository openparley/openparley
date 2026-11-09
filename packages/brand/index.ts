// Logos and the brand font, shared by the site, the team server and the overlay build.
import { join } from 'node:path';

const fontDir = join(import.meta.dir, 'node_modules/@fontsource-variable/plus-jakarta-sans');
const serifDir = join(import.meta.dir, 'node_modules/@fontsource/instrument-serif');
const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

export interface FontFile {
  /** Stable public file name. */
  name: string;
  path: string;
  unicodeRange: string;
}

// Variable font (weights 200-800). latin-ext is only downloaded for pages that need those glyphs.
export const FONT_FILES: FontFile[] = [
  {
    name: 'plus-jakarta-sans-latin.woff2',
    path: join(fontDir, 'files/plus-jakarta-sans-latin-wght-normal.woff2'),
    unicodeRange: LATIN,
  },
  {
    name: 'plus-jakarta-sans-latin-ext.woff2',
    path: join(fontDir, 'files/plus-jakarta-sans-latin-ext-wght-normal.woff2'),
    unicodeRange:
      'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
  },
];

/** SIL Open Font License; must travel with the font files. */
export const FONT_LICENSE = { name: 'plus-jakarta-sans-OFL.txt', path: join(fontDir, 'LICENSE') };

/** Instrument Serif Italic, the site's accent face for one emphasised phrase per heading. Not in the overlay. */
const SERIF_FILE: FontFile = {
  name: 'instrument-serif-italic-latin.woff2',
  path: join(serifDir, 'files/instrument-serif-latin-400-italic.woff2'),
  unicodeRange: LATIN,
};
const SERIF_LICENSE = { name: 'instrument-serif-OFL.txt', path: join(serifDir, 'LICENSE') };

/** Everything served under /brand/ by the site and the team server, by public file name. */
export const BRAND_FILES: Record<string, string> = {
  'logo-light.svg': join(import.meta.dir, 'logo-light.svg'),
  'logo-dark.svg': join(import.meta.dir, 'logo-dark.svg'),
  'icon.svg': join(import.meta.dir, 'icon.svg'),
  // The icon cropped to its shape, so it fills a 16px tab instead of floating in padding.
  'favicon.svg': join(import.meta.dir, 'favicon.svg'),
  // Profile pictures for other platforms: the icon on cream, small enough to survive a circle crop.
  // The PNGs are avatar.svg rendered in Chromium.
  'avatar.svg': join(import.meta.dir, 'avatar.svg'),
  'avatar-512.png': join(import.meta.dir, 'avatar-512.png'),
  'avatar-1024.png': join(import.meta.dir, 'avatar-1024.png'),
  // iOS ignores SVG icons and fills transparency with black, hence a padded PNG on white.
  'apple-touch-icon.png': join(import.meta.dir, 'apple-touch-icon.png'),
  [FONT_LICENSE.name]: FONT_LICENSE.path,
  ...Object.fromEntries(FONT_FILES.map((f) => [f.name, f.path])),
  [SERIF_LICENSE.name]: SERIF_LICENSE.path,
  [SERIF_FILE.name]: SERIF_FILE.path,
};

/**
 * `@font-face` rules for the brand fonts served from `/brand/`: 'Plus Jakarta Sans', and 'Instrument Serif'
 * (italic only). Browsers download a face only when a page uses it.
 */
export function brandFontsCss(): string {
  return (
    fontFaceCss('Plus Jakarta Sans', (file) => `/brand/${file.name}`) +
    `@font-face{font-family:'Instrument Serif';font-style:italic;font-weight:400;font-display:swap;` +
    `src:url("/brand/${SERIF_FILE.name}") format('woff2');unicode-range:${SERIF_FILE.unicodeRange}}`
  );
}

export function fontFaceCss(family: string, url: (file: FontFile) => string): string {
  return FONT_FILES.map(
    (file) =>
      `@font-face{font-family:'${family}';font-style:normal;font-weight:200 800;font-display:swap;` +
      `src:url(${JSON.stringify(url(file))}) format('woff2');unicode-range:${file.unicodeRange}}`,
  ).join('');
}
