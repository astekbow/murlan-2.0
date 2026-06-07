// Real transactional email via Resend (https://resend.com). Used for password
// reset + email verification when RESEND_API_KEY is set (else the console stub).
//
// NOTE on the `from` address: to email ARBITRARY recipients you must verify your
// sending DOMAIN in Resend (add the DNS records they give you) and set EMAIL_FROM
// to an address on it, e.g. "Murlan <noreply@yourdomain.com>". Until then Resend's
// test sender "onboarding@resend.dev" only delivers to your OWN account email.

import type { EmailProvider, OutboundEmail } from './emailProvider.ts';

export class ResendEmailProvider implements EmailProvider {
  readonly name = 'resend';
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(email: OutboundEmail): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: email.to, subject: email.subject, text: email.text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Resend send failed (${res.status}): ${detail.slice(0, 200)}`);
    }
  }
}
