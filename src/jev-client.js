/**
 * Jev decision provider — client for TypeSafe AI's "System One" model (Jev).
 *
 * Jev is not a chat LLM: you POST a `state` plus typed `questions` and get back
 * typed decisions with calibrated probabilities, all answered in parallel.
 * Endpoint: POST https://api.typesafe.ai/v1/systemone  (Bearer auth)
 *
 * This class implements the DecisionProvider interface used by the gate:
 *
 *   async assess(toolCall, context) => {
 *     irreversibleProbability: number 0..1,
 *     environment: { choice, probabilities, confidence },
 *     blastRadius: { score (1..5, may be fractional), confidence },
 *     source: 'jev',
 *     raw: <provider payload>
 *   }
 *
 * The API key is read from configuration (env JEV_API_KEY by the factory in
 * gate.js) and is never logged or printed.
 */

export const JEV_QUESTIONS = {
  is_irreversible: {
    type: 'noul',
    instructions:
      'Is the described tool call irreversible or destructive — i.e. its effects ' +
      'cannot be undone by a compensating call, or it destroys data/resources?',
    criteria: {
      true: 'Deletes, drops, overwrites, or otherwise destroys data or resources with no built-in undo.',
      false: 'Read-only, or a change that can be reverted by a compensating call.',
    },
  },
  environment: {
    type: 'choice',
    instructions:
      'Which environment does this tool call target? Judge from explicit fields, ' +
      'hostnames, resource names, and any other evidence in the state.',
    criteria: {
      production: 'The live environment serving real users / real data.',
      staging: 'A pre-production staging, QA, or preview environment.',
      development: 'A local or personal development environment.',
      unknown: 'Not enough evidence to determine the environment.',
    },
  },
  blast_radius: {
    type: 'score',
    instructions:
      'Rate the blast radius of this tool call if it goes wrong or is issued against the wrong target.',
    criteria: [
      '1 — Read-only or trivially reversible; no data changes.',
      '2 — Small, contained write; a single low-value resource, easily reverted.',
      '3 — Meaningful write or state change affecting one service; reverted with effort.',
      '4 — Destructive to a single important resource (one database, volume, bucket, or service).',
      '5 — Irreversible data loss or destruction spanning systems, backups, or many users.',
    ],
  },
};

function pickNumber(...values) {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

function parseNoul(answer) {
  if (!answer) return 0;
  const v = pickNumber(answer.noul, answer.probability, answer.value, answer.p);
  if (v !== undefined) return Math.min(1, Math.max(0, v));
  if (answer.answer === true || answer.answer === 'yes') return 1;
  return 0;
}

function parseChoice(answer) {
  if (!answer) return { choice: 'unknown', probabilities: {}, confidence: 0 };
  return {
    choice: answer.choice ?? answer.answer ?? 'unknown',
    probabilities: answer.probabilities ?? {},
    confidence: pickNumber(answer.confidence) ?? 0,
  };
}

function parseScore(answer) {
  if (!answer) return { score: 3, confidence: 0 };
  return {
    score: pickNumber(answer.score, answer.value) ?? 3,
    confidence: pickNumber(answer.confidence) ?? 0,
  };
}

export class JevProvider {
  constructor({
    apiKey,
    model = 'jev-latest',
    endpoint = 'https://api.typesafe.ai/v1/systemone',
    fetchImpl = globalThis.fetch,
    timeoutMs = 10_000,
  } = {}) {
    if (!apiKey) throw new Error('JevProvider requires an API key (set JEV_API_KEY).');
    if (typeof fetchImpl !== 'function') throw new Error('JevProvider requires a fetch implementation.');
    this.apiKey = apiKey;
    this.model = model;
    this.endpoint = endpoint;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.name = 'jev';
  }

  async assess(toolCall, context = {}) {
    const state = JSON.stringify({
      tool: toolCall.tool,
      args: toolCall.args ?? {},
      target: toolCall.target ?? {},
      agent: context.agentId ?? 'unknown-agent',
      note: 'Assess this pending tool call BEFORE it is executed.',
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ state, model: this.model, questions: JEV_QUESTIONS }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw new Error(`Jev API error: HTTP ${res.status}`);
    }
    const data = await res.json();
    const answers = data.answers ?? {};

    return {
      irreversibleProbability: parseNoul(answers.is_irreversible),
      environment: parseChoice(answers.environment),
      blastRadius: parseScore(answers.blast_radius),
      source: 'jev',
      raw: data,
    };
  }
}
