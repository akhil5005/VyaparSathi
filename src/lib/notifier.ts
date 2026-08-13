import { env, isProduction } from '../config/env.js';
import { logger } from './logger.js';

/**
 * Getting a message to a person.
 *
 * Deliberately an interface with a swappable implementation, because delivery
 * in India is not a solved problem you can just wire up:
 *
 *  - **SMS** requires DLT registration under the TRAI mandate — the sender ID
 *    and every message template must be registered with a telecom operator,
 *    which takes days and needs a registered business entity.
 *  - **WhatsApp** via the Cloud API requires Meta business verification and
 *    template approval.
 *  - **Email** works today, but only to addresses the provider will accept:
 *    Resend needs a verified sending domain before it will deliver to
 *    arbitrary recipients.
 *
 * So the shape here is: try to send, and be honest when you cannot. A reset
 * that silently goes nowhere is worse than one that says so, because the
 * person keeps waiting for a message that will never arrive.
 */

export interface PasswordResetMessage {
  /// Email address or phone number, depending on how the account was found.
  to: string;
  channel: 'email' | 'sms';
  recipientName: string;
  /// The one-time link. Treat as a credential — it grants a password change.
  resetUrl: string;
  expiresInMinutes: number;
}

export interface DeliveryResult {
  delivered: boolean;
  /// Which implementation handled it, for the log and the audit trail.
  via: string;
  /// Set when delivery failed. Never shown to the requester — that would leak
  /// whether the account exists.
  reason?: string;
}

export interface Notifier {
  readonly name: string;
  sendPasswordReset(message: PasswordResetMessage): Promise<DeliveryResult>;
}

// ---------------------------------------------------------------------------
// Resend — email
// ---------------------------------------------------------------------------

/**
 * Plain `fetch` rather than the SDK: one endpoint, one JSON body, and a
 * dependency avoided.
 */
class ResendNotifier implements Notifier {
  readonly name = 'resend';

  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async sendPasswordReset(message: PasswordResetMessage): Promise<DeliveryResult> {
    if (message.channel !== 'email') {
      return {
        delivered: false,
        via: this.name,
        reason: 'Account has no email address; email delivery cannot reach it',
      };
    }

    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.from,
          to: [message.to],
          subject: 'Reset your Vyapar Sathi password',
          text: passwordResetText(message),
          html: passwordResetHtml(message),
        }),
        // A password reset that hangs holds an HTTP worker open; fail instead.
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        return {
          delivered: false,
          via: this.name,
          reason: `Resend returned ${response.status}: ${body.slice(0, 200)}`,
        };
      }

      return { delivered: true, via: this.name };
    } catch (error) {
      return { delivered: false, via: this.name, reason: (error as Error).message };
    }
  }
}

// ---------------------------------------------------------------------------
// Console — development only
// ---------------------------------------------------------------------------

/**
 * Writes the link to the server log.
 *
 * Fine in development, where the developer is reading that log. In production
 * it means nobody receives anything, so it says so loudly at every use rather
 * than quietly pretending to work.
 */
class ConsoleNotifier implements Notifier {
  readonly name = 'console';

  async sendPasswordReset(message: PasswordResetMessage): Promise<DeliveryResult> {
    if (isProduction) {
      logger.error(
        { to: message.to, channel: message.channel },
        'PASSWORD RESET NOT DELIVERED — no notifier configured in production. ' +
          'The link was not sent anywhere. Set RESEND_API_KEY and MAIL_FROM, or have ' +
          'the owner set the password from Settings → Staff.',
      );
      return {
        delivered: false,
        via: this.name,
        reason: 'No delivery channel configured',
      };
    }

    logger.info(
      { resetUrl: message.resetUrl, to: message.to },
      'Password reset link (development only — not sent anywhere)',
    );
    return { delivered: true, via: this.name };
  }
}

// ---------------------------------------------------------------------------

function passwordResetText(m: PasswordResetMessage): string {
  return [
    `Hello ${m.recipientName},`,
    '',
    'Someone asked to reset the password for your Vyapar Sathi account.',
    'Open this link to choose a new one:',
    '',
    m.resetUrl,
    '',
    `The link stops working in ${m.expiresInMinutes} minutes, and can only be used once.`,
    '',
    'If this was not you, ignore this message — nothing has changed, and your',
    'current password still works.',
  ].join('\n');
}

function passwordResetHtml(m: PasswordResetMessage): string {
  // Deliberately plain. Every mail client renders this the same way, and a
  // password reset is not the place for a layout that might break.
  return `<!doctype html>
<html><body style="font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; line-height: 1.6; color: #0f172a;">
  <p>Hello ${escapeHtml(m.recipientName)},</p>
  <p>Someone asked to reset the password for your Vyapar Sathi account.</p>
  <p>
    <a href="${escapeHtml(m.resetUrl)}"
       style="display:inline-block;background:#0f172a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;">
      Choose a new password
    </a>
  </p>
  <p style="color:#475569;font-size:14px;">
    The link stops working in ${m.expiresInMinutes} minutes and can only be used once.
  </p>
  <p style="color:#475569;font-size:14px;">
    If this was not you, ignore this message — nothing has changed and your current
    password still works.
  </p>
  <p style="color:#94a3b8;font-size:12px;word-break:break-all;">${escapeHtml(m.resetUrl)}</p>
</body></html>`;
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/**
 * The notifier this deployment uses, chosen once at startup.
 *
 * Adding SMS or WhatsApp later means another class here and one more branch —
 * nothing that calls this needs to change.
 */
export const notifier: Notifier =
  env.RESEND_API_KEY && env.MAIL_FROM
    ? new ResendNotifier(env.RESEND_API_KEY, env.MAIL_FROM)
    : new ConsoleNotifier();

if (isProduction && notifier.name === 'console') {
  logger.warn(
    'No notifier configured. Password reset emails will NOT be delivered. ' +
      'Set RESEND_API_KEY and MAIL_FROM, or rely on the owner setting staff ' +
      'passwords from Settings → Staff.',
  );
}
