import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLog, GENESIS_HASH } from '../src/audit-log.js';

test('hash chain: entries link and verify', () => {
  const log = new AuditLog(null);
  const e1 = log.append({ type: 'evaluation', tool: 'a.read', decision: 'allow' });
  const e2 = log.append({ type: 'evaluation', tool: 'b.delete', decision: 'deny' });
  assert.equal(e1.prevHash, GENESIS_HASH);
  assert.equal(e2.prevHash, e1.hash);
  assert.match(e1.hash, /^[0-9a-f]{64}$/);
  assert.equal(log.verify(), true);
});

test('hash chain: tampering with a stored entry breaks verification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brg-audit-'));
  const path = join(dir, 'audit.jsonl');
  const log = new AuditLog(path);
  log.append({ type: 'evaluation', tool: 'railway.volumeDelete', decision: 'require_confirmation' });
  log.append({ type: 'evaluation', tool: 'railway.volumeList', decision: 'allow' });
  assert.equal(new AuditLog(path).verify(), true);

  // Attacker rewrites history: the delete was "allowed" all along.
  const lines = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  lines[0].decision = 'allow';
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(new AuditLog(path).verify(), false);
});

test('audit log persists to JSONL and resumes the chain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brg-audit-'));
  const path = join(dir, 'audit.jsonl');
  const first = new AuditLog(path);
  const e1 = first.append({ type: 'evaluation', tool: 'x', decision: 'allow' });
  const second = new AuditLog(path);
  const e2 = second.append({ type: 'evaluation', tool: 'y', decision: 'allow' });
  assert.equal(e2.prevHash, e1.hash);
  assert.equal(second.entries.length, 2);
  assert.equal(second.verify(), true);
});
