export interface Mail {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
  /** Extra headers, e.g. List-Unsubscribe. */
  headers?: Record<string, string>;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export interface MailConfig {
  resendApiKey: string;
  from: string;
}

/** Development: the mail goes to the log, links included. */
export const logMailer: Mailer = {
  async send(mail) {
    console.log(`[mail] to ${mail.to}: ${mail.subject}\n${mail.text}`);
  },
};

export function resendMailer(config: MailConfig, fetchFn: typeof fetch = fetch): Mailer {
  return {
    async send(mail) {
      const res = await fetchFn('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${config.resendApiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: config.from,
          to: [mail.to],
          subject: mail.subject,
          text: mail.text,
          ...(mail.replyTo && { reply_to: mail.replyTo }),
          ...(mail.headers && { headers: mail.headers }),
        }),
      });
      if (!res.ok) throw new Error(`Sending mail failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    },
  };
}
