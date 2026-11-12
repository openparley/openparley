import logo from '@openparley/brand/icon.svg' with { type: 'text' };
import wordmark from '@openparley/brand/logo-dark.svg' with { type: 'text' };
import { plural } from './format';
import { Icon } from './icons';
import { KEYS, Kbd, withKey } from './keys';

export interface LauncherProps {
  active: boolean;
  openCount: number;
  listOpen: boolean;
  picking: boolean;
  /** What the primary action does in the current state. */
  primary: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    /** Keyboard shortcut: shown on the button, in the tooltip and to screen readers. */
    key?: { label: string; aria: string };
  } | null;
  onActivate: () => void;
  onDeactivate: () => void;
  onToggleList: () => void;
  onSignOut: (() => void) | null;
}

export function Launcher(props: LauncherProps) {
  if (!props.active) {
    return (
      <div class="launcher">
        <button
          type="button"
          class="icon-btn launcher-open"
          aria-label={`Show threads (${plural(props.openCount, 'open thread')})`}
          title="Threads"
          onClick={props.onActivate}
        >
          {/* Our own static asset, inlined so the host page's CSP can't block it. */}
          <span class="launcher-logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: logo }} />
          {props.openCount > 0 && <span class="badge">{props.openCount > 99 ? '99+' : props.openCount}</span>}
        </button>
      </div>
    );
  }

  return (
    <div class="launcher" role="toolbar" aria-label="OpenParley">
      <span class="launcher-wordmark" aria-hidden="true" dangerouslySetInnerHTML={{ __html: wordmark }} />
      {props.primary && (
        <button
          type="button"
          class="btn"
          data-tone="primary"
          aria-pressed={props.picking}
          disabled={props.primary.disabled}
          aria-keyshortcuts={props.primary.key?.aria}
          title={props.primary.key ? `${props.primary.label} (${props.primary.key.label})` : undefined}
          onClick={props.primary.onClick}
        >
          {!props.picking && <Icon name="plus" />}
          {props.primary.label}
          {props.primary.key && <Kbd label={props.primary.key.label} />}
        </button>
      )}
      <button
        type="button"
        class="btn launcher-list"
        aria-pressed={props.listOpen}
        aria-label={`List threads (${plural(props.openCount, 'open thread')})`}
        title="All threads"
        onClick={props.onToggleList}
      >
        <Icon name="list" />
        View all
        <span class="launcher-count">{props.openCount}</span>
      </button>
      {props.onSignOut && (
        <button type="button" class="icon-btn" aria-label="Sign out" title="Sign out" onClick={props.onSignOut}>
          <Icon name="logout" />
        </button>
      )}
      <button
        type="button"
        class="icon-btn"
        aria-label="Hide threads"
        title={withKey('Hide threads', 'escape')}
        aria-keyshortcuts={KEYS.escape.aria}
        onClick={props.onDeactivate}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}
