import { describe, expect, test } from 'bun:test';
import { decodeThreads, encodeThreads, isThread, readShareHash, refLink, stripShareHash, threadsLink } from '../src/share';
import { thread } from './fixtures';

describe('share links', () => {
  test('round-trip threads with unicode content', async () => {
    const original = thread({ comments: [{ id: 'c1', author: { id: 'a', name: 'Zoë' }, body: 'Te klein 👀 — "quotes" & <tags>', createdAt: 5 }] });
    const link = await threadsLink(new URL('https://shop.test/checkout?step=2'), [original]);
    const url = new URL(link);
    expect(url.pathname).toBe('/checkout');
    expect(url.search).toBe('?step=2');
    const payload = await readShareHash(url.hash);
    expect(payload).toEqual({ kind: 'threads', threads: [original] });
  });

  test('compress well enough to keep typical links short', async () => {
    const value = await encodeThreads([thread()]);
    expect(value.startsWith('z1.')).toBe(true);
    expect(value.length).toBeLessThan(600);
  });

  test('reference links carry only the thread id', async () => {
    const link = refLink(new URL('https://shop.test/'), 'abc123');
    expect(link).toBe('https://shop.test/#parley=t.abc123');
    expect(await readShareHash('#parley=t.abc123')).toEqual({ kind: 'ref', threadId: 'abc123' });
  });

  test('ignore garbage instead of throwing', async () => {
    expect(await readShareHash('')).toBeNull();
    expect(await readShareHash('#/dashboard')).toBeNull();
    expect(await readShareHash('#parley=z1.not-base64!!')).toBeNull();
    expect(await readShareHash('#parley=q9.abc')).toBeNull();
    expect(await readShareHash('#parley=t.<script>')).toBeNull();
  });

  test('drop threads that fail validation', async () => {
    const bad = [
      { ...thread(), anchor: { ...thread().anchor, point: [5, 0] } },
      { ...thread(), status: 'deleted' },
      { ...thread(), comments: [{ id: 'x', author: { id: 'a', name: 'A' }, body: '', createdAt: 1 }] },
      { ...thread(), author: { id: '', name: 'A' } },
    ];
    for (const value of bad) expect(isThread(value)).toBe(false);
    const json = btoa(JSON.stringify({ threads: [...bad, thread({ id: 'ok' })] })).replace(/=+$/, '');
    expect((await decodeThreads(`j1.${json}`)).map((t) => t.id)).toEqual(['ok']);
  });

  test('stripShareHash keeps unrelated hash content', () => {
    expect(stripShareHash('#parley=t.abc')).toBe('');
    expect(stripShareHash('#tab=2&parley=t.abc')).toBe('#tab=2');
    expect(stripShareHash('#section-3')).toBe('#section-3');
  });
});
