/**
 * Small, runtime-checked HTTP form contract. Express request bodies are
 * untrusted even when TypeScript's Request.body is typed as any.
 */
export class InvalidFormField extends Error {
  readonly code = 'INVALID_FORM_FIELD';
  readonly status = 400;
  constructor(readonly field: string) {
    super(`Invalid form field: ${field}`);
    this.name = 'InvalidFormField';
  }
}

function plainForm(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function rawField(body: unknown, field: string): unknown {
  const fields = plainForm(body);
  return Object.prototype.hasOwnProperty.call(fields, field) ? fields[field] : undefined;
}

/** Form inputs must be scalar strings, never arrays/objects coerced with String(). */
export function formString(body: unknown, field: string): string {
  const value = rawField(body, field);
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new InvalidFormField(field);
  return value;
}

export function formFlag(body: unknown, field: string): boolean {
  return formString(body, field) === 'true';
}

/** Handles the existing HTML select forms (a string or repeated string values). */
export function formList(body: unknown, field: string): string[] {
  const value = rawField(body, field);
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.split(/[\s,]+/).filter(Boolean);
  if (
    Array.isArray(value) &&
    value.every((part: unknown): part is string => typeof part === 'string')
  ) {
    return value.flatMap((part) => part.split(/[\s,]+/).filter(Boolean));
  }
  throw new InvalidFormField(field);
}
