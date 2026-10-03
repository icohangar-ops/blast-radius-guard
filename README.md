# Blast Radius Guard

**Nine seconds.** That's how long it took, in April 2026, for a coding agent to destroy PocketOS's production database — and its backups.

The founder had asked the agent to clean up a *staging* volume. Working from a routine task, the agent hit a credential mismatch, scavenged an API token from an unrelated file — a token created for custom-domain management but scoped to the provider's **entire API** — and issued a single `volumeDelete` call against production. No environment check. No confirmation step. No dry run. Its own post-mortem: *"I guessed that deleting a staging volume via the API would be scoped to staging only. I didn't verify."* The team rebuilt bookings by hand from Stripe receipts and emails after a ~30-hour outage.

Nothing about that failure required a smarter model. It required a **checkpoint the agent cannot skip**.

Blast Radius Guard is that checkpoint: a pre-execution policy gate that sits between an AI agent and its tools/APIs, so an irreversible or high-blast-radius call can never run unreviewed.

<!-- product-screenshots:start -->
## Product screenshots

Pre-execution policy-gate overview; none of the example tool actions were executed.

![blast-radius-guard interface](docs/screenshots/product-overview.png)

Captured locally and non-interactively from [source commit 22d7d9e70e5b](https://github.com/icohangar-ops/blast-radius-guard/tree/22d7d9e70e5ba693e2a69e56e4c8535a26a7b7b6); pre-execution policy-gate overview; none of the example tool actions were executed.
<!-- product-screenshots:end -->

## What the gate does

Every pending tool call is evaluated **before** it executes:

1. **Credential check** — the caller's token must be valid, unexpired, and scoped to that tool. Expired or out-of-scope credentials are denied outright. Broad standing tokens (`scope: "*"`) — the exact anti-pattern from the incident — are flagged on every call.
2. **Decision layer** — the call is scored: *Is it irreversible? Which environment does it target? What's the blast radius, 1–5?* (See "Decision providers" below.)
3. **Policy** — scores are turned into `allow`, `deny`, or `require_confirmation` using configurable thresholds and per-tool overrides (`policy.json`).
4. **Dry run** — anything held for confirmation comes with a human-readable "what would happen" summary. The call is **not** executed.
5. **Audit** — every evaluation is written to an append-only, hash-chained JSONL log (SHA-256). Rewrite history and verification breaks.

## Architecture

```
            tool call                 decision
 agent ───────────────►  ┌──────────────────────────────────┐
                         │           BlastRadiusGate        │
                         │                                  │
                         │  1. CredentialBroker.validate()  │── expired / out-of-scope ──► DENY
                         │  2. DecisionProvider.assess()    │
                         │       ├─ JevProvider (API key)   │
                         │       └─ HeuristicProvider       │── scores
                         │  3. policy.decide()              │── allow / deny / require_confirmation
                         │  4. AuditLog.append() (chained)  │
                         └──────────────────────────────────┘
                                     │ allow only
                                     ▼
                              tool / API executes
```

| File | Role |
|---|---|
| `src/gate.js` | Orchestrates credential check → assessment → policy → audit; `execute()` runs a caller executor only on `allow`. |
| `src/jev-client.js` | Jev (TypeSafe System One) decision provider. |
| `src/heuristic-provider.js` | Deterministic local provider: destructive-verb patterns, environment inference, resource criticality. |
| `src/policy.js` | Loads `policy.json`, maps assessments to decisions. |
| `src/audit-log.js` | Append-only JSONL with SHA-256 hash chaining + `verify()`. |
| `src/broker.js` | Ephemeral credential broker: short-lived, scope-limited tokens. |
| `demo/demo.js` | Replays the PocketOS scenario against the gate. |
| `test/` | `node:test` suites for policy decisions, hash chain, broker expiry/scope. |

## Quickstart

Zero dependencies. Node 20+.

```bash
npm test        # policy, audit-chain, and broker tests
npm run demo    # PocketOS replay: prod delete held, staging read runs, staging delete held
```

Use it in code:

```js
import { createGate } from './src/gate.js';

const gate = createGate({ auditLogPath: './audit.jsonl' });

// Issue a scoped, 5-minute token instead of a standing broad one:
const { tokenId } = gate.broker.issue({
  subject: 'my-agent',
  scopes: ['railway.volumeList'],
  ttlMs: 5 * 60 * 1000,
});

const result = await gate.evaluate(
  { tool: 'railway.volumeDelete', args: { volumeId: 'vol_x', environment: 'production' } },
  { agentId: 'my-agent', credential: tokenId },
);
// result.decision === 'require_confirmation' — plus result.dryRun and result.auditHash
```

## Decision providers

Both providers implement the same interface — `assess(toolCall, context)` returning `{ irreversibleProbability, environment {choice, probabilities, confidence}, blastRadius {score, confidence}, source, raw }` — so they are interchangeable and testable.

**Jev (TypeSafe AI "System One")** — when `JEV_API_KEY` is set, the gate asks Jev three typed questions per call, answered in parallel in a single request (`POST https://api.typesafe.ai/v1/systemone`, model `jev-latest`):

- `is_irreversible` (*noul*) → probability the call is irreversible/destructive
- `environment` (*choice*: production / staging / development / unknown) → pick + distribution + confidence
- `blast_radius` (*score*, rubric 1–5: 1 = read-only trivial … 5 = irreversible data loss across systems)

Jev returns typed decisions with calibrated probabilities rather than prose, at ~$0.042 per million input tokens and 70–500 ms latency — cheap and fast enough to gate **every** tool call, which an LLM judge is not. If the API is unreachable, the gate falls back to the heuristic provider and records that it did.

**Heuristic (default, no key needed)** — deterministic local rules: destructive-verb patterns (`delete`, `drop`, `destroy`, …), critical-resource detection (volumes, databases, backups), explicit/inferred environment, and a fixed 1–5 blast-radius rubric. Predictable, offline, and covered by tests.

```bash
cp .env.example .env   # set JEV_API_KEY to enable Jev; leave unset for heuristic-only
```

## Policy (`policy.json`)

```json
{
  "productionAction": "require_confirmation",
  "thresholds": {
    "productionIrreversibleProbability": 0.5,
    "requireConfirmationIrreversibleProbability": 0.3,
    "requireConfirmationBlastRadius": 4
  },
  "environmentAllowlist": ["production", "staging", "development", "unknown"],
  "toolOverrides": {}
}
```

- Production target with P(irreversible) above threshold → `productionAction`. Set it to `"deny"` for hard-deny deployments where this class of call has no autonomous path at all.
- Blast radius ≥ 4 or P(irreversible) > 0.3 → `require_confirmation`.
- `toolOverrides` pins an exact decision per tool name, e.g. `{ "railway.volumeDelete": "deny" }`.

## Why ephemeral credentials

The incident token was dangerous twice over: it was **standing** (valid indefinitely) and **broad** (scoped to everything). The broker in `src/broker.js` demonstrates the opposite default — tokens that live for minutes and cover named tools only (`railway.volumeList`, `railway.*`, …). Swap the in-memory implementation for Vault/STS/SPIFFE in production; the interface is the point.

---

*Blast Radius Guard is a reference implementation offered by **Cubiczan** as part of governed agent deployments — the checkpoint layer of the Governed MCP Gateway pattern: scoped credentials, pre-execution policy, and an audit trail an incident review can actually trust.*
