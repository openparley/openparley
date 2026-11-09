import type { Thread } from '@openparley/protocol';

export function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: 't1',
    page: '/',
    anchor: { v: 1, selector: 'p', path: 'body > p:nth-of-type(1)', tag: 'p', text: 'Hello', attrs: {}, point: [0.5, 0.5] },
    status: 'open',
    statusAt: 1000,
    createdAt: 1000,
    author: { id: 'a', name: 'Ada' },
    comments: [{ id: 'c1', author: { id: 'a', name: 'Ada' }, body: 'First', createdAt: 1000 }],
    ...overrides,
  };
}
