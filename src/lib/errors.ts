export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);

/**
 * A 400 that carries its own code.
 *
 * Most validation failures are interchangeable to the caller — the message is
 * the whole content. A few are not: a reset link that expired, one retired by a
 * newer request, and one that was never real all need different advice, and a
 * screen cannot pick between them by reading English prose.
 */
export const badRequestCoded = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);

export const forbidden = (message = 'You do not have permission to do that') =>
  new AppError(403, 'FORBIDDEN', message);

export const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);

export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);

export const tooManyRequests = (message: string) =>
  new AppError(429, 'TOO_MANY_REQUESTS', message);
