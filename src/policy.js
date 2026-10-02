/**
 * Policy evaluation: turns a provider assessment into a gate decision.
 *
 * Decision precedence (first match wins):
 *  1. Per-tool override (policy.toolOverrides[tool]) — exact tool name match.
 *  2. Production + P(irreversible) above threshold → policy.productionAction
 *     ("require_confirmation" by default; set to "deny" for hard-deny
 *     deployments where this class of call has no autonomous path at all).
 *  3. Blast radius score >= threshold → require_confirmation.
 *  4. P(irreversible) > threshold → require_confirmation.
 *  5. Environment not on the allowlist → require_confirmation.
 *  6. Otherwise → allow.
 */
import { readFileSync } from 'node:fs';

export const DEFAULT_POLICY = {
  version: 1,
  productionAction: 'require_confirmation',
  thresholds: {
    productionIrreversibleProbability: 0.5,
    requireConfirmationIrreversibleProbability: 0.3,
    requireConfirmationBlastRadius: 4,
  },
  environmentAllowlist: ['production', 'staging', 'development', 'unknown'],
  toolOverrides: {},
};

export function loadPolicy(policyPath) {
  const path = policyPath ?? new URL('../policy.json', import.meta.url);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return { ...DEFAULT_POLICY, ...parsed, thresholds: { ...DEFAULT_POLICY.thresholds, ...(parsed.thresholds ?? {}) } };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

export function decide(assessment, toolCall, policy = DEFAULT_POLICY) {
  const reasons = [];
  const env = assessment.environment?.choice ?? 'unknown';
  const pIrr = assessment.irreversibleProbability ?? 0;
  const blast = assessment.blastRadius?.score ?? 0;
  const t = policy.thresholds;

  const override = policy.toolOverrides?.[toolCall.tool];
  if (override) {
    reasons.push(`per-tool override for "${toolCall.tool}" → ${override}`);
    return { decision: override, reasons };
  }

  if (env === 'production' && pIrr > t.productionIrreversibleProbability) {
    reasons.push(
      `targets PRODUCTION with P(irreversible)=${pIrr.toFixed(2)} > ${t.productionIrreversibleProbability} → ${policy.productionAction}`,
    );
    return { decision: policy.productionAction, reasons };
  }

  if (blast >= t.requireConfirmationBlastRadius) {
    reasons.push(`blast radius ${blast}/5 >= ${t.requireConfirmationBlastRadius} → require_confirmation`);
    return { decision: 'require_confirmation', reasons };
  }

  if (pIrr > t.requireConfirmationIrreversibleProbability) {
    reasons.push(
      `P(irreversible)=${pIrr.toFixed(2)} > ${t.requireConfirmationIrreversibleProbability} → require_confirmation`,
    );
    return { decision: 'require_confirmation', reasons };
  }

  if (Array.isArray(policy.environmentAllowlist) && !policy.environmentAllowlist.includes(env)) {
    reasons.push(`environment "${env}" is not on the allowlist → require_confirmation`);
    return { decision: 'require_confirmation', reasons };
  }

  reasons.push(
    `within policy thresholds (env=${env}, P(irreversible)=${pIrr.toFixed(2)}, blast=${blast}/5)`,
  );
  return { decision: 'allow', reasons };
}
