import type { UiState } from '@/types';

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function loadUiState(view: string): Promise<UiState> {
  const response = await fetch('/api/ui/state?view=' + encodeURIComponent(view), {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : 'Unable to load this page.';
    throw new ApiError(error, response.status);
  }
  return payload as UiState;
}

export function toParams(input: FormData | Record<string, string | boolean | number | undefined>) {
  const params = new URLSearchParams();
  if (input instanceof FormData) {
    for (const [name, value] of input.entries())
      if (typeof value === 'string') params.append(name, value);
  } else {
    for (const [name, value] of Object.entries(input)) {
      if (typeof value === 'boolean') {
        if (value) params.append(name, 'true');
      } else if (value !== undefined && value !== '') params.append(name, String(value));
    }
  }
  return params;
}

export async function postAction(
  path: string,
  input: FormData | Record<string, string | boolean | number | undefined>,
  csrfToken: string,
): Promise<string> {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\'))
    throw new Error('Invalid action path.');
  const params = toParams(input);
  params.set('_csrf', csrfToken);
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    redirect: 'follow',
    headers: { 'content-type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
    body: params,
  });
  if (!response.ok)
    throw new ApiError('Action failed (HTTP ' + response.status + ').', response.status);
  const location = new URL(response.url);
  if (location.origin !== window.location.origin)
    throw new Error('Unexpected cross-origin action redirect.');
  return location.pathname + location.search;
}

export async function postAuth(
  path: '/login' | '/register',
  input: Record<string, string>,
  csrfToken: string,
) {
  const body = toParams(input);
  body.set('_csrf', csrfToken);
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = (await response.json()) as { redirectTo?: string; error?: string };
  if (!response.ok) throw new ApiError(json.error || 'Authentication failed.', response.status);
  if (!json.redirectTo?.startsWith('/') || json.redirectTo.startsWith('//'))
    throw new Error('Invalid authentication redirect.');
  return json.redirectTo;
}
