import { beforeEach, describe, expect, test } from 'bun:test';
import { gateOpen, hashRequestsOverlay, memberKey, readFlag, setFlag } from '../src/gate';

const SERVER = 'https://parley.example.com';

beforeEach(() => localStorage.clear());

test('always loads by default', () => {
  expect(gateOpen({})).toBe(true);
  expect(gateOpen({ launcher: 'always' }, '')).toBe(true);
});

test('#openparley=off is not mistaken for a thread link', () => {
  expect(hashRequestsOverlay('#openparley')).toBe(true);
  expect(hashRequestsOverlay('#parley=t.abc')).toBe(true);
  expect(hashRequestsOverlay('#tab=2&openparley')).toBe(true);
  expect(hashRequestsOverlay('#openparley=off')).toBe(false);
  expect(hashRequestsOverlay('#section-openparley')).toBe(false);
  expect(hashRequestsOverlay('')).toBe(false);
});

describe('auto', () => {
  test('stays off until switched on, then remembers until switched off', () => {
    expect(gateOpen({ launcher: 'auto' }, '')).toBe(false);
    expect(gateOpen({ launcher: 'auto' }, '#openparley')).toBe(true);
    expect(gateOpen({ launcher: 'auto' }, '')).toBe(true);
    expect(gateOpen({ launcher: 'auto' }, '#openparley=off')).toBe(false);
    expect(gateOpen({ launcher: 'auto' }, '')).toBe(false);
  });
});

describe('members', () => {
  const members = { launcher: 'members' as const, server: SERVER };

  test('loads nothing for ordinary visitors', () => {
    expect(gateOpen(members, '')).toBe(false);
    expect(gateOpen(members, '#pricing')).toBe(false);
  });

  test('#openparley loads it once but does not make the browser a member', () => {
    expect(gateOpen(members, '#openparley')).toBe(true);
    expect(gateOpen(members, '')).toBe(false);
  });

  test('a team thread link loads it', () => {
    expect(gateOpen(members, '#parley=t.abc123')).toBe(true);
  });

  test('loads on every visit after a sign-in, until #openparley=off', () => {
    setFlag(memberKey(SERVER), true);
    expect(gateOpen(members, '')).toBe(true);
    expect(gateOpen(members, '#openparley=off')).toBe(false);
    expect(readFlag(memberKey(SERVER))).toBe(false);
  });

  test('membership is per server and ignores trailing slashes', () => {
    setFlag(memberKey(`${SERVER}/`), true);
    expect(gateOpen(members, '')).toBe(true);
    expect(gateOpen({ launcher: 'members', server: 'https://other.example.com' }, '')).toBe(false);
  });

  test('never loads without a server', () => {
    expect(gateOpen({ launcher: 'members' }, '#openparley')).toBe(false);
  });
});
