// The <script> tag entry. Deliberately tiny: it decides whether this visitor needs OpenParley
// and only then fetches the real overlay (a separate, content-hashed file next to this one).
//   <script src="https://your-sync-server/openparley.js" data-project="..." data-launcher="members" defer></script>
import { whenGateOpens, type Launcher } from './gate';

declare const __APP_FILE__: string;

const script = document.currentScript as HTMLScriptElement | null;
const data = script?.dataset ?? {};
const project = data.project || undefined;
const server = data.server || (project && script?.src ? new URL(script.src).origin : undefined);
const launcher: Launcher = data.launcher === 'auto' || data.launcher === 'members' ? data.launcher : 'always';
const shortcut = data.shortcut;
const shortcutPriority = data.shortcutPriority === 'openparley' ? 'openparley' : 'page';
const { environment, revision } = data;

const start = () => {
  if (!script?.src) {
    console.error('[openparley] Load openparley.js with a <script src> tag.');
    return;
  }
  if (launcher === 'members' && !project) {
    console.error('[openparley] data-launcher="members" needs data-project.');
    return;
  }
  const appUrl = new URL(__APP_FILE__, script.src).href;
  whenGateOpens({ launcher, server }, () => {
    import(appUrl)
      .then((app: typeof import('./index')) => app.mount({ project, server, launcher, shortcut, shortcutPriority, environment, revision }))
      .catch((error) => console.error('[openparley] Could not load the overlay.', error));
  });
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
