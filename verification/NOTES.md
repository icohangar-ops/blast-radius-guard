# Verification notes — blast-radius-guard decision logic

`Gate.lean` is a self-contained core-Lean-4 model (no Mathlib, no lake
project) of the decision logic in `../src`. It compiles with:

```sh
lean Gate.lean        # verified with Lean 4.34.1 (elan toolchain)
```

No `sorry`, `admit`, or custom axioms. `#print axioms` on every theorem
below shows only Lean's standard axioms (`propext`, `Classical.choice`,
`Quot.sound`).

## Model ↔ source mapping

### Definitions

| Lean definition | Source | Notes |
|---|---|---|
| `Decision` (`allow` / `deny` / `requireConfirmation`) | `policy.js` (returned `decision` strings), `gate.js` line 5 | The three decision strings; `'require_confirmation'` ↦ `requireConfirmation`. |
| `Assessment` (`env`, `pIrr`, `blast`) | `policy.js` lines 40–42 | The three fields `decide` reads: `assessment.environment?.choice`, `assessment.irreversibleProbability`, `assessment.blastRadius?.score`. |
| `Policy` | `policy.js` lines 16–26 | Same fields as `DEFAULT_POLICY`; `toolOverrides` modelled as `List (String × Decision)` instead of a JS object. |
| `defaultPolicy` | `policy.js` lines 16–26 | Verbatim values: `productionAction = requireConfirmation`, thresholds `1/2`, `3/10`, `4`, allowlist `["production", "staging", "development", "unknown"]`, no overrides. JS floats `0.5` / `0.3` become exact rationals `1/2` / `3/10`. |
| `decideCore` | `policy.js` lines 51–78 | The threshold ladder, rungs 2–6, in source precedence. |
| `decide` | `policy.js` lines 39–79 | Rung 1 (override, lines 45–49) dispatched before `decideCore`. |
| `Token` (`scopes`, `expiresAt`) | `broker.js` lines 26–44 | Only the fields `validate`/`covers` read. |
| `validate` | `broker.js` lines 46–52 | Time aspect only: invalid iff `now() > expiresAt` (strict, line 49), hence valid iff `now ≤ expiresAt`. The unknown-token branch (line 48) is factored out — a presented credential is a known token. |
| `scopeCovers` | `broker.js` lines 57–62 | The per-scope predicate inside `covers`' `some(...)`: `"*"` ∨ exact match ∨ (`endsWith ".*"` ∧ `startsWith (scope.slice(0,-1))`). JS `slice(0, -1)` (drop last char, keeping the dot) is `String.dropEnd 1` in Lean 4.34. |
| `covers` | `broker.js` lines 54–63 | Re-validates first (line 55), then `List.any` over scopes (JS `Array.prototype.some`, line 57). |
| `evaluateWithToken` | `gate.js` lines 45–58 | Credential stage: invalid → deny; valid but not covering → deny; else fall through to `decide`. The broad-scope warning (lines 55–57) only appends a reason string and is not modelled. |
| `evaluate` | `gate.js` lines 40–73 | `cred = none` models "no broker or no credential presented" (line 45 guard) → straight to `decide`; `some tok` runs the credential stage first. The provider stage (lines 60–68) is abstracted into the given `Assessment`. |

### Theorems

| Theorem | Claim | Source |
|---|---|---|
| `decide_override` | (a) If `toolOverrides` maps the tool to `d`, `decide` returns `d`. | `policy.js` lines 45–49 |
| `decideCore_production_action` | Helper: when the production rung fires, `decideCore` returns `policy.productionAction`. | `policy.js` lines 51–56 |
| `decide_production_danger` | (b) Default policy: `env = "production"` ∧ `pIrr > 1/2` ⇒ `decide = requireConfirmation`. | `policy.js` lines 18, 51–56 |
| `decideCore_allow_safe` | Helper: `decideCore = allow` (and `productionAction ≠ allow`) ⇒ env ∈ allowlist ∧ `pIrr ≤` rc-threshold ∧ `blast <` blast-threshold ∧ ¬ production-danger. | `policy.js` lines 51–78 |
| `decide_allow_safe` | (c) **Allow is safe**, default policy: `decide = allow` ⇒ no override ∧ env ∈ allowlist ∧ `pIrr ≤ 3/10` ∧ `blast < 4` ∧ ¬(`env = "production"` ∧ `pIrr > 1/2`). | `policy.js` lines 39–79 |
| `decideCore_ne_allow_of_blast` | Helper: `blast ≥` threshold ⇒ `decideCore ≠ allow` (given `productionAction ≠ allow`). | `policy.js` lines 51–61 |
| `decide_blast_not_allow` | (d) Default policy: `blast ≥ 4` ⇒ `decide ≠ allow`. | `policy.js` lines 58–61 |
| `validate_eq_true_iff` | Helper: `validate tok now = true ↔ now ≤ tok.expiresAt`. | `broker.js` lines 46–52 |
| `validate_expired_forever` | (e) Monotonic expiry: `now > expiresAt` ⇒ `validate tok later = false` for every `later ≥ now`. | `broker.js` line 49 |
| `covers_of_invalid` | (f) `validate tok now = false` ⇒ `covers tok now tool = false` (covers re-validates). | `broker.js` lines 54–56 |
| `covers_of_star_scope` | (g) Valid token with `"*" ∈ scopes` ⇒ `covers` any tool. | `broker.js` line 58 |
| `evaluate_deny_of_bad_credential` | Gate composition: presented credential invalid ∨ not covering ⇒ final decision `deny`, for any assessment/policy. Proved by cases on the two failure branches. | `gate.js` lines 45–54 |

## Discrepancies and risks noticed

1. **Fail-open defaults for missing assessment fields** (`policy.js`
   lines 40–42). `decide` substitutes `'unknown'` for a missing
   environment, `0` for a missing `irreversibleProbability`, and `0` for a
   missing `blastRadius.score`. An empty assessment `{}` therefore sails
   through every rung and gets `allow` — the gate fails *open* on absent
   data rather than requiring confirmation. The Lean model's `Assessment`
   makes the fields mandatory, so this behaviour is a caller-side hazard,
   not visible in the model.

2. **The allowlist contains both `"production"` and `"unknown"`**
   (`policy.js` line 24). The environment rung (lines 70–73) can therefore
   never fire for production targets *or* for targets the provider failed
   to classify. Production safety rests entirely on rungs 2–4; combined
   with risk 1, a provider that returns no environment and no scores
   produces an unqualified `allow`.

3. **Strict vs non-strict threshold asymmetry** (`policy.js` lines 51, 58,
   63). The production and P(irreversible) rungs use strict `>`; the blast
   rung uses `>=`. Consequences at exact boundaries: `pIrr = 0.5` in
   production dodges rung 2 (different reason string) but is caught by
   rung 4 (`0.5 > 0.3`); `pIrr = 0.3` exactly is *allowed*; `blast = 4`
   exactly requires confirmation. A reader skimming the header comment
   ("above threshold") would likely expect uniform strictness.

4. **NaN is fail-open** (not representable in the model). If a provider
   returns `NaN` for `irreversibleProbability` or the blast score, every
   JS comparison involving it is `false`, so rungs 2–4 are skipped and a
   well-formed environment yields `allow`. The `Rat` model has no NaN;
   the JS code has no NaN guard.

5. **Float boundaries** (model uses exact `Rat`). `0.3` is not exactly
   representable as a double, and a provider computing "0.3" by another
   route can land one ulp above or below the threshold literal, flipping
   rung 4 at the boundary. The model's `3/10` is exact.

6. **Provider failure is an exception, not a decision** (`gate.js`
   lines 60–68). If the primary provider throws and `fallbackProvider` is
   `null`, `evaluate` *rethrows*: the caller gets no decision object and —
   because the audit write lives in `#finish` — no audit entry either.
   `execute` propagates the throw as well. The fallback call itself is
   unguarded, so a failing fallback also throws. Callers must treat
   rejection as a distinct outcome from `deny`. When the fallback *does*
   run, the decision is silently based on the heuristic provider's scores
   (only a reason string records the substitution).

7. **Credential stage is conditional** (`gate.js` lines 31, 45). It runs
   only if a broker was injected *and* `context.credential` is present.
   `createGate` always installs a broker, but `new BlastRadiusGate({
   provider })` — the documented minimal usage — performs no credential
   enforcement at all. The model's `cred = none` case covers both
   sub-cases indiscriminately.

8. **Double clock read in the credential stage** (`gate.js` line 46,
   `broker.js` line 55). `evaluate` calls `validate`, then `covers`
   re-calls `validate` with a fresh `now()`. The direction is fail-closed
   (either read can only add a deny), but validity is judged at two
   different instants; the model uses a single `now`. Boundary detail:
   the token is still valid at exactly `now == expiresAt` (strict `>`).

9. **Scope-matching edge cases** (`broker.js` lines 57–62). The prefix
   rule keeps the dot (`slice(0, -1)` on `"railway.*"` gives `"railway."`),
   so `"railwayx.delete"` is *not* covered — good. But scope `".*"` covers
   any tool starting with `"."`; a scope like `"railway*"` (no dot) is
   not a prefix pattern at all and matches only the literal tool
   `"railway*"`; an empty scope `""` matches only a tool named `""`.

10. **Override values are unvalidated** (`policy.js` lines 45–49). Any
    *truthy* value in `toolOverrides` is returned verbatim as the decision
    (e.g. `"sometimes"`), and falsy values (`""`, `0`) are silently
    ignored as if absent. The model restricts overrides to genuine
    `Decision`s via `Option Decision`. Mitigating factor: `execute`
    (`gate.js` line 109) treats anything other than exactly `'allow'` as
    non-executable, so a junk override is fail-closed at execution time —
    but `evaluate` still reports it as the decision. Note the ordering is
    safe in the other direction: overrides live inside `decide`, which
    runs *after* the credential stage, so an override can never rescue a
    bad credential (cf. `evaluate_deny_of_bad_credential`).

11. **Non-array allowlist silently disables rung 5** (`policy.js`
    line 70). The rung is guarded by `Array.isArray(...)`; a malformed
    policy file that sets `environmentAllowlist` to a non-array turns the
    environment check off entirely (fail-open) rather than erroring.
    Relatedly, `loadPolicy` (lines 28–36) replaces the allowlist and
    `toolOverrides` wholesale while merging thresholds per-key.

12. **`dryRunSummary` is less defensive than `decide`** (`gate.js`
    lines 16–27, 90–92). `decide` tolerates a missing `environment`
    (defaults to `'unknown'`), but when the decision is
    `require_confirmation`, `#finish` calls `dryRunSummary`, which
    dereferences `assessment.environment.choice` and `.confidence` with no
    optional chaining — an assessment without `environment` throws *after*
    the decision was computed, so the caller gets an exception instead of
    the confirmation prompt.

13. **Audit asymmetry in `execute`** (`gate.js` lines 106–115). The
    `execution` audit entry is appended only after the executor returns;
    if the executor throws, the log keeps the `evaluation` entry but no
    `execution` entry, so a crash mid-execution is indistinguishable from
    "never ran" in the log.

14. **Broad-scope tokens are advisory only** (`gate.js` lines 55–57,
    `broker.js` lines 24–25). A valid `"*"` token earns a warning reason
    but can still receive `allow`; the "no standing broad tokens"
    principle the broker exists to demonstrate is not enforced by the
    gate. (In the model this is exactly theorem (g): `"*"` covers
    everything.)

15. **Model gap — token store.** JS `validate` also rejects unknown and
    revoked token ids (`broker.js` lines 48, 70–72). The model factors
    that out (a presented credential is a known token record); the
    observable outcome is the same `deny` path, and
    `evaluate_deny_of_bad_credential` covers it whenever the token is
    invalid for *any* reason, but store dynamics (issue/revoke) are not
    themselves modelled.

---

## Post-review fix (2026-10-03)

Finding 1/3 above (fail-open defaults) is **fixed**. `decide()` in
`src/policy.js` now has a completeness rung directly under the per-tool
override: a missing environment, or an irreversibility / blast-radius
value that is missing or non-finite (`Number.isFinite` fails — including
NaN), returns `require_confirmation` instead of coercing to
`"unknown"`/`0` and falling through to `allow`. The override rung is
unchanged and still wins, including over an incomplete assessment
(it is explicit operator configuration, not provider output).

Supporting change: `dryRunSummary()` in `src/gate.js` now uses defensive
field access, because the new rung can produce `require_confirmation`
from a sparse assessment and the summary previously dereferenced
`assessment.environment.choice` unguarded (finding 6) and would have
thrown on exactly the path the fix creates.

Model: `Gate.lean` gained `decideChecked` (wrapper keyed on a `complete`
flag abstracting the presence/finiteness check) with
`decideChecked_incomplete` (incomplete ⇒ `require_confirmation`, by
`rfl`) and `decideChecked_allow_safe` (the allow-safety theorem is
preserved). Six regression tests in `test/gate.test.js` cover empty /
null / partially-missing / NaN assessments, override precedence, and
the gate-level sparse-provider path (22/22 tests pass; demo unchanged).
