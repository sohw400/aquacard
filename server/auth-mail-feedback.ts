import { createHash } from 'node:crypto';
import type { Database } from './database';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const feedbackId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
function invalid(): never { throw new Error('INVALID_MAIL_FEEDBACK'); }
function only(value: unknown): unknown {
  if (!Array.isArray(value) || value.length !== 1) invalid();
  return value[0];
}
function normalizedAddress(value: unknown) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value)
    || /[\p{Cc}\p{Cf}]/u.test(value)) invalid();
  return value.toLowerCase();
}

export function parseAuthMailFeedback(input: unknown) {
  if (!object(input) || !object(input.mail) || !object(input.mail.tags)) invalid();
  const mailId = only(input.mail.tags['aqua-message']);
  if (typeof mailId !== 'string' || !uuid.test(mailId)) invalid();
  const destination = normalizedAddress(only(input.mail.destination));
  let eventId: unknown;
  let recipient: unknown;
  let kind: 'permanent_bounce' | 'transient_bounce' | 'complaint' | 'not_spam';
  if (input.eventType === 'Bounce' && object(input.bounce)) {
    if (input.bounce.bounceType !== 'Permanent' && input.bounce.bounceType !== 'Transient') invalid();
    kind = input.bounce.bounceType === 'Permanent' ? 'permanent_bounce' : 'transient_bounce';
    eventId = input.bounce.feedbackId;
    recipient = only(input.bounce.bouncedRecipients);
  } else if (input.eventType === 'Complaint' && object(input.complaint)) {
    const feedback = input.complaint.complaintFeedbackType;
    if (feedback !== undefined && (typeof feedback !== 'string' ||
      !['abuse', 'auth-failure', 'fraud', 'not-spam', 'other', 'virus'].includes(feedback))) invalid();
    kind = feedback === 'not-spam' ? 'not_spam' : 'complaint';
    eventId = input.complaint.feedbackId;
    recipient = only(input.complaint.complainedRecipients);
  } else return invalid();
  if (typeof eventId !== 'string' || !feedbackId.test(eventId) || !object(recipient)
    || normalizedAddress(recipient.emailAddress) !== destination) invalid();
  return { eventId, mailId, recipientHash: createHash('sha256').update(destination).digest('hex'), kind };
}

export async function recordAuthMailFeedback(db: Database, event: ReturnType<typeof parseAuthMailFeedback>, now = Date.now()) {
  if (process.env.NODE_ENV === 'production' || process.env.AQUA_AUTH_MAIL_FEEDBACK_MODE !== 'sandbox') {
    throw new Error('MAIL_FEEDBACK_DISABLED');
  }
  try {
    const { rows } = await db.query('SELECT record_auth_mail_feedback($1::jsonb,$2::bigint) AS result', [JSON.stringify(event),now]);
    return rows[0].result as { kind: typeof event.kind; receivedAt: number; suppressionEvent: boolean };
  } catch (error) {
    if (error instanceof Error && ['MAIL_FEEDBACK_UNMATCHED','MAIL_FEEDBACK_CONFLICT','INVALID_MAIL_FEEDBACK'].includes(error.message)) throw new Error(error.message);
    throw new Error('MAIL_FEEDBACK_UNAVAILABLE');
  }
}
