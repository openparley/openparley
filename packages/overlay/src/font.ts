// The brand font ships as separate files next to the overlay (never inside the JS bundle).
// @font-face has no effect inside a shadow root, so the rule goes into the host document, under
// a private family name so it can't clash with the page's own fonts. If the page's CSP blocks
// it, the overlay simply uses the system font.

declare const __FONT_FACES__: { file: string; unicodeRange: string }[] | undefined;

export const FONT_FAMILY = 'OpenParley Sans';

export function injectFont(): () => void {
  // Only the script-tag build knows its font files; npm users get the system font.
  if (typeof __FONT_FACES__ === 'undefined' || document.querySelector('style[data-openparley-font]')) return () => {};
  const style = document.createElement('style');
  style.dataset.openparleyFont = '';
  style.textContent = __FONT_FACES__.map(
    ({ file, unicodeRange }) =>
      `@font-face{font-family:'${FONT_FAMILY}';font-style:normal;font-weight:200 800;font-display:swap;` +
      `src:url(${JSON.stringify(new URL(file, import.meta.url).href)}) format('woff2');unicode-range:${unicodeRange}}`,
  ).join('');
  document.head.append(style);
  return () => style.remove();
}
