export interface RouteError {
  code?: string;
  status?: number;
  message: string;
}

/** Untrusted thrown values cannot inject objects into the view or HTTP status. */
export function routeError(value: unknown): RouteError {
  if (value instanceof Error) {
    const fields = value as Error & { code?: unknown; status?: unknown };
    return {
      code: typeof fields.code === 'string' ? fields.code : undefined,
      status: validStatus(fields.status),
      message: value.message || 'Request failed',
    };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const fields = value as Record<string, unknown>;
    return {
      code: typeof fields.code === 'string' ? fields.code : undefined,
      status: validStatus(fields.status),
      message:
        typeof fields.message === 'string' && fields.message ? fields.message : 'Request failed',
    };
  }
  return { message: 'Request failed' };
}

function validStatus(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599
    ? value
    : undefined;
}
