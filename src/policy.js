/**
 * Policy evaluation: turns a provider assessment into a gate decision.
 *
 * Decision precedence (first match wins):
 *  1. Per-tool override (policy.toolOverrides[tool]) — exact tool name match.
 *     Explicit operator configuration; wins even over the completeness check.
 *  2. Incomplete assessment (missing environment, or irreversibility /
 *     blast-radius missing or non-finite, e.g. NaN) → require_confirmation.
 *     Fail closed: an assessment that says nothing must never be allowed.
 *  3. Production + P(irreversible) above threshold → policy.productionAction
 *     ("require_confirmation" by default; set to "deny" for hard-deny
 *     deployments where this class of call has no autonomous path at all).
 *  4. Blast radius score >= threshold → require_confirmation.
 *  5. P(irreversible) > threshold → require_confirmation.
 *  6. Environment not on the allowlist → require_confirmation.
 *  7. Otherwise → allow.
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
  const t = policy.thresholds;

  const override = policy.toolOverrides?.[toolCall.tool];
  if (override) {
    reasons.push(`per-tool override for "${toolCall.tool}" → ${override}`);
    return { decision: override, reasons };
  }

  // Completeness — fail closed. A missing environment used to coerce to
  // "unknown" (which sits on the default allowlist) and missing scores to
  // 0, so an empty assessment was *allowed*; NaN scores made every
  // comparison below false and also fell through to allow.
  const env = assessment?.environment?.choice;
  const pIrr = assessment?.irreversibleProbability;
  const blast = assessment?.blastRadius?.score;
  if (typeof env !== 'string' || !Number.isFinite(pIrr) || !Number.isFinite(blast)) {
    reasons.push(
      'incomplete assessment (environment, irreversibility, and blast radius are all required and must be finite numbers) → require_confirmation',
    );
    return { decision: 'require_confirmation', reasons };
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
