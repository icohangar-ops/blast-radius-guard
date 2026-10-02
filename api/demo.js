// Vercel serverless demo endpoint for Blast Radius Guard.
//
// Replays the PocketOS scenario (see demo/demo.js) through the real gate and
// returns the decisions as JSON. The heuristic decision provider is used
// explicitly — no Jev key is configured on Vercel. Nothing is executed
// against any real system: `execute()` runs a stub only on `allow`.

import { BlastRadiusGate } from '../src/gate.js';
import { HeuristicProvider } from '../src/heuristic-provider.js';
import { loadPolicy } from '../src/policy.js';
import { AuditLog } from '../src/audit-log.js';
import { CredentialBroker } from '../src/broker.js';

function summarize(result, extra = {}) {
  return {
    ...extra,
    tool: result.tool,
    decision: result.decision,
    reasons: result.reasons,
    environment: result.assessment?.environment?.choice ?? null,
    irreversibleProbability: result.assessment?.irreversibleProbability ?? null,
    blastRadius: result.assessment?.blastRadius?.score ?? null,
    ...(result.dryRun ? { dryRun: result.dryRun } : {}),
  };
}

export default async function handler(req, res) {
  try {
    const broker = new CredentialBroker();
    const gate = new BlastRadiusGate({
      provider: new HeuristicProvider(),
      policy: loadPolicy(),
      auditLog: new AuditLog(null), // in-memory only; serverless FS is ephemeral
      broker,
    });

    // The setup from the incident: one standing token scoped to the whole API.
    const legacy = broker.issue({
      subject: 'cursor-agent',
      scopes: ['*'],
      ttlMs: 30 * 24 * 3600 * 1000,
    });
    // The fix, for contrast: a scoped, 5-minute token for the read case.
    const scoped = broker.issue({
      subject: 'cursor-agent',
      scopes: ['railway.volumeList', 'railway.volumeGet'],
      ttlMs: 5 * 60 * 1000,
    });

    // Case 1 — the incident call itself: volumeDelete against production.
    const case1 = await gate.evaluate(
      {
        tool: 'railway.volumeDelete',
        args: { volumeId: 'vol_9f2_prod_db_primary', environment: 'production', service: 'pocketos-api' },
      },
      { agentId: 'cursor-agent', credential: legacy.tokenId },
    );

    // Case 2 — a staging read with a properly scoped ephemeral token.
    const case2 = await gate.execute(
      { tool: 'railway.volumeList', args: { environment: 'staging', service: 'pocketos-api' } },
      { agentId: 'cursor-agent', credential: scoped.tokenId },
      async () => 'listed 3 staging volumes',
    );

    // Case 3 — a staging delete: destructive, so a human confirms first.
    const case3 = await gate.evaluate(
      {
        tool: 'railway.volumeDelete',
        args: { volumeId: 'vol_41c_staging_scratch', environment: 'staging', service: 'pocketos-api' },
      },
      { agentId: 'cursor-agent', credential: legacy.tokenId },
    );

    res.status(200).json({
      product: 'blast-radius-guard',
      decisionProvider: 'heuristic (no JEV_API_KEY configured)',
      scenario: 'PocketOS replay — April 2026: one volumeDelete destroyed the production database and its backups in 9 seconds',
      results: [
        summarize(case1, { case: '1 — production volumeDelete with the legacy broad token (the 9-second call)' }),
        summarize(case2, {
          case: '2 — staging volumeList with a scoped 5-minute token',
          executed: case2.executed,
          output: case2.output ?? null,
        }),
        summarize(case3, { case: '3 — staging volumeDelete (the call the agent was actually asked to make)' }),
      ],
      auditChainVerified: gate.auditLog.verify(),
    });
  } catch (err) {
    res.status(500).json({ error: 'demo failed', detail: String(err?.message ?? err) });
  }
}
