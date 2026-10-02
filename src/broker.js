/**
 * Ephemeral credential broker (in-memory reference implementation).
 *
 * Demonstrates the "no standing broad tokens" principle behind the PocketOS
 * incident: instead of one long-lived token scoped to an entire API, an agent
 * is issued a short-lived token scoped to exactly the tools it needs, and the
 * gate rejects expired or out-of-scope credentials before any policy check.
 *
 * A production broker would back this interface with a secrets manager / IdP
 * (Vault, AWS STS, SPIFFE, …); this in-memory version keeps the demo and
 * tests dependency-free. The clock is injectable for deterministic tests.
 */
import { randomBytes, randomUUID } from 'node:crypto';

export class CredentialBroker {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.tokens = new Map();
  }

  /**
   * Issue a short-lived, scope-limited token.
   * Scopes are tool names, prefix patterns like "railway.*", or "*" (broad —
   * accepted for legacy tokens, but the gate flags it; see demo).
   */
  issue({ subject = 'agent', scopes = ['*'], ttlMs = 60_000 } = {}) {
    const tokenId = randomUUID();
    const record = {
      tokenId,
      secret: randomBytes(24).toString('hex'),
      subject,
      scopes: [...scopes],
      issuedAt: this.now(),
      expiresAt: this.now() + ttlMs,
    };
    this.tokens.set(tokenId, record);
    return {
      tokenId,
      subject,
      scopes: record.scopes,
      issuedAt: new Date(record.issuedAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
    };
  }

  validate(tokenId) {
    const record = this.tokens.get(tokenId);
    if (!record) return { valid: false, reason: 'unknown token' };
    if (this.now() > record.expiresAt) return { valid: false, reason: 'token expired' };
    return { valid: true, token: record };
  }

  /** Does this token's scope cover the given tool name? */
  covers(tokenId, tool) {
    const v = this.validate(tokenId);
    if (!v.valid) return false;
    return v.token.scopes.some((scope) => {
      if (scope === '*') return true;
      if (scope === tool) return true;
      if (scope.endsWith('.*')) return tool.startsWith(scope.slice(0, -1));
      return false;
    });
  }

  isBroadScope(tokenId) {
    const v = this.validate(tokenId);
    return v.valid && v.token.scopes.includes('*');
  }

  revoke(tokenId) {
    return this.tokens.delete(tokenId);
  }
}
