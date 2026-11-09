import { beforeEach, describe, expect, test } from 'bun:test';
import { createAnchor, resolveAnchor, stableClass, stableId, textSimilarity } from '../src/anchor';

function page(html: string) {
  document.body.innerHTML = html;
}

function anchorFor(selector: string) {
  const el = document.querySelector(selector)!;
  return createAnchor(el, 0, 0);
}

beforeEach(() => page(''));

describe('createAnchor', () => {
  test('captures selector, path, text and identity attributes', () => {
    page(`<main><nav><a href="/pricing" class="nav-link">Pricing</a></nav><button data-testid="buy" class="btn">Buy  now</button></main>`);
    const anchor = anchorFor('button');
    expect(anchor.tag).toBe('button');
    expect(anchor.text).toBe('Buy now');
    expect(anchor.attrs['data-testid']).toBe('buy');
    expect(anchor.path).toBe('body > main:nth-of-type(1) > button:nth-of-type(1)');
    expect(document.querySelectorAll(anchor.selector)).toHaveLength(1);
  });

  test('ignores hashed and utility class names in the selector', () => {
    page(`<div><p class="css-1x2y3z hover:text-red">One</p><p class="intro">Two</p></div>`);
    const anchor = anchorFor('p');
    expect(anchor.selector).not.toContain('css-1x2y3z');
    expect(anchor.selector).not.toContain('hover');
  });

  test('stores the click point as a fraction of the element box, clamped', () => {
    page(`<button>Go</button>`);
    const el = document.querySelector('button')!;
    el.getBoundingClientRect = () => ({ left: 100, top: 50, width: 200, height: 40, right: 300, bottom: 90, x: 100, y: 50, toJSON() {} }) as DOMRect;
    expect(createAnchor(el, 150, 60).point).toEqual([0.25, 0.25]);
    expect(createAnchor(el, 999, -5).point).toEqual([1, 0]);
  });
});

describe('resolveAnchor', () => {
  test('finds the same element on an unchanged page as an exact match', () => {
    page(`<ul><li>Alpha</li><li>Beta</li><li>Gamma</li></ul>`);
    const anchor = anchorFor('li:nth-child(2)');
    const match = resolveAnchor(anchor);
    expect(match?.element.textContent).toBe('Beta');
    expect(match?.exact).toBe(true);
  });

  test('survives a class rename when text and structure still agree', () => {
    page(`<section><button class="secondary">Back</button><button class="primary">Pay now</button></section>`);
    const anchor = anchorFor('.primary');
    expect(anchor.selector).toContain('primary');
    page(`<section><button class="btn-alt">Back</button><button class="btn-main">Pay now</button></section>`);
    const match = resolveAnchor(anchor);
    expect(match?.element.textContent).toBe('Pay now');
    expect(match?.exact).toBe(false);
  });

  test('survives the element moving when it has a stable test id', () => {
    page(`<div><button data-testid="save">Save</button></div>`);
    const anchor = anchorFor('button');
    page(`<header></header><aside><div><span><button data-testid="save">Save changes</button></span></div></aside>`);
    expect(resolveAnchor(anchor)?.element.getAttribute('data-testid')).toBe('save');
  });

  test('prefers the candidate whose text matches when the selector became ambiguous', () => {
    page(`<div class="cards"><div class="card">First</div><div class="card">Second</div></div>`);
    const anchor = anchorFor('.card:nth-child(2)');
    page(`<div class="cards"><div class="card">New</div><div class="card">First</div><div class="card">Second</div></div>`);
    expect(resolveAnchor(anchor)?.element.textContent).toBe('Second');
  });

  test('falls back to a unique exact-text match when structure changed completely', () => {
    page(`<div><div><p>Shipping is free above €50</p></div></div>`);
    const anchor = anchorFor('p');
    page(`<article><p>Intro</p><footer><p>Shipping is free above €50</p></footer></article>`);
    expect(resolveAnchor(anchor)?.element.textContent).toBe('Shipping is free above €50');
  });

  test('reports not found rather than guessing when text is ambiguous', () => {
    page(`<div><p>Read more</p></div>`);
    const anchor = { ...anchorFor('p'), selector: '', path: '' };
    page(`<p>Read more</p><p>Read more</p>`);
    expect(resolveAnchor(anchor)).toBeNull();
  });

  test('does not pin to an unrelated element that only shares the position', () => {
    page(`<main><p>Original paragraph about pricing</p></main>`);
    const anchor = anchorFor('p');
    page(`<main><p>Completely different words here</p></main>`);
    expect(resolveAnchor(anchor)).toBeNull();
  });

  test('requires the tag to match', () => {
    page(`<div><span id="total">42</span></div>`);
    const anchor = anchorFor('span');
    page(`<div><div id="total">42</div></div>`);
    expect(resolveAnchor(anchor)).toBeNull();
  });

  test('tolerates invalid selectors from untrusted anchors', () => {
    page(`<p>Hello</p>`);
    const anchor = { ...anchorFor('p'), selector: '###', path: 'body >>> p' };
    expect(resolveAnchor(anchor)?.element.textContent).toBe('Hello');
  });
});

describe('textSimilarity', () => {
  test('is 1 for equal strings and 0 for unrelated ones', () => {
    expect(textSimilarity('Submit', 'Submit')).toBe(1);
    expect(textSimilarity('abc', 'xyz')).toBe(0);
    expect(textSimilarity('', 'x')).toBe(0);
  });

  test('scores typo fixes highly', () => {
    expect(textSimilarity('Sumbit order', 'Submit order')).toBeGreaterThan(0.6);
  });
});

describe('selector hygiene', () => {
  test('keeps meaningful class names, including BEM', () => {
    for (const name of ['primary', 'nav-link', 'card__title', 'card__title--active', 'checkoutButton']) expect(stableClass(name)).toBe(true);
  });

  test('rejects utility, variant and generated class names', () => {
    for (const name of ['mt-4', 'hover:text-red', 'w-[200px]', 'css-1x2y3z', 'sc-bdVaJa', 'Button_root__a8Df2', 'jsx-3829123'])
      expect(stableClass(name)).toBe(false);
  });

  test('keeps hand-written ids and rejects generated ones', () => {
    for (const id of ['checkout', 'section-2', 'main-nav']) expect(stableId(id)).toBe(true);
    for (const id of [':r1:', '123', 'ember482', 'radix-:R1:', 'a1b2c3d4e5f6', 'react-select-2-input']) expect(stableId(id)).toBe(false);
  });
});
