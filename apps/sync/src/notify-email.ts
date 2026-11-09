import type { Mail, Mailer } from './mail';
import { truncate, type Channel, type Digest, type DigestEvent, type DigestThread } from './notify';
import type { User } from './repo';

export function emailChannel(options: { mailer: Mailer; publicUrl: string; unsubscribeToken: (userId: string) => string }): Channel {
  return {
    id: 'email',
    label: 'Email',
    defaultOn: true,
    address: (user: User) => user.email,
    async deliver(digest) {
      await options.mailer.send(notificationEmail(digest, `${options.publicUrl}/unsubscribe/${options.unsubscribeToken(digest.recipient.id)}`));
    },
  };
}

export function notificationEmail(digest: Digest, unsubscribeUrl: string): Mail {
  const { threads } = digest;
  const text = [
    ...threads.flatMap((thread, i) => [...(i > 0 ? ['', '—', ''] : []), ...threadText(thread)]),
    '',
    '--',
    'Reply in the thread: replies to this email don’t reach anyone.',
    `Choose what you get emails about: ${digest.settingsUrl}`,
    `Unsubscribe from these emails: ${unsubscribeUrl}`,
  ].join('\n');
  return {
    to: digest.recipient.email,
    subject: subject(threads),
    text,
    // One-click unsubscribe (RFC 8058): mail clients POST to the URL, no page visit needed.
    headers: { 'List-Unsubscribe': `<${unsubscribeUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

const who = (event: DigestEvent) => (event.agent ? `${event.agent} (agent for ${event.actor})` : event.actor);
const where = (thread: DigestThread) => `${thread.project} ${thread.page}`;

function subject(threads: DigestThread[]): string {
  if (threads.length > 1) {
    const projects = new Set(threads.map((t) => t.project));
    return `${threads.length} threads with news${projects.size === 1 ? ` in ${threads[0]!.project}` : ''}`;
  }
  const thread = threads[0]!;
  const mention = thread.events.find((e) => e.mention);
  if (mention) return `${who(mention)} mentioned you on ${where(thread)}`;
  if (thread.events.length > 1) return `${thread.events.length} updates on a thread on ${where(thread)}`;
  const event = thread.events[0]!;
  const did = { thread: 'started a thread', comment: 'replied', resolved: 'resolved a thread', reopened: 'reopened a thread' }[event.kind];
  return `${who(event)} ${did} on ${where(thread)}`;
}

function threadText(thread: DigestThread): string[] {
  const started = thread.events[0]?.kind === 'thread';
  return [
    `${started ? 'New thread' : 'Thread'} on ${thread.element} · ${where(thread)}${thread.status === 'resolved' ? ' · resolved' : ''}`,
    '',
    ...thread.events.map((event) => {
      if (event.body === null) return `${who(event)} ${event.kind === 'resolved' ? 'resolved' : 'reopened'} the thread.`;
      return `${who(event)}${event.mention ? ' (mentioned you)' : ''}:\n${indent(truncate(event.body, 1000))}`;
    }),
    '',
    thread.url ? `Open the thread: ${thread.url}` : 'Open the page to see the thread.',
  ];
}

const indent = (text: string) =>
  text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
