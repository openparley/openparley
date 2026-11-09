import { LIMITS, type Member } from '@openparley/protocol';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import { avatarStyle, initial } from './format';
import { Icon } from './icons';
import { KEYS, Kbd } from './keys';

export interface ComposerProps {
  placeholder: string;
  submitLabel: string;
  /** When set, the user must enter a display name first (local mode). */
  askName: boolean;
  autoFocus?: boolean;
  onSubmit: (body: string, name: string) => Promise<void>;
  /** Shows a Cancel button; Esc does the same. */
  onCancel?: () => void;
  /** What Esc does when there is no Cancel button (e.g. close the thread). */
  onEscape?: () => void;
  /** Team mode: people to suggest after `@`. A mention is plain `@handle` text; the server resolves it. */
  members?: () => Promise<Member[]>;
}

export function Composer(props: ComposerProps) {
  const [body, setBody] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [people, setPeople] = useState<Member[]>([]);
  /** What's typed after `@` up to the caret, while suggesting. */
  const [query, setQuery] = useState<string | null>(null);
  const [pick, setPick] = useState(0);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  // The autofocus attribute is unreliable inside a shadow root, so focus explicitly.
  // preventScroll: the card is position: fixed, focusing must not scroll the page.
  useLayoutEffect(() => {
    if (props.autoFocus) (props.askName ? nameRef.current : textRef.current)?.focus({ preventScroll: true });
  }, []);

  const trimmed = body.trim();
  const ready = trimmed.length > 0 && (!props.askName || name.trim().length > 0) && !busy;

  const submit = async () => {
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(trimmed, name.trim());
      setBody('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save. Try again.');
    } finally {
      setBusy(false);
      textRef.current?.focus({ preventScroll: true });
    }
  };

  const escape = props.onCancel ?? props.onEscape;
  // Like Slack: the start of the mention name or of any word of the name.
  const q = query?.toLowerCase() ?? '';
  const matches = query === null ? [] : people.filter((p) => p.handle.startsWith(q) || ` ${p.name.toLowerCase()}`.includes(` ${q}`)).slice(0, 6);

  const suggest = (typed: string | null) => {
    setQuery(typed);
    setPick(0);
    if (typed !== null && !people.length) props.members!().then(setPeople, () => {});
  };

  /** Replaces what's typed after the `@` before the caret. */
  const insert = (text: string, from: number) => {
    const el = textRef.current!;
    const caret = el.selectionStart;
    el.value = `${el.value.slice(0, from)}${text}${el.value.slice(caret)}`;
    el.setSelectionRange(from + text.length, from + text.length);
    el.focus({ preventScroll: true });
    setBody(el.value);
  };

  const mention = (person: Member) => {
    insert(`@${person.handle} `, textRef.current!.value.lastIndexOf('@', textRef.current!.selectionStart - 1));
    setQuery(null);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const key = event.key;
    if (matches.length && (key.startsWith('Arrow') || key === 'Tab' || key === 'Escape' || (key === 'Enter' && !event.metaKey && !event.ctrlKey))) {
      if (key === 'ArrowLeft' || key === 'ArrowRight') return setQuery(null);
      event.preventDefault();
      event.stopPropagation();
      if (key === 'Escape') setQuery(null);
      else if (key.startsWith('Arrow')) setPick((pick + (key === 'ArrowDown' ? 1 : matches.length - 1)) % matches.length);
      else mention(matches[pick]!);
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    } else if (event.key === 'Escape' && escape) {
      event.preventDefault();
      event.stopPropagation();
      escape();
    }
  };

  return (
    <form
      class="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {props.askName && (
        <input
          ref={nameRef}
          class="field"
          placeholder="Your name"
          aria-label="Your name"
          maxLength={LIMITS.authorName}
          value={name}
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              textRef.current?.focus({ preventScroll: true });
            } else onKeyDown(event);
          }}
        />
      )}
      <textarea
        ref={textRef}
        class="field"
        placeholder={props.placeholder}
        aria-label={props.placeholder}
        maxLength={LIMITS.commentBody}
        value={body}
        onInput={(e) => {
          const el = e.currentTarget;
          setBody(el.value);
          const typed = props.members && /(?:^|[\s(])@([\w.-]{0,30})$/.exec(el.value.slice(0, el.selectionStart));
          suggest(typed ? typed[1]! : null);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setQuery(null)}
      />
      {matches.length > 0 && (
        <ul class="mentions" role="listbox" aria-label="Mention someone">
          {matches.map((person, i) => (
            <li
              role="option"
              aria-selected={i === pick}
              onMouseDown={(event) => {
                event.preventDefault();
                mention(person);
              }}
            >
              <span class="avatar" style={avatarStyle(person.id)} aria-hidden="true">
                {initial(person.name)}
              </span>
              {person.name}
              <span class="mention-handle">@{person.handle}</span>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div class="composer-foot">
        {props.members && (
          <button
            type="button"
            class="icon-btn"
            title="Mention someone"
            aria-label="Mention someone"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const el = textRef.current!;
              const before = el.value.slice(0, el.selectionStart);
              insert(before && !/\s$/.test(before) ? ' @' : '@', el.selectionStart);
              suggest('');
            }}
          >
            <Icon name="at" />
          </button>
        )}
        <span class="composer-hint">{body.length > LIMITS.commentBody - 200 ? `${LIMITS.commentBody - body.length} left` : ''}</span>
        {props.onCancel && (
          <button type="button" class="btn" aria-keyshortcuts={KEYS.escape.aria} onClick={props.onCancel}>
            Cancel <Kbd name="escape" />
          </button>
        )}
        <button type="submit" class="btn" data-tone="primary" disabled={!ready} aria-keyshortcuts={KEYS.submit.aria}>
          {busy ? 'Saving…' : props.submitLabel} <Kbd name="submit" />
        </button>
      </div>
    </form>
  );
}
