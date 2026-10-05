/** Short-lived HMAC-signed tokens for companion and dashboard links. */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface TokenPayload {
  g: string;            // guild id
  u: string;            // user id
  s: 'listen' | 'admin';
  exp: number;          // unix ms
  l?: string;           // preferred language
}

const b64u = (b: Buffer) => b.toString('base64url');

export class TokenSigner {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (!secret || secret.length < 16) throw new Error('WEB_SECRET must be at least 16 characters');
    this.key = Buffer.from(secret, 'utf8');
  }

  static randomSecret(): string {
    return randomBytes(32).toString('base64url');
  }

  sign(p: Omit<TokenPayload, 'exp'>, ttlMs: number, now = Date.now()): string {
    const body = b64u(Buffer.from(JSON.stringify({ ...p, exp: now + ttlMs })));
    const sig = b64u(createHmac('sha256', this.key).update(body).digest());
    return `${body}.${sig}`;
  }

  verify(token: string | null | undefined, scope?: TokenPayload['s'], now = Date.now()): TokenPayload | null {
    if (!token) return null;
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const want = createHmac('sha256', this.key).update(body).digest();
    const got = Buffer.from(sig, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
      if (typeof p.exp !== 'number' || p.exp < now) return null;
      if (scope && p.s !== scope && p.s !== 'admin') return null;
      return p;
    } catch {
      return null;
    }
  }
}
