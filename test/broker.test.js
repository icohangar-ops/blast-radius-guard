import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CredentialBroker } from '../src/broker.js';
import { BlastRadiusGate } from '../src/gate.js';
import { HeuristicProvider } from '../src/heuristic-provider.js';
import { loadPolicy } from '../src/policy.js';
import { AuditLog } from '../src/audit-log.js';

test('broker issues scoped tokens and enforces scope', () => {
  const broker = new CredentialBroker();
  const t = broker.issue({ subject: 'agent', scopes: ['railway.volumeList', 'railway.*'], ttlMs: 60_000 });
  assert.equal(broker.validate(t.tokenId).valid, true);
  assert.equal(broker.covers(t.tokenId, 'railway.volumeList'), true);
  assert.equal(broker.covers(t.tokenId, 'railway.volumeDelete'), true); // via railway.* prefix
  assert.equal(broker.covers(t.tokenId, 'aws.s3.deleteBucket'), false);
  assert.equal(broker.isBroadScope(t.tokenId), false);
});

test('broker tokens expire (injected clock)', () => {
  let now = 1_000_000;
  const broker = new CredentialBroker({ now: () => now });
  const t = broker.issue({ subject: 'agent', scopes: ['railway.volumeList'], ttlMs: 5_000 });
  assert.equal(broker.validate(t.tokenId).valid, true);
  now += 5_001;
  const v = broker.validate(t.tokenId);
  assert.equal(v.valid, false);
  assert.match(v.reason, /expired/);
  assert.equal(broker.covers(t.tokenId, 'railway.volumeList'), false);
});

test('gate denies expired and out-of-scope credentials before policy', async () => {
  let now = 1_000_000;
  const broker = new CredentialBroker({ now: () => now });
  const gate = new BlastRadiusGate({
    provider: new HeuristicProvider(),
    policy: loadPolicy(),
    auditLog: new AuditLog(null),
    broker,
  });
  const read = { tool: 'railway.volumeList', args: { environment: 'staging' } };

  const scoped = broker.issue({ subject: 'agent', scopes: ['railway.volumeGet'], ttlMs: 60_000 });
  const outOfScope = await gate.evaluate(read, { agentId: 'a', credential: scoped.tokenId });
  assert.equal(outOfScope.decision, 'deny');
  assert.ok(outOfScope.reasons.some((r) => r.includes('scope')));

  now += 61_000;
  const expired = await gate.evaluate(read, { agentId: 'a', credential: scoped.tokenId });
  assert.equal(expired.decision, 'deny');
  assert.ok(expired.reasons.some((r) => r.includes('expired')));

  const unknown = await gate.evaluate(read, { agentId: 'a', credential: 'no-such-token' });
  assert.equal(unknown.decision, 'deny');
});

test('gate flags broad standing tokens but still evaluates', async () => {
  const broker = new CredentialBroker();
  const gate = new BlastRadiusGate({
    provider: new HeuristicProvider(),
    policy: loadPolicy(),
    auditLog: new AuditLog(null),
    broker,
  });
  const broad = broker.issue({ subject: 'agent', scopes: ['*'], ttlMs: 60_000 });
  const r = await gate.evaluate(
    { tool: 'railway.volumeList', args: { environment: 'staging' } },
    { agentId: 'a', credential: broad.tokenId },
  );
  assert.equal(r.decision, 'allow');
  assert.ok(r.reasons.some((x) => x.includes('broad-scope')));
});
