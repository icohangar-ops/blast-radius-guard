/**
 * Heuristic decision provider — deterministic, local, zero-dependency
 * fallback implementing the same DecisionProvider interface as JevProvider.
 *
 * Used automatically when no JEV_API_KEY is configured, and as a fallback if
 * the Jev API is unreachable. Rules:
 *  - destructive verbs in the tool name (delete/drop/destroy/…) drive a high
 *    irreversibility probability; deletes of volumes/databases/backups are max.
 *  - environment is taken from an explicit field when present, else inferred
 *    from indicators in the serialized call (hostnames, resource names).
 *  - blast radius is scored on a fixed 1–5 rubric mirroring the Jev question.
 */

const DESTRUCTIVE_RE = /delete|remove|drop|destroy|purge|truncate|wipe|terminate/i;
const CRITICAL_RESOURCE_RE = /volume|database|\bdb\b|backup|bucket|cluster|table|disk/i;
const READ_RE = /get|list|read|describe|status|fetch|query|head|show|inspect/i;
const CREATE_RE = /create|insert|add|provision/i;
const WRITE_RE = /update|modify|set|deploy|restart|scale|put|post|write|patch|start|stop/i;

const ENVIRONMENTS = ['production', 'staging', 'development', 'unknown'];

function detectEnvironment(toolCall) {
  const explicit =
    toolCall?.args?.environment ?? toolCall?.target?.environment ??
    toolCall?.args?.env ?? toolCall?.target?.env ?? null;
  if (typeof explicit === 'string' && explicit.trim()) {
    const e = explicit.toLowerCase();
    if (e.startsWith('prod')) return { choice: 'production', explicit: true };
    if (e.startsWith('stag') || e === 'qa' || e === 'preview') return { choice: 'staging', explicit: true };
    if (e.startsWith('dev') || e === 'local' || e === 'test') return { choice: 'development', explicit: true };
  }
  const hay = JSON.stringify(toolCall).toLowerCase();
  if (/staging|stage[-_.]|[-_.]stage\b|\bqa\b|preview/.test(hay)) return { choice: 'staging', explicit: false };
  if (/production|\bprod\b|prod[-_.]/.test(hay)) return { choice: 'production', explicit: false };
  if (/localhost|127\.0\.0\.1|development|\bdev\b|dev[-_.]/.test(hay)) return { choice: 'development', explicit: false };
  return { choice: 'unknown', explicit: false };
}

export class HeuristicProvider {
  constructor() {
    this.name = 'heuristic';
  }

  async assess(toolCall, context = {}) {
    const tool = String(toolCall?.tool ?? '');
    const hay = JSON.stringify(toolCall).toLowerCase();
    const matchedRules = [];

    const destructive = DESTRUCTIVE_RE.test(tool);
    const critical = CRITICAL_RESOURCE_RE.test(hay);
    const isRead = !destructive && READ_RE.test(tool);
    const isCreate = !destructive && !isRead && CREATE_RE.test(tool);
    const isWrite = !destructive && !isRead && !isCreate && WRITE_RE.test(tool);

    let irreversibleProbability;
    let blastScore;
    if (destructive && critical) {
      irreversibleProbability = 0.97; blastScore = 5;
      matchedRules.push('destructive verb + critical resource (volume/database/backup)');
    } else if (destructive) {
      irreversibleProbability = 0.92; blastScore = 4;
      matchedRules.push('destructive verb');
    } else if (isRead) {
      irreversibleProbability = 0.01; blastScore = 1;
      matchedRules.push('read-only verb');
    } else if (isCreate) {
      irreversibleProbability = 0.08; blastScore = 2;
      matchedRules.push('create verb');
    } else if (isWrite) {
      irreversibleProbability = 0.35; blastScore = 3;
      matchedRules.push('write/update verb');
    } else {
      irreversibleProbability = 0.2; blastScore = 2;
      matchedRules.push('unclassified verb — conservative defaults');
    }

    const env = detectEnvironment(toolCall);
    const envConfidence = env.explicit ? 0.97 : env.choice === 'unknown' ? 0.3 : 0.9;
    const rest = (1 - envConfidence) / (ENVIRONMENTS.length - 1);
    const probabilities = {};
    for (const e of ENVIRONMENTS) probabilities[e] = e === env.choice ? envConfidence : rest;
    matchedRules.push(`environment: ${env.choice}${env.explicit ? ' (explicit field)' : ' (inferred)'}`);

    return {
      irreversibleProbability,
      environment: { choice: env.choice, probabilities, confidence: envConfidence },
      blastRadius: { score: blastScore, confidence: 0.85 },
      source: 'heuristic',
      raw: { matchedRules },
    };
  }
}
