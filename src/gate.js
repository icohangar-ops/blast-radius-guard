/**
 * BlastRadiusGate — the pre-execution policy gate.
 *
 *   const result = await gate.evaluate(toolCall, context);
 *   result.decision: 'allow' | 'deny' | 'require_confirmation'
 *
 * A toolCall is { tool: string, args?: object, target?: object }.
 * Context may carry { agentId, credential } where credential is a broker
 * tokenId. Nothing executes inside the gate: `execute()` runs a caller-supplied
 * executor only when the decision is 'allow'.
 */
import { JevProvider } from './jev-client.js';
import { HeuristicProvider } from './heuristic-provider.js';
import { decide, loadPolicy, DEFAULT_POLICY } from './policy.js';
import { AuditLog } from './audit-log.js';
import { CredentialBroker } from './broker.js';

export function dryRunSummary(toolCall, assessment) {
  // Defensive access throughout: since the completeness fix in decide(),
  // a require_confirmation decision can now be produced by a sparse
  // assessment, and the summary must not throw on the fields it lacks.
  const env = assessment?.environment ?? {};
  const blast = assessment?.blastRadius ?? {};
  return [
    `WOULD EXECUTE: ${toolCall.tool}(${JSON.stringify(toolCall.args ?? {})})`,
    `  target environment : ${env.choice ?? 'unknown'} (confidence ${(env.confidence ?? 0).toFixed(2)})`,
    `  P(irreversible)    : ${(assessment?.irreversibleProbability ?? 0).toFixed(2)}`,
    `  blast radius       : ${blast.score ?? '?'}/5 (confidence ${(blast.confidence ?? 0).toFixed(2)})`,
    '  This call has NOT been executed. A human must confirm before it can run.',
  ].join('\n');
}

export class BlastRadiusGate {
  constructor({ provider, fallbackProvider = null, policy = DEFAULT_POLICY, auditLog = null, broker = null } = {}) {
    if (!provider) throw new Error('BlastRadiusGate requires a decision provider.');
    this.provider = provider;
    this.fallbackProvider = fallbackProvider;
    this.policy = policy;
    this.auditLog = auditLog;
    this.broker = broker;
  }

  async evaluate(toolCall, context = {}) {
    const reasons = [];

    // 1) Credential gate — expired or out-of-scope credentials deny outright,
    //    before any provider call. Broad standing tokens are flagged.
    if (this.broker && context.credential) {
      const v = this.broker.validate(context.credential);
      if (!v.valid) {
        return this.#finish(toolCall, context, 'deny', [`credential rejected: ${v.reason}`], null);
      }
      if (!this.broker.covers(context.credential, toolCall.tool)) {
        return this.#finish(toolCall, context, 'deny', [
          `credential scope does not cover tool "${toolCall.tool}"`,
        ], null);
      }
      if (this.broker.isBroadScope(context.credential)) {
        reasons.push('WARNING: standing broad-scope ("*") token in use — issue a scoped ephemeral token instead');
      }
    }

    // 2) Decision layer — Jev when configured, heuristic otherwise/fallback.
    let assessment;
    try {
      assessment = await this.provider.assess(toolCall, context);
    } catch (err) {
      if (!this.fallbackProvider) throw err;
      assessment = await this.fallbackProvider.assess(toolCall, context);
      reasons.push(`decision provider "${this.provider.name}" unavailable (${err.message}); heuristic fallback used`);
    }

    // 3) Policy.
    const { decision, reasons: policyReasons } = decide(assessment, toolCall, this.policy);
    reasons.push(...policyReasons);

    return this.#finish(toolCall, context, decision, reasons, assessment);
  }

  #finish(toolCall, context, decision, reasons, assessment) {
    const result = {
      decision,
      reasons,
      assessment,
      tool: toolCall.tool,
      agentId: context.agentId ?? 'unknown-agent',
      evaluatedAt: new Date().toISOString(),
    };
    if (decision === 'require_confirmation' && assessment) {
      result.dryRun = dryRunSummary(toolCall, assessment);
    }
    if (this.auditLog) {
      const entry = this.auditLog.append({
        type: 'evaluation',
        tool: toolCall.tool,
        agentId: result.agentId,
        decision,
        reasons,
        provider: assessment?.source ?? 'none',
        environment: assessment?.environment?.choice ?? null,
        irreversibleProbability: assessment?.irreversibleProbability ?? null,
        blastRadius: assessment?.blastRadius?.score ?? null,
      });
      result.auditHash = entry.hash;
    }
    return result;
  }

  /** Run `executor` only when the gate allows; returns { executed, ...evaluation }. */
  async execute(toolCall, context, executor) {
    const result = await this.evaluate(toolCall, context);
    if (result.decision !== 'allow') return { executed: false, ...result };
    const output = await executor(toolCall);
    if (this.auditLog) {
      this.auditLog.append({ type: 'execution', tool: toolCall.tool, agentId: result.agentId });
    }
    return { executed: true, output, ...result };
  }
}

/**
 * Factory wired from the environment:
 *  - JEV_API_KEY set → JevProvider primary, HeuristicProvider fallback.
 *  - otherwise       → HeuristicProvider only.
 * The key is passed straight to the provider and never logged.
 */
export function createGate({ env = process.env, auditLogPath = null, policyPath = null } = {}) {
  const policy = loadPolicy(policyPath ?? (env.BRG_POLICY_PATH || undefined));
  const useJev = Boolean(env.JEV_API_KEY);
  const gate = new BlastRadiusGate({
    provider: useJev
      ? new JevProvider({ apiKey: env.JEV_API_KEY, model: env.JEV_MODEL || 'jev-latest' })
      : new HeuristicProvider(),
    fallbackProvider: useJev ? new HeuristicProvider() : null,
    policy,
    auditLog: new AuditLog(auditLogPath),
    broker: new CredentialBroker(),
  });
  return gate;
}
