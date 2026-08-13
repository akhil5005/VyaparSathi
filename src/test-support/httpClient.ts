import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp, type AppOptions } from '../app.js';

/**
 * Drives the real Express app over real HTTP.
 *
 * Deliberately a genuine `http.Server` on an ephemeral port and the built-in
 * `fetch`, not supertest or an in-process shim. The whole point of these tests
 * is the layer supertest papers over: status codes, `Content-Type` and
 * `Content-Disposition` headers, `Set-Cookie` on the refresh token, binary
 * response bodies, and JSON parsing of a request the client actually encoded.
 * A shim that calls the handler directly proves none of that.
 *
 * No new dependency either — `fetch` is built into Node 22.
 */

export interface TestResponse<T = any> {
  status: number;
  headers: Headers;
  body: T;
  /// Populated instead of `body` when the response isn't JSON (e.g. a PDF).
  buffer?: Buffer;
}

export class TestClient {
  private constructor(
    private readonly server: http.Server,
    readonly baseUrl: string,
  ) {}

  private accessToken?: string;
  /// Captured from Set-Cookie so refresh-token rotation can be exercised the
  /// way a browser would do it.
  private cookies = new Map<string, string>();

  static async start(options: AppOptions = {}): Promise<TestClient> {
    const app = createApp({ enableRateLimit: false, enableRequestLogging: false, ...options });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return new TestClient(server, `http://127.0.0.1:${port}`);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /// Subsequent requests carry this bearer token.
  authenticateAs(accessToken: string | undefined): this {
    this.accessToken = accessToken;
    return this;
  }

  clearCookies(): this {
    this.cookies.clear();
    return this;
  }

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  private captureCookies(response: Response) {
    // Node's fetch exposes multiple Set-Cookie headers through getSetCookie().
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const eq = pair?.indexOf('=') ?? -1;
      if (!pair || eq < 1) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      // An expired cookie is a deletion, which is exactly what logout sends.
      if (raw.includes('Expires=Thu, 01 Jan 1970') || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request<T = any>(
    method: string,
    path: string,
    options: { body?: unknown; token?: string | null; headers?: Record<string, string> } = {},
  ): Promise<TestResponse<T>> {
    const headers: Record<string, string> = { ...options.headers };

    // `token: null` means "send no token even though the client has one".
    const token = options.token === undefined ? this.accessToken : (options.token ?? undefined);
    if (token) headers.Authorization = `Bearer ${token}`;

    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.cookies.size > 0) {
      headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    }

    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });

    this.captureCookies(response);

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      return { status: response.status, headers: response.headers, body: (await response.json()) as T };
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      headers: response.headers,
      body: buffer.toString('utf8') as T,
      buffer,
    };
  }

  get = <T = any>(path: string, options?: Parameters<TestClient['request']>[2]) =>
    this.request<T>('GET', path, options);
  post = <T = any>(path: string, body?: unknown, options?: Parameters<TestClient['request']>[2]) =>
    this.request<T>('POST', path, { ...options, body });
  patch = <T = any>(path: string, body?: unknown, options?: Parameters<TestClient['request']>[2]) =>
    this.request<T>('PATCH', path, { ...options, body });
  delete = <T = any>(path: string, options?: Parameters<TestClient['request']>[2]) =>
    this.request<T>('DELETE', path, options);
}
