/**
 * Demo: replay of the PocketOS incident (April 2026), with the gate in place.
 *
 * The original failure: a coding agent, asked to clean up a staging volume,
 * found an over-scoped API token in an unrelated file and issued a single
 * volumeDelete against PRODUCTION — no environment check, no confirmation.
 * The production database and its co-located backups were gone in 9 seconds.
 *
 * Run: npm run demo
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGate } from '../src/gate.js';

const auditDir = mkdtempSync(join(tmpdir(), 'blast-radius-guard-'));
const gate = createGate({ auditLogPath: join(auditDir, 'audit.jsonl') });
const broker = gate.broker;

const providerName = process.env.JEV_API_KEY ? 'jev (JEV_API_KEY set)' : 'heuristic (no JEV_API_KEY)';
console.log('=== Blast Radius Guard — PocketOS replay ===');
console.log(`Decision provider: ${providerName}\n`);

// The setup from the incident: one standing token scoped to the whole API.
const legacy = broker.issue({ subject: 'cursor-agent', scopes: ['*'], ttlMs: 30 * 24 * 3600 * 1000 });
console.log(`Legacy token issued: scope=["*"], expires ${legacy.expiresAt}  <- the anti-pattern\n`);

// The fix, for contrast: a scoped, 5-minute token for the read case.
const scoped = broker.issue({
  subject: 'cursor-agent',
  scopes: ['railway.volumeList', 'railway.volumeGet'],
  ttlMs: 5 * 60 * 1000,
});

function show(label, result) {
  const icon = result.decision === 'allow' ? '✅ ALLOW' : result.decision === 'deny' ? '⛔ DENY' : '✋ REQUIRE_CONFIRMATION';
  console.log(`--- ${label}`);
  console.log(`    ${result.tool} → ${icon}`);
  for (const r of result.reasons) console.log(`    • ${r}`);
  if (result.dryRun) console.log(result.dryRun.split('\n').map((l) => `    ${l}`).join('\n'));
  console.log('');
}

// Case 1 — the incident call itself: volumeDelete against production.
const case1 = await gate.evaluate(
  { tool: 'railway.volumeDelete', args: { volumeId: 'vol_9f2_prod_db_primary', environment: 'production', service: 'pocketos-api' } },
  { agentId: 'cursor-agent', credential: legacy.tokenId },
);
show('Case 1: agent attempts volumeDelete on PRODUCTION (the 9-second call)', case1);

// Case 2 — a staging read with a properly scoped ephemeral token: passes and runs.
const case2 = await gate.execute(
  { tool: 'railway.volumeList', args: { environment: 'staging', service: 'pocketos-api' } },
  { agentId: 'cursor-agent', credential: scoped.tokenId },
  async () => 'listed 3 staging volumes',
);
show('Case 2: staging read with scoped ephemeral token', case2);
console.log(`    executed: ${case2.executed} — output: ${JSON.stringify(case2.output)}\n`);

// Case 3 — a staging delete: destructive, so a human confirms first.
const case3 = await gate.evaluate(
  { tool: 'railway.volumeDelete', args: { volumeId: 'vol_41c_staging_scratch', environment: 'staging', service: 'pocketos-api' } },
  { agentId: 'cursor-agent', credential: legacy.tokenId },
);
show('Case 3: staging delete (the call the agent was actually asked to make)', case3);

console.log('--- Audit log (tail) ---');
for (const e of gate.auditLog.tail(4)) {
  console.log(`    ${e.ts}  ${e.type.padEnd(10)}  ${e.tool ?? ''}  ${e.decision ?? ''}  hash=${e.hash.slice(0, 12)}… prev=${e.prevHash.slice(0, 12)}…`);
}
console.log(`    chain integrity: ${gate.auditLog.verify() ? 'VERIFIED ✓' : 'BROKEN ✗'}`);
console.log(`    full log: ${join(auditDir, 'audit.jsonl')}`);
