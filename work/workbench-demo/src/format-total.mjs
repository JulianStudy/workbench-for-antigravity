/**
 * Format an integer amount in cents (分) as RMB currency string, e.g. 1250 -> "¥12.50".
 */
export function formatTotal(cents) {
  if (!Number.isInteger(cents)) {
    throw new TypeError('cents must be an integer');
  }
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = String(abs % 100).padStart(2, '0');
  return `${sign}¥${yuan}.${fen}`;
}
