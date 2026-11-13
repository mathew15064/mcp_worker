/**
 * Convert external scalar values to strings without invoking an untrusted
 * object's custom toString method. Object fallbacks use the built-in tag,
 * matching the common "[object Object]" result without executing app code.
 */
export function stringifyUnknown(value: unknown): string {
  const seen = new WeakSet<object>();
  const convert = (item: unknown): string => {
    if (typeof item === 'string') return item;
    if (item === null || item === undefined) return String(item);
    if (
      typeof item === 'number' ||
      typeof item === 'boolean' ||
      typeof item === 'bigint' ||
      typeof item === 'symbol'
    )
      return String(item);
    if (item instanceof Date) return Date.prototype.toString.call(item);
    if (Array.isArray(item)) {
      if (seen.has(item)) return '';
      seen.add(item);
      const text = item
        .map((child: unknown) => (child === null || child === undefined ? '' : convert(child)))
        .join(',');
      seen.delete(item);
      return text;
    }
    return Object.prototype.toString.call(item);
  };
  return convert(value);
}
