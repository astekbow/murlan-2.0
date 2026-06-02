// Pluggable transactional email. The app depends only on this interface; a real
// provider (SendGrid / SES / Postmark) implements send() in production. Until
// SMTP/API credentials are configured, ConsoleEmailProvider logs the message
// (incl. the verification/reset link) so the flows are fully exercisable in dev.

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  send(email: OutboundEmail): Promise<void>;
}

/** Dev/default provider: logs the email instead of sending it. Swap for a real
 *  provider by injecting one into AuthService once credentials exist. */
export class ConsoleEmailProvider implements EmailProvider {
  async send(email: OutboundEmail): Promise<void> {
    console.log(`[email] → ${email.to} | ${email.subject}\n${email.text}\n`);
  }
}
