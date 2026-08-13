import pino from 'pino';
import { env, isProduction } from '../config/env.js';

export const logger = pino({
  level: isProduction ? 'info' : 'debug',
  // Never let a password, token or GSTIN-bearing body reach the log sink.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.newPassword',
      '*.currentPassword',
      '*.passwordHash',
      '*.refreshToken',
      '*.accessToken',
      '*.token',
    ],
    censor: '[redacted]',
  },
  ...(isProduction
    ? {}
    : { transport: { target: 'pino/file', options: { destination: 1 } } }),
  base: { env: env.NODE_ENV },
});
