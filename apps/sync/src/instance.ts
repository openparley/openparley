import { createApp } from './app';
import type { Mailer } from './mail';
import type { Config } from './config';
import { openDatabase } from './db';

export interface Instance {
  app: ReturnType<typeof createApp>['app'];
  repo: ReturnType<typeof createApp>['repo'];
  notifier: ReturnType<typeof createApp>['notifier'];
  /** Notifications are waiting to go out: closing now delays them until the instance opens again. */
  hasPendingNotifications(): boolean;
  /** Releases the database. The instance must not be used afterwards. */
  close(): void;
}

/** One organization's server: its database (migrated) plus the HTTP app on top of it. */
export function openInstance(options: { config: Config; setupToken: string; mailer?: Mailer | null }): Instance {
  const db = openDatabase(options.config.databasePath);
  const { app, repo, notifier } = createApp({ db, config: options.config, setupToken: options.setupToken, mailer: options.mailer });
  repo.deleteExpiredSessions();
  notifier.start();
  return {
    app,
    repo,
    notifier,
    hasPendingNotifications: () => repo.hasPendingNotifications(),
    close: () => {
      notifier.stop();
      db.close();
    },
  };
}
