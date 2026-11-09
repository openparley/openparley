import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { BRAND_FILES } from '@openparley/brand';
import { Hono, type Context } from 'hono';
import { getConnInfo } from 'hono/bun';
import { HTTPException } from 'hono/http-exception';
import { apiRoutes } from './api';
import type { Config } from './config';
import { logMailer, resendMailer, type Mailer } from './mail';
import { mcpRoutes } from './mcp';
import { Notifier, type Channel } from './notify';
import { emailChannel } from './notify-email';
import { authorizeRoutes, oauthRoutes } from './oauth';
import { Repo } from './repo';
import { unsubscribeRoutes, webRoutes } from './web';

export interface AppOptions {
  db: Database;
  config: Config;
  setupToken: string;
  /** Sends invite emails. Defaults to Resend when `config.mail` is set; null means no email. */
  mailer?: Mailer | null;
  /** Where notifications go. Defaults to email through `mailer` when there is one. */
  channels?: Channel[];
  /** The notifier's clock (tests). */
  now?: () => number;
}

export function createApp({ db, config, setupToken, mailer = config.mail ? resendMailer(config.mail) : config.mailLog ? logMailer : null, channels, now }: AppOptions) {
  const repo = new Repo(db);
  const app = new Hono();
  const notifier = new Notifier({
    repo,
    publicUrl: config.publicUrl,
    quietMs: config.notifyQuietMs,
    now,
    channels: channels ?? (mailer ? [emailChannel({ mailer, publicUrl: config.publicUrl, unsubscribeToken: (id) => repo.unsubscribeToken(id) })] : []),
  });

  const clientIp = (c: Context): string => {
    if (config.trustProxy) {
      const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (forwarded) return forwarded;
    }
    try {
      return getConnInfo(c).remote.address ?? 'unknown';
    } catch {
      return 'unknown';
    }
  };

  app.get('/health', (c) => c.json({ ok: true }));

  // The overlay is served from here so self-hosters embed a single URL. The loader keeps a short
  // cache so releases roll out quickly; the app file name contains its content hash, so it's immutable.
  const serveOverlay = async (c: Context, file: string, cacheControl: string) => {
    const asset = Bun.file(join(config.overlayDir, file));
    if (!(await asset.exists())) return c.text('Overlay not built. Run `bun run build` in the repository root.', 404);
    return c.body(await asset.arrayBuffer(), 200, {
      'content-type': file.endsWith('.map') ? 'application/json' : file.endsWith('.woff2') ? 'font/woff2' : 'text/javascript; charset=utf-8',
      'cache-control': cacheControl,
      'access-control-allow-origin': '*',
    });
  };
  app.get('/openparley.js', (c) => serveOverlay(c, 'openparley.js', 'public, max-age=300'));
  app.get('/openparley.js.map', (c) => serveOverlay(c, 'openparley.js.map', 'public, max-age=300'));
  app.get('/:file{openparley-app-[a-z0-9]+\\.js(?:\\.map)?}', (c) =>
    serveOverlay(c, c.req.param('file'), 'public, max-age=31536000, immutable'),
  );
  app.get('/:file{openparley-font-[a-z0-9-]+\\.woff2}', (c) => serveOverlay(c, c.req.param('file'), 'public, max-age=31536000, immutable'));

  // Logos and fonts for the server's own pages.
  app.get('/brand/:file', async (c) => {
    const path = BRAND_FILES[c.req.param('file')];
    if (!path) return c.notFound();
    const file = Bun.file(path);
    return c.body(await file.arrayBuffer(), 200, { 'content-type': file.type, 'cache-control': 'public, max-age=86400' });
  });
  app.get('/favicon.ico', (c) => c.redirect('/brand/icon.svg', 301));

  // CORS: only origins registered on a project may call the API from a browser.
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    const allowed = !!origin && repo.originAllowed(origin);
    if (c.req.method === 'OPTIONS') {
      if (!allowed) return c.body(null, 403, { vary: 'Origin' });
      return c.body(null, 204, {
        'access-control-allow-origin': origin,
        'access-control-allow-methods': 'GET, POST, PATCH, DELETE',
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-max-age': '600',
        vary: 'Origin',
      });
    }
    await next();
    c.res.headers.append('vary', 'Origin');
    if (allowed) c.res.headers.set('access-control-allow-origin', origin);
  });

  app.route('/api', apiRoutes(repo, config.limits, notifier));
  app.route('/', oauthRoutes({ repo, config, clientIp }));
  app.route('/mcp', mcpRoutes(repo, config, notifier));
  // Outside the web routes' CSRF check: mail clients post one-click unsubscribes from anywhere; the token is the credential.
  app.route('/unsubscribe', unsubscribeRoutes(repo));
  app.route('/', webRoutes({ repo, config, setupToken, clientIp, mailer, notifier, authorize: authorizeRoutes({ repo, config }) }));

  app.onError((error, c) => {
    if (error instanceof HTTPException) return error.getResponse();
    console.error(error);
    return c.req.path.startsWith('/api/') ? c.json({ error: 'Something went wrong on the server.' }, 500) : c.text('Something went wrong.', 500);
  });

  return { app, repo, notifier };
}
