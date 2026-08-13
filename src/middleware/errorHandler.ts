import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { isProduction } from '../config/env.js';
import { logger } from '../lib/logger.js';

interface BodyParserError extends Error {
  type: string;
  status?: number;
  statusCode?: number;
}

/**
 * body-parser tags its own failures with a `type` — `entity.parse.failed` for
 * broken JSON, `entity.too.large` for an oversized body — and a 4xx status.
 * Matching on that rather than on `instanceof SyntaxError` avoids swallowing a
 * genuine SyntaxError thrown from inside a route, which really is a 500.
 */
function isBodyParserError(err: unknown): err is BodyParserError {
  if (!(err instanceof Error) || !('type' in err)) return false;
  const status = (err as BodyParserError).status ?? (err as BodyParserError).statusCode;
  return (
    typeof (err as BodyParserError).type === 'string' &&
    (err as BodyParserError).type.startsWith('entity.') &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
  );
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `Cannot ${req.method} ${req.path}` },
  });
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Some fields need correcting',
        fields: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
  }

  // body-parser rejects a malformed or oversized body before any route runs.
  // Without this branch those land in the 500 handler below, which reports a
  // server fault for what is squarely a bad request — and, outside production,
  // answers it with a stack trace.
  if (isBodyParserError(err)) {
    const status = err.status ?? err.statusCode ?? 400;
    const code = status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INVALID_BODY';
    const message =
      status === 413 ? 'That request was too large' : 'The request body is not valid JSON';
    return res.status(status).json({ error: { code, message } });
  }

  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2002 = unique constraint. The target names the column(s) that clashed,
    // which is usually enough for a useful message.
    if (err.code === 'P2002') {
      const target = (err.meta?.target as string[] | undefined)?.join(', ') ?? 'value';
      return res.status(409).json({
        error: { code: 'CONFLICT', message: `A record with this ${target} already exists` },
      });
    }
    if (err.code === 'P2025') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found' } });
    }
    if (err.code === 'P2003') {
      return res.status(400).json({
        error: { code: 'FOREIGN_KEY_ERROR', message: 'Referenced record does not exist' },
      });
    }
  }

  logger.error({ err, path: req.path, method: req.method }, 'Unhandled error');

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Something went wrong on our side',
      ...(isProduction ? {} : { debug: (err as Error)?.message, stack: (err as Error)?.stack }),
    },
  });
}
