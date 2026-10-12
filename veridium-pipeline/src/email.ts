/** Sends notification emails. Off (null) until an email service is configured. */
export interface Mailer {
  send(message: { to: string; subject: string; text: string; link: string | null }): Promise<void>;
}

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

/** "Veridium <noreply@example.com>" or "noreply@example.com" → { name, email }. */
export function parseSender(from: string): { name: string; email: string } | null {
  const m = from.trim().match(/^(?:"?([^"<]*?)"?\s*<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>|([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+))$/);
  if (!m) return null;
  return { name: (m[1] ?? '').trim() || 'Veridium', email: m[2] ?? m[3] };
}

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/**
 * Brevo's transactional email API (https://developers.brevo.com/reference/sendtransacemail).
 * siteUrl turns the notification's relative link into a full one; without it the email says to log in.
 */
export class BrevoMailer implements Mailer {
  constructor(
    private apiKey: string,
    private sender: { name: string; email: string },
    private siteUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  async send({ to, subject, text, link }: { to: string; subject: string; text: string; link: string | null }) {
    const site = this.siteUrl.replace(/\/+$/, '');
    const url = site && link ? `${site}/${link.replace(/^\/+/, '')}` : null;
    const settings = site ? `${site}/login.html#email` : null;
    const footer = settings
      ? `You're getting this because email notifications are on for your Veridium account. Turn them off in Account settings: ${settings}`
      : "You're getting this because email notifications are on for your Veridium account. Turn them off in Account settings.";
    const res = await this.fetchImpl(BREVO_URL, {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: this.sender,
        to: [{ email: to }],
        subject,
        textContent: `${text}\n\n${url ? `See it on Veridium: ${url}` : 'Log in to Veridium to see it.'}\n\n--\n${footer}\n`,
        htmlContent: `<p>${escape(text)}</p>
<p>${url ? `<a href="${escape(url)}">See it on Veridium</a>` : 'Log in to Veridium to see it.'}</p>
<hr><p style="color:#666;font-size:12px">You're getting this because email notifications are on for your Veridium account.
${settings ? `<a href="${escape(settings)}">Turn them off in Account settings</a>.` : 'Turn them off in Account settings.'}</p>`,
      }),
    });
    if (!res.ok) throw new Error(`Brevo answered ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
}

/** A Brevo mailer when BREVO_API_KEY and a valid EMAIL_FROM are set; otherwise email stays off. */
export function createMailer(opts: { brevoApiKey: string; emailFrom: string; siteUrl: string }): Mailer | null {
  if (!opts.brevoApiKey || !opts.emailFrom) return null;
  const sender = parseSender(opts.emailFrom);
  if (!sender) {
    console.error('EMAIL_FROM must be an address like "Veridium <noreply@yourdomain>": email notifications are off');
    return null;
  }
  return new BrevoMailer(opts.brevoApiKey, sender, opts.siteUrl);
}
