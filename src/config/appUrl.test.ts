/**
 * Where an emailed link points.
 *
 * This looks like configuration trivia and is not. `APP_URL` carried a default
 * of `http://localhost:5173`, so a deployment that never set it emailed every
 * password reset link pointing at the recipient's own machine. Following one
 * opened a local dev server, queried a different database, and reported the
 * token as invalid — while the real token sat untouched on the server, looking
 * perfectly healthy to anyone inspecting it. The symptom pointed at tokens; the
 * cause was a default in a config file.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAppUrl } from './env.js';

const RENDER = 'https://vyapar-sathi-y7bg.onrender.com';

/// Mirrors the controller: configured origin, or the host the request reached.
const linkBase = (appUrl: string | undefined, requestOrigin: string) => appUrl ?? requestOrigin;

describe('resolveAppUrl', () => {
  it('never falls back to localhost in production', () => {
    assert.equal(resolveAppUrl(undefined, true), undefined);
  });

  it('keeps the localhost default in development, where Vite really is elsewhere', () => {
    // Development genuinely has two origins — Vite on 5173, the API on 4000 —
    // so guessing from the request host would be wrong there.
    assert.equal(resolveAppUrl(undefined, false), 'http://localhost:5173');
  });

  it('uses an explicitly configured URL in either mode', () => {
    assert.equal(resolveAppUrl(RENDER, true), RENDER);
    assert.equal(resolveAppUrl(RENDER, false), RENDER);
  });
});

describe('the base a reset link is built on', () => {
  it('is the request host on an unconfigured production deployment', () => {
    const base = linkBase(resolveAppUrl(undefined, true), RENDER);
    assert.equal(base, RENDER);
    assert.equal(`${base}/reset-password?token=abc`, `${RENDER}/reset-password?token=abc`);
  });

  it('cannot produce a localhost link from a production request', () => {
    // The regression, stated as the property that was violated.
    const base = linkBase(resolveAppUrl(undefined, true), RENDER);
    assert.ok(!base.includes('localhost'), `link base was ${base}`);
  });

  it('still points at Vite in development', () => {
    const base = linkBase(resolveAppUrl(undefined, false), 'http://localhost:4000');
    assert.equal(base, 'http://localhost:5173');
  });

  it('prefers a configured URL over the request host, for a two-host deployment', () => {
    const base = linkBase(resolveAppUrl('https://app.example.me', true), 'https://api.example.me');
    assert.equal(base, 'https://app.example.me');
  });
});
