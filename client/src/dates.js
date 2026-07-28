/**
 * The API splits when an e-mail arrived across two contract fields:
 * `date` as `28-Jul-2026` and `time` as 24-hour `13:53`. Neither sorts or
 * compares as-is, so everything here goes through an ISO day first.
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const pad = (value) => String(value).padStart(2, '0');

/** `28-Jul-2026` → `2026-07-28`, which compares as a plain string. Null if unparseable. */
export function isoDay({ date } = {}) {
  const [day, month, year] = String(date ?? '').split('-');
  const index = MONTHS.indexOf(month);
  if (index < 0 || !day || !year) return null;
  return `${year}-${pad(index + 1)}-${day}`;
}

/** Today as `YYYY-MM-DD` in local time — what an `<input type="date">` holds. */
export function todayIso() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** `date` + `time` as one Date, for display. Null when either field is off-contract. */
export function sentAt(email) {
  const day = isoDay(email);
  if (!day) return null;
  const parsed = new Date(`${day}T${email.time ?? '00:00'}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Short human form, e.g. `Jul 28, 01:53 PM`. Falls back to the raw fields. */
export function formatSentAt(email) {
  const parsed = sentAt(email);
  if (!parsed) return [email?.date, email?.time].filter(Boolean).join(' ');
  return parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** An ISO-8601 timestamp from the API (`createdAt`) in the same short form. */
export function formatTimestamp(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value ?? '') : parsed.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Keeps e-mails whose day falls in `[from, to]`; an empty bound is open. */
export function withinRange(emails, { from, to } = {}) {
  if (!from && !to) return emails;
  return emails.filter((email) => {
    const day = isoDay(email);
    if (!day) return false;
    return (!from || day >= from) && (!to || day <= to);
  });
}
