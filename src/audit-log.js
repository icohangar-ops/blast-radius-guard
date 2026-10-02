/**
 * Immutable, append-only audit log.
 *
 * Each entry is one JSON line. Every entry carries `prevHash` (the SHA-256 of
 * the previous entry) and its own `hash`, forming a tamper-evident chain:
 * editing or deleting any historical line breaks verification of every
 * subsequent entry. The genesis entry chains from 64 zero characters.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

export const GENESIS_HASH = '0'.repeat(64);

function computeHash(prevHash, body) {
  return createHash('sha256').update(`${prevHash}\n${JSON.stringify(body)}`).digest('hex');
}

export class AuditLog {
  /** @param {string|null} filePath — JSONL file to append to; null keeps entries in memory only. */
  constructor(filePath = null) {
    this.filePath = filePath;
    this.entries = [];
    this.lastHash = GENESIS_HASH;
    if (filePath && existsSync(filePath)) {
      const lines = readFileSync(filePath, 'utf8').split('\n').filter((l) => l.trim());
      for (const line of lines) {
        const entry = JSON.parse(line);
        this.entries.push(entry);
        this.lastHash = entry.hash;
      }
    }
  }

  append(core) {
    const body = { ts: new Date().toISOString(), ...core, prevHash: this.lastHash };
    const hash = computeHash(this.lastHash, body);
    const entry = { ...body, hash };
    this.entries.push(entry);
    this.lastHash = hash;
    if (this.filePath) appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
    return entry;
  }

  tail(n = 5) {
    return this.entries.slice(-n);
  }

  /** Recompute the whole chain; returns true iff every link and hash checks out. */
  verify() {
    let prev = GENESIS_HASH;
    for (const entry of this.entries) {
      if (entry.prevHash !== prev) return false;
      const { hash, ...rest } = entry;
      // Rebuild the exact body that was hashed: all fields except `hash`, in stored order.
      const body = { ...rest };
      delete body.hash;
      if (computeHash(prev, body) !== hash) return false;
      prev = hash;
    }
    return prev === this.lastHash;
  }
}
