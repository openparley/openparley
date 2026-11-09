import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { listenForShortcut, parseShortcut } from '../src/shortcut';

let host: HTMLElement;
let triggered = 0;
let stop: () => void = () => {};
const cleanups: (() => void)[] = [];

function press(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true, composed: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** Adds a listener the way a host page would, removed after the test. */
function pageListener(target: EventTarget, listener: (e: Event) => void, capture = false) {
  target.addEventListener('keydown', listener, capture);
  cleanups.push(() => target.removeEventListener('keydown', listener, capture));
}

const settle = () => Bun.sleep(5);

beforeEach(() => {
  document.body.innerHTML = '<p id="text">Hi</p><input id="field"><div id="editor" contenteditable="true"></div><div id="box" role="textbox"></div>';
  host = document.createElement('openparley-overlay');
  document.documentElement.append(host);
  triggered = 0;
});

afterEach(() => {
  stop();
  for (const cleanup of cleanups.splice(0)) cleanup();
  host.remove();
});

describe('parseShortcut', () => {
  test('defaults to c, accepts any single key, and can be turned off', () => {
    expect(parseShortcut(undefined)).toBe('c');
    expect(parseShortcut('N')).toBe('n');
    expect(parseShortcut(false)).toBeNull();
    expect(parseShortcut('off')).toBeNull();
    expect(parseShortcut('')).toBeNull();
  });

  test('rejects combinations and words with a readable error', () => {
    expect(() => parseShortcut('ctrl+c')).toThrow('single key');
    expect(() => parseShortcut('cc')).toThrow('single key');
  });
});

describe('priority "page"', () => {
  beforeEach(() => {
    stop = listenForShortcut({ key: 'c', priority: 'page', host, onTrigger: () => triggered++ });
  });

  test('fires after the page had its turn', async () => {
    press(document.getElementById('text')!);
    expect(triggered).toBe(0);
    await settle();
    expect(triggered).toBe(1);
  });

  test('yields when any page handler used the key, even one registered after OpenParley', async () => {
    pageListener(window, (e) => e.preventDefault());
    press(document.getElementById('text')!);
    await settle();
    expect(triggered).toBe(0);
  });

  test('yields when the page stops propagation', async () => {
    pageListener(document, (e) => e.stopPropagation());
    press(document.getElementById('text')!);
    await settle();
    expect(triggered).toBe(0);
  });

  test('ignores typing, modifiers, repeats and other keys', async () => {
    for (const id of ['field', 'editor', 'box']) press(document.getElementById(id)!);
    const text = document.getElementById('text')!;
    press(text, { metaKey: true });
    press(text, { ctrlKey: true });
    press(text, { shiftKey: true, key: 'C' });
    press(text, { repeat: true });
    press(text, { key: 'x' });
    await settle();
    expect(triggered).toBe(0);
  });

  test('ignores keys typed into an input inside a shadow root', async () => {
    const widget = document.createElement('div');
    document.body.append(widget);
    const input = document.createElement('input');
    widget.attachShadow({ mode: 'open' }).append(input);
    press(input);
    await settle();
    expect(triggered).toBe(0);
  });

  test('stopping the listener cancels a pending trigger', async () => {
    press(document.getElementById('text')!);
    stop();
    await settle();
    expect(triggered).toBe(0);
  });
});

describe('priority "openparley"', () => {
  test('fires immediately and hides the key from the page', () => {
    stop = listenForShortcut({ key: 'c', priority: 'openparley', host, onTrigger: () => triggered++ });
    let pageSaw = 0;
    pageListener(document, () => pageSaw++);
    const event = press(document.getElementById('text')!);
    expect(triggered).toBe(1);
    expect(pageSaw).toBe(0);
    expect(event.defaultPrevented).toBe(true);
  });

  test('still never fires while typing', () => {
    stop = listenForShortcut({ key: 'c', priority: 'openparley', host, onTrigger: () => triggered++ });
    press(document.getElementById('field')!);
    expect(triggered).toBe(0);
  });
});
