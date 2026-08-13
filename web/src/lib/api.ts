/**
 * The one place that talks to the API.
 *
 * Three jobs, and nothing else in the app should have to think about any of
 * them:
 *
 *  1. Attach the access token. It lives in memory only — never localStorage,
 *     which any XSS payload can read. Losing it on refresh is fine, because
 *     the httpOnly refresh cookie can mint a new one.
 *
 *  2. Send credentials. The API is on a different origin (app.<domain> calling
 *     api.<domain>), so `credentials: 'include'` is required or the browser
 *     silently omits the refresh cookie and staying signed in stops working.
 *
 *  3. Refresh once on a 401, then retry. Concurrent 401s share a single refresh
 *     rather than each firing their own — the API rotates refresh tokens and
 *     treats a reused one as theft, revoking the whole session. Two parallel
 *     refreshes would log the user out.
 */

export const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

if (!API_URL && import.meta.env.PROD) {
  // Better a loud failure at startup than every request quietly hitting the
  // app's own origin and 404ing.
  throw new Error('VITE_API_URL is not set. The app cannot reach the API.');
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    fields?: { path: string; message: string }[];
    details?: unknown;
  };
}

/**
 * Thrown for any non-2xx. Carries enough to render a form error properly.
 *
 * Fields are declared and assigned rather than written as constructor
 * parameter properties, because the Vite template enables
 * `erasableSyntaxOnly` — TypeScript-only syntax that emits runtime code is
 * rejected so the file can be stripped to plain JS by esbuild.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fields?: { path: string; message: string }[];

  constructor(
    status: number,
    code: string,
    message: string,
    fields?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.fields = fields;
  }

  /// Field errors keyed by input name, for rendering under the input.
  get fieldErrors(): Record<string, string> {
    const map: Record<string, string> = {};
    for (const field of this.fields ?? []) {
      // Zod paths are dotted ("business.gstin"); the last segment is the input.
      const key = field.path || 'form';
      if (!(key in map)) map[key] = field.message;
    }
    return map;
  }

  /// True when retrying could plausibly work — used to decide whether to offer
  /// a retry button or just report the problem.
  get isTransient(): boolean {
    return this.status >= 500 || this.status === 429 || this.status === 0;
  }
}

// ---------------------------------------------------------------------------
// Access token, held in memory
// ---------------------------------------------------------------------------

let accessToken: string | null = null;
let onAuthLost: (() => void) | null = null;

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};
export const getAccessToken = () => accessToken;

/// Called when refreshing fails, so the app can drop to the login screen.
export const setAuthLostHandler = (handler: (() => void) | null) => {
  onAuthLost = handler;
};

// ---------------------------------------------------------------------------
// Refresh, shared between concurrent callers
// ---------------------------------------------------------------------------

let refreshInFlight: Promise<boolean> | null = null;

/**
 * Exchanges the refresh cookie for a new access token.
 *
 * Deduplicated: if three requests 401 at once they await the same promise. The
 * API rotates the refresh token on every use and revokes the session if an old
 * one reappears, so firing three refreshes would look exactly like a stolen
 * token being replayed.
 */
export function refreshSession(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) return false;

      const body = (await response.json()) as { accessToken?: string };
      if (!body.accessToken) return false;

      setAccessToken(body.accessToken);
      return true;
    } catch {
      // Network failure, not an auth failure — treated the same by the caller,
      // which will surface it as "could not reach the server".
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

// ---------------------------------------------------------------------------
// The request itself
// ---------------------------------------------------------------------------

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /// Query parameters. Undefined and empty-string values are dropped so
  /// callers can pass optional filters straight through.
  query?: Record<string, string | number | boolean | undefined | null>;
  signal?: AbortSignal;
  /// Skip the refresh-and-retry dance. Used by the auth calls themselves.
  skipRefresh?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const url = new URL(`${API_URL}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function toApiError(response: Response): Promise<ApiError> {
  let body: Partial<ApiErrorBody> = {};
  try {
    body = (await response.json()) as ApiErrorBody;
  } catch {
    // A non-JSON error body (a proxy's HTML 502 page, say).
  }

  const error = body.error;
  return new ApiError(
    response.status,
    error?.code ?? 'UNKNOWN',
    error?.message ?? `Request failed (${response.status})`,
    error?.fields,
  );
}

async function send(path: string, options: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  return fetch(buildUrl(path, options.query), {
    method: options.method ?? 'GET',
    headers,
    credentials: 'include',
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

/** Makes a request and parses the JSON. Throws `ApiError` on any non-2xx. */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;

  try {
    response = await send(path, options);
  } catch (cause) {
    // fetch only rejects for network-level failures — server down, DNS, or a
    // CORS rejection. Status 0 marks it as worth retrying.
    if ((cause as Error)?.name === 'AbortError') throw cause;
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server. Check your connection.');
  }

  if (response.status === 401 && !options.skipRefresh) {
    const refreshed = await refreshSession();
    if (refreshed) {
      response = await send(path, options);
    } else {
      setAccessToken(null);
      onAuthLost?.();
      throw await toApiError(response);
    }
  }

  if (!response.ok) throw await toApiError(response);

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

/**
 * Fetches a binary body — the invoice PDF.
 *
 * Separate from `request` because the response is not JSON and the caller
 * wants the filename the server chose, which arrives in Content-Disposition.
 */
export async function requestBlob(
  path: string,
  options: RequestOptions = {},
): Promise<{ blob: Blob; filename: string }> {
  let response = await send(path, options);

  if (response.status === 401 && !options.skipRefresh) {
    if (await refreshSession()) response = await send(path, options);
    else {
      setAccessToken(null);
      onAuthLost?.();
    }
  }

  if (!response.ok) throw await toApiError(response);

  const disposition = response.headers.get('content-disposition') ?? '';
  const match = /filename="([^"]+)"/.exec(disposition);

  return { blob: await response.blob(), filename: match?.[1] ?? 'download.pdf' };
}

export const api = {
  get: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'GET' }),
  post: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'PATCH', body }),
  delete: <T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>) =>
    request<T>(path, { ...options, method: 'DELETE' }),
};
