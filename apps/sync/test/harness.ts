import type { Anchor } from '@openparley/protocol';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/db';
import type { Mailer } from '../src/mail';

export const PUBLIC_URL = 'http://parley.test';
export const SITE = 'https://shop.test';
export const SETUP_TOKEN = 'setup-token';

export const anchor: Anchor = { v: 1, selector: '#buy', path: 'body > button:nth-of-type(1)', tag: 'button', text: 'Buy', attrs: { id: 'buy' }, point: [0.5, 0.5] };

export function harness(overrides: { overlayDir?: string; env?: Record<string, string>; mailer?: Mailer | null; now?: () => number } = {}) {
  const { env, mailer = null, now, ...rest } = overrides;
  const config = { ...loadConfig({ PUBLIC_URL, ...env }), overlayDir: '/nonexistent', ...rest };
  const { app, repo, notifier } = createApp({ db: openDatabase(':memory:'), config, setupToken: SETUP_TOKEN, mailer, now });

  /** A browser-like client that keeps its cookie and sends same-origin form posts. */
  function browser() {
    let cookie = '';
    const request = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (cookie) headers.set('cookie', cookie);
      if (init.method === 'POST' && !headers.has('origin')) headers.set('origin', PUBLIC_URL);
      const res = await app.request(`${PUBLIC_URL}${path}`, { ...init, headers, redirect: 'manual' });
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.includes('Max-Age=0') ? '' : set.split(';')[0]!;
      return res;
    };
    const post = (path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
      request(path, { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
    /** Runs the overlay's sign-in popup flow and returns the API token it hands to the site. */
    const connect = async (project: string, origin = SITE) => {
      const res = await request(`/connect?project=${project}&origin=${encodeURIComponent(origin)}`);
      const html = await res.text();
      const token = /"token":"([^"]+)"/.exec(html)?.[1];
      if (!token) throw new Error(`No token in connect page (${res.status}): ${html.slice(0, 200)}`);
      return token;
    };
    return { request, post, connect };
  }

  function api(token: string | null, origin: string | null = SITE) {
    return (method: string, path: string, body?: unknown) => {
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (origin) headers.origin = origin;
      if (body !== undefined) headers['content-type'] = 'application/json';
      return app.request(`${PUBLIC_URL}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    };
  }

  async function owner() {
    const b = browser();
    await b.post('/setup', { token: SETUP_TOKEN, name: 'Olivia Owner', email: 'olivia@example.com', password: 'correct horse battery' });
    await b.post('/admin/projects', { name: 'Shop', origins: SITE });
    const project = repo.listProjects()[0]!;
    return { b, project, call: api(await b.connect(project.id)) };
  }

  async function invited(by: ReturnType<typeof browser>, role: 'member' | 'admin', email: string) {
    const page = await (await by.post('/admin/invites', { role })).text();
    const link = /\/invite\/([A-Za-z0-9_-]+)/.exec(page)![1]!;
    const b = browser();
    await b.post(`/invite/${link}`, { name: email.split('@')[0]!, email, password: 'another long password' });
    return { b, link };
  }

  return { app, repo, notifier, browser, api, owner, invited };
}
