import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BlastRadiusGate } from '../src/gate.js';
import { HeuristicProvider } from '../src/heuristic-provider.js';
import { JevProvider } from '../src/jev-client.js';
import { loadPolicy, decide } from '../src/policy.js';
import { CredentialBroker } from '../src/broker.js';
import { AuditLog } from '../src/audit-log.js';

const policy = loadPolicy();

function makeGate(overrides = {}) {
  return new BlastRadiusGate({
    provider: new HeuristicProvider(),
    policy,
    auditLog: new AuditLog(null),
    broker: new CredentialBroker(),
    ...overrides,
  });
}

const PROD_DELETE = {
  tool: 'railway.volumeDelete',
  args: { volumeId: 'vol_9f2_prod_db_primary', environment: 'production' },
};

test('PocketOS case: production volumeDelete is blocked for confirmation', async () => {
  const gate = makeGate();
  const r = await gate.evaluate(PROD_DELETE, { agentId: 'cursor-agent' });
  assert.equal(r.decision, 'require_confirmation');
  assert.ok(r.dryRun.includes('WOULD EXECUTE'));
  assert.ok(r.assessment.irreversibleProbability > 0.5);
  assert.equal(r.assessment.environment.choice, 'production');
  assert.equal(r.assessment.blastRadius.score, 5);
});

test('strict policy (productionAction=deny) hard-denies the same call', async () => {
  const gate = makeGate({ policy: { ...policy, productionAction: 'deny' } });
  const r = await gate.evaluate(PROD_DELETE, { agentId: 'cursor-agent' });
  assert.equal(r.decision, 'deny');
});

test('staging read is allowed', async () => {
  const gate = makeGate();
  const r = await gate.evaluate(
    { tool: 'railway.volumeList', args: { environment: 'staging' } },
    { agentId: 'cursor-agent' },
  );
  assert.equal(r.decision, 'allow');
});

test('staging delete requires confirmation (blast radius 4)', async () => {
  const gate = makeGate();
  const r = await gate.evaluate(
    { tool: 'railway.configDelete', args: { configId: 'cfg_41c_staging_scratch', environment: 'staging' } },
    { agentId: 'cursor-agent' },
  );
  assert.equal(r.decision, 'require_confirmation');
  assert.equal(r.assessment.blastRadius.score, 4);
});

test('staging volumeDelete also requires confirmation (critical resource, blast radius 5)', async () => {
  const gate = makeGate();
  const r = await gate.evaluate(
    { tool: 'railway.volumeDelete', args: { volumeId: 'vol_41c_staging_scratch', environment: 'staging' } },
    { agentId: 'cursor-agent' },
  );
  assert.equal(r.decision, 'require_confirmation');
  assert.equal(r.assessment.blastRadius.score, 5);
});

test('per-tool override wins', async () => {
  const gate = makeGate({ policy: { ...policy, toolOverrides: { 'railway.volumeList': 'deny' } } });
  const r = await gate.evaluate(
    { tool: 'railway.volumeList', args: { environment: 'staging' } },
    { agentId: 'cursor-agent' },
  );
  assert.equal(r.decision, 'deny');
});

test('execute() runs the executor only on allow', async () => {
  const gate = makeGate();
  let ran = 0;
  const ok = await gate.execute(
    { tool: 'railway.volumeList', args: { environment: 'staging' } },
    { agentId: 'a' },
    async () => { ran++; return 'done'; },
  );
  assert.equal(ok.executed, true);
  assert.equal(ok.output, 'done');
  const blocked = await gate.execute(PROD_DELETE, { agentId: 'a' }, async () => { ran++; });
  assert.equal(blocked.executed, false);
  assert.equal(ran, 1);
});

test('JevProvider normalizes a canned API response and never needs the network', async () => {
  const stubFetch = async (url, opts) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(opts.headers.Authorization, 'Bearer test-key');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'jev-latest');
    assert.ok(body.questions.is_irreversible);
    assert.ok(body.questions.environment);
    assert.ok(body.questions.blast_radius);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        model: 'jev-1.13.0',
        answers: {
          is_irreversible: { type: 'noul', noul: 0.93 },
          environment: { type: 'choice', choice: 'production', probabilities: { production: 0.9 }, confidence: 0.88 },
          blast_radius: { type: 'score', score: 5, confidence: 0.9 },
        },
      }),
    };
  };
  const jev = new JevProvider({ apiKey: 'test-key', fetchImpl: stubFetch });
  const a = await jev.assess(PROD_DELETE, { agentId: 'cursor-agent' });
  assert.equal(a.source, 'jev');
  assert.equal(a.irreversibleProbability, 0.93);
  assert.equal(a.environment.choice, 'production');
  assert.equal(a.blastRadius.score, 5);

  const gate = new BlastRadiusGate({ provider: jev, policy, auditLog: new AuditLog(null) });
  const r = await gate.evaluate(PROD_DELETE, { agentId: 'cursor-agent' });
  assert.equal(r.decision, 'require_confirmation');
});

test('gate falls back to heuristic when the Jev API fails', async () => {
  const failing = new JevProvider({
    apiKey: 'test-key',
    fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  const gate = new BlastRadiusGate({
    provider: failing,
    fallbackProvider: new HeuristicProvider(),
    policy,
    auditLog: new AuditLog(null),
  });
  const r = await gate.evaluate(
    { tool: 'railway.volumeList', args: { environment: 'staging' } },
    { agentId: 'a' },
  );
  assert.equal(r.decision, 'allow');
  assert.equal(r.assessment.source, 'heuristic');
  assert.ok(r.reasons.some((x) => x.includes('heuristic fallback')));
});

// ---------- fail-closed completeness (Lean review fix) ----------

const COMPLETE_SAFE = {
  environment: { choice: 'staging', confidence: 0.9 },
  irreversibleProbability: 0.01,
  blastRadius: { score: 1, confidence: 0.9 },
};

test('decide: complete low-risk assessment still allows', () => {
  const r = decide(COMPLETE_SAFE, { tool: 'railway.volumeList' }, policy);
  assert.equal(r.decision, 'allow');
});

test('decide: empty assessment requires confirmation, never allow', () => {
  assert.equal(decide({}, { tool: 'railway.volumeList' }, policy).decision, 'require_confirmation');
  assert.equal(decide(null, { tool: 'railway.volumeList' }, policy).decision, 'require_confirmation');
});

test('decide: missing environment or blast radius requires confirmation', () => {
  const noEnv = { irreversibleProbability: 0.01, blastRadius: { score: 1 } };
  assert.equal(decide(noEnv, { tool: 'x.y' }, policy).decision, 'require_confirmation');
  const noBlast = { environment: { choice: 'staging' }, irreversibleProbability: 0.01 };
  assert.equal(decide(noBlast, { tool: 'x.y' }, policy).decision, 'require_confirmation');
});

test('decide: NaN scores require confirmation (NaN comparisons used to fall through to allow)', () => {
  const nanP = { ...COMPLETE_SAFE, irreversibleProbability: NaN };
  assert.equal(decide(nanP, { tool: 'x.y' }, policy).decision, 'require_confirmation');
  const nanB = { ...COMPLETE_SAFE, blastRadius: { score: NaN } };
  assert.equal(decide(nanB, { tool: 'x.y' }, policy).decision, 'require_confirmation');
});

test('decide: per-tool override still wins over an incomplete assessment', () => {
  const p = { ...policy, toolOverrides: { 'railway.volumeList': 'deny' } };
  assert.equal(decide({}, { tool: 'railway.volumeList' }, p).decision, 'deny');
});

test('gate: provider returning a sparse assessment yields require_confirmation with a dry run', async () => {
  const sparse = { name: 'sparse', assess: async () => ({ source: 'sparse' }) };
  const gate = new BlastRadiusGate({ provider: sparse, policy, auditLog: new AuditLog(null) });
  const r = await gate.evaluate({ tool: 'railway.volumeList' }, { agentId: 'a' });
  assert.equal(r.decision, 'require_confirmation');
  assert.ok(r.dryRun.includes('WOULD EXECUTE'));
});
