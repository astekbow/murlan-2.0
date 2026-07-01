// Pluggable transactional email. The app depends only on this interface; a real
// provider (SendGrid / SES / Postmark) implements send() in production. Until
// SMTP/API credentials are configured, ConsoleEmailProvider logs the message
// (incl. the verification/reset link) so the flows are fully exercisable in dev.

import { log } from '../logger.ts';

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

export interface EmailProvider {
  readonly name: string; // 'console' = stub; a real provider reports e.g. 'smtp'/'ses'
  send(email: OutboundEmail): Promise<void>;
}

/** Dev/default provider: logs the email instead of sending it. Swap for a real
 *  provider by injecting one into AuthService once credentials exist. */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = 'console';
  async send(email: OutboundEmail): Promise<void> {
    log.info(`[email] → ${email.to} | ${email.subject}\n${email.text}\n`);
  }
}
