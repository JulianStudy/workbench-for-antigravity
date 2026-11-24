/**
 * Trim leading and trailing whitespace from a label string.
 */
export function cleanLabel(value) {
  if (typeof value !== 'string') {
    throw new TypeError('label must be a string');
  }
  return value.trim();
}
