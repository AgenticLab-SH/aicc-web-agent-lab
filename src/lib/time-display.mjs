const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

export function formatKstTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw new Error('invalid_display_timestamp');
  const date = new Date(timestamp + KST_OFFSET_MS);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} KST`;
}
