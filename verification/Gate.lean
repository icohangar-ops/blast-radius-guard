/-
  Gate.lean — a formal model, in core Lean 4 only (no Mathlib, no lake),
  of the decision logic of blast-radius-guard:

    * `decide` / `decideCore` / `defaultPolicy`
        src/policy.js — `decide` (lines 39–79), `DEFAULT_POLICY` (lines 16–26)
    * `validate` / `covers` / `scopeCovers`
        src/broker.js — `CredentialBroker.validate` (lines 46–52),
        `CredentialBroker.covers` (lines 54–63)
    * `evaluate` / `evaluateWithToken`
        src/gate.js — `BlastRadiusGate.evaluate` (lines 40–73)

  Modelling choices (see NOTES.md for the full mapping and discrepancies):
    * Probabilities and the blast-radius score are exact rationals (`Rat`);
      the JavaScript code uses IEEE-754 doubles (0.5, 0.3, 4).
    * The per-tool override map is a `List (String × Decision)` looked up by
      exact tool name, mirroring the JS object `policy.toolOverrides`.
    * Token validity is time-only: the "unknown token" case of broker.js
      `validate` is factored out (a presented credential is a known token);
      expiry is `now ≤ expiresAt` because broker.js rejects only when
      `now() > expiresAt` (strict).
-/

namespace BlastRadiusGuard

/-- The three gate decisions: policy.js 'allow' | 'deny' |
    'require_confirmation'. -/
inductive Decision where
  | allow
  | deny
  | requireConfirmation
  deriving DecidableEq, Repr

/-- The fields of a provider assessment that `decide` reads
    (policy.js lines 40–42): environment name, P(irreversible), blast score.
    Missing JS fields default to 'unknown' / 0 / 0 there; here they are
    always present, so those defaults are the caller's responsibility. -/
structure Assessment where
  env : String
  pIrr : Rat
  blast : Rat

/-- A policy with the shape of policy.js `DEFAULT_POLICY` (lines 16–26). -/
structure Policy where
  productionAction : Decision
  productionIrreversibleProbability : Rat
  requireConfirmationIrreversibleProbability : Rat
  requireConfirmationBlastRadius : Rat
  environmentAllowlist : List String
  toolOverrides : List (String × Decision)

/-- policy.js lines 16–26, verbatim values:
    productionAction = 'require_confirmation', thresholds 0.5 / 0.3 / 4,
    allowlist [production, staging, development, unknown], no overrides. -/
def defaultPolicy : Policy where
  productionAction := .requireConfirmation
  productionIrreversibleProbability := 1 / 2
  requireConfirmationIrreversibleProbability := 3 / 10
  requireConfirmationBlastRadius := 4
  environmentAllowlist := ["production", "staging", "development", "unknown"]
  toolOverrides := []

/-- The threshold ladder of policy.js `decide`, lines 51–78, in the exact
    precedence of the source:
      2. env = 'production' ∧ P(irreversible) > 0.5  → productionAction
      3. blast ≥ 4                                   → require_confirmation
      4. P(irreversible) > 0.3                       → require_confirmation
      5. env ∉ allowlist                             → require_confirmation
      6. otherwise                                   → allow
    Note the asymmetry in the source: rules 2 and 4 are strict (`>`),
    rule 3 is non-strict (`>=`). -/
def decideCore (policy : Policy) (a : Assessment) : Decision :=
  if a.env = "production" ∧ policy.productionIrreversibleProbability < a.pIrr then
    policy.productionAction
  else if policy.requireConfirmationBlastRadius ≤ a.blast then
    .requireConfirmation
  else if policy.requireConfirmationIrreversibleProbability < a.pIrr then
    .requireConfirmation
  else if a.env ∉ policy.environmentAllowlist then
    .requireConfirmation
  else
    .allow

/-- policy.js `decide` (lines 39–79): rule 1 — a per-tool override, when
    present, wins over the whole ladder (lines 45–49). -/
def decide (policy : Policy) (a : Assessment) (tool : String) : Decision :=
  match policy.toolOverrides.lookup tool with
  | some d => d
  | none => decideCore policy a

/-! ### Theorems about `decide` -/

/-- (a) A per-tool override always wins (policy.js lines 45–49). -/
theorem decide_override (policy : Policy) (a : Assessment) (tool : String)
    (d : Decision) (h : policy.toolOverrides.lookup tool = some d) :
    decide policy a tool = d := by
  simp [decide, h]

/-- Helper for (b): when the production rule fires, `decideCore` returns
    exactly the policy's production action. -/
theorem decideCore_production_action (policy : Policy) (a : Assessment)
    (h1 : a.env = "production" ∧ policy.productionIrreversibleProbability < a.pIrr) :
    decideCore policy a = policy.productionAction := by
  unfold decideCore
  rw [ite_eq_left h1]

/-- (b) Production danger: with the default policy, a production call whose
    P(irreversible) exceeds 1/2 requires confirmation — it can never be
    silently allowed (default productionAction = require_confirmation, and
    the default policy has no overrides). -/
theorem decide_production_danger (a : Assessment) (tool : String)
    (henv : a.env = "production") (hp : (1 / 2 : Rat) < a.pIrr) :
    decide defaultPolicy a tool = .requireConfirmation := by
  have hcore := decideCore_production_action defaultPolicy a ⟨henv, hp⟩
  show decideCore defaultPolicy a = .requireConfirmation
  exact hcore

/-- Helper for (c): if `decideCore` allows, every rung of the ladder failed,
    for any policy whose production action is not `allow`. -/
theorem decideCore_allow_safe (policy : Policy) (a : Assessment)
    (hpa : policy.productionAction ≠ .allow)
    (h : decideCore policy a = .allow) :
    a.env ∈ policy.environmentAllowlist
      ∧ a.pIrr ≤ policy.requireConfirmationIrreversibleProbability
      ∧ a.blast < policy.requireConfirmationBlastRadius
      ∧ ¬ (a.env = "production" ∧ policy.productionIrreversibleProbability < a.pIrr) := by
  unfold decideCore at h
  by_cases h1 : a.env = "production" ∧ policy.productionIrreversibleProbability < a.pIrr
  · rw [ite_eq_left h1] at h
    exact absurd h hpa
  by_cases h2 : policy.requireConfirmationBlastRadius ≤ a.blast
  · rw [ite_eq_right h1, ite_eq_left h2] at h
    cases h
  by_cases h3 : policy.requireConfirmationIrreversibleProbability < a.pIrr
  · rw [ite_eq_right h1, ite_eq_right h2, ite_eq_left h3] at h
    cases h
  by_cases h4 : a.env ∈ policy.environmentAllowlist
  · exact ⟨h4, Rat.not_lt.mp h3, Rat.not_le.mp h2, h1⟩
  · rw [ite_eq_right h1, ite_eq_right h2, ite_eq_right h3, ite_eq_left h4] at h
    cases h

/-- (c) **Allow is safe** (default policy): if `decide` returns `allow`, then
    there was no override, the environment is on the allowlist,
    P(irreversible) ≤ 3/10, blast radius < 4, and the call is not a
    production call with P(irreversible) > 1/2.  In other words, `allow`
    is reachable only through the final rung of the ladder. -/
theorem decide_allow_safe (a : Assessment) (tool : String)
    (h : decide defaultPolicy a tool = .allow) :
    defaultPolicy.toolOverrides.lookup tool = none
      ∧ a.env ∈ defaultPolicy.environmentAllowlist
      ∧ a.pIrr ≤ 3 / 10
      ∧ a.blast < 4
      ∧ ¬ (a.env = "production" ∧ (1 / 2 : Rat) < a.pIrr) := by
  have hlookup : defaultPolicy.toolOverrides.lookup tool = none := rfl
  have hpa : defaultPolicy.productionAction ≠ .allow := by decide
  have hcore : decideCore defaultPolicy a = .allow := h
  obtain ⟨hmem, hp, hb, hprod⟩ := decideCore_allow_safe defaultPolicy a hpa hcore
  exact ⟨hlookup, hmem, hp, hb, hprod⟩

/-- Helper for (d): blast radius at/over threshold defeats `allow` in
    `decideCore`, for any policy whose production action is not `allow`. -/
theorem decideCore_ne_allow_of_blast (policy : Policy) (a : Assessment)
    (hpa : policy.productionAction ≠ .allow)
    (hb : policy.requireConfirmationBlastRadius ≤ a.blast) :
    decideCore policy a ≠ .allow := by
  intro h
  unfold decideCore at h
  by_cases h1 : a.env = "production" ∧ policy.productionIrreversibleProbability < a.pIrr
  · rw [ite_eq_left h1] at h
    exact hpa h
  · rw [ite_eq_right h1, ite_eq_left hb] at h
    cases h

/-- (d) Blast gate (default policy): blast radius ≥ 4 ⇒ decision ≠ allow,
    regardless of environment or P(irreversible). -/
theorem decide_blast_not_allow (a : Assessment) (tool : String)
    (hb : (4 : Rat) ≤ a.blast) :
    decide defaultPolicy a tool ≠ .allow := by
  have hpa : defaultPolicy.productionAction ≠ .allow := by decide
  intro h
  have hcore : decideCore defaultPolicy a = .allow := h
  exact decideCore_ne_allow_of_blast defaultPolicy a hpa hb hcore

/-! ### Credential broker model (src/broker.js) -/

/-- A broker token record, reduced to the fields `validate`/`covers` read
    (broker.js lines 26–44): its scope list and expiry instant (epoch ms in
    JS; an abstract `Int` clock here). -/
structure Token where
  scopes : List String
  expiresAt : Int

/-- broker.js `validate` (lines 46–52), time aspect only: a known token is
    invalid iff `now() > expiresAt` (strict), i.e. it is still valid at the
    exact expiry instant. -/
def validate (tok : Token) (now : Int) : Bool :=
  Decidable.decide (now ≤ tok.expiresAt)

theorem validate_eq_true_iff (tok : Token) (now : Int) :
    validate tok now = true ↔ now ≤ tok.expiresAt := by
  simp [validate]

/-- (e) Monotonic expiry: once expired, a token never becomes valid again. -/
theorem validate_expired_forever (tok : Token) {now later : Int}
    (h : now > tok.expiresAt) (hle : now ≤ later) :
    validate tok later = false := by
  cases hv : validate tok later with
  | false => rfl
  | true =>
      have hle' : later ≤ tok.expiresAt := (validate_eq_true_iff tok later).mp hv
      exact absurd hle' (by omega)

/-- One scope entry against one tool name (broker.js lines 57–62):
    `"*"` covers everything; an exact name match covers; a scope ending in
    `".*"` covers tools starting with the scope minus its last character
    (JS `scope.slice(0, -1)` — note the dot is kept, so `"railway.*"`
    requires the prefix `"railway."`). -/
def scopeCovers (scope tool : String) : Bool :=
  scope == "*" || scope == tool
    || (scope.endsWith ".*" && tool.startsWith (scope.dropEnd 1).toString)

/-- broker.js `covers` (lines 54–63): re-validates the token first — an
    invalid token covers nothing — then checks whether any scope covers
    the tool (JS `Array.prototype.some`). -/
def covers (tok : Token) (now : Int) (tool : String) : Bool :=
  validate tok now && tok.scopes.any fun s => scopeCovers s tool

/-- (f) An invalid (e.g. expired) token covers nothing — mirroring
    broker.js, where `covers` re-runs `validate` and returns `false`
    before ever looking at the scopes. -/
theorem covers_of_invalid (tok : Token) (now : Int) (tool : String)
    (h : validate tok now = false) :
    covers tok now tool = false := by
  simp [covers, h]

/-- (g) A `"*"` scope on a valid token covers every tool
    (broker.js line 58). -/
theorem covers_of_star_scope (tok : Token) (now : Int) (tool : String)
    (hv : validate tok now = true) (hstar : "*" ∈ tok.scopes) :
    covers tok now tool = true := by
  have hstarCovers : scopeCovers "*" tool = true := by simp [scopeCovers]
  unfold covers
  rw [hv, Bool.true_and]
  exact List.any_eq_true.mpr ⟨"*", hstar, hstarCovers⟩

/-! ### Gate composition (src/gate.js) -/

/-- The credential stage of gate.js `evaluate` (lines 45–58) for a presented
    credential: invalid → deny; valid but out of scope → deny; otherwise
    fall through to the policy decision.  (The broad-scope warning at
    lines 55–57 only appends a reason string and does not affect the
    decision, so it is not modelled.) -/
def evaluateWithToken (policy : Policy) (a : Assessment) (tool : String)
    (tok : Token) (now : Int) : Decision :=
  if validate tok now then
    if covers tok now tool then decide policy a tool else .deny
  else .deny

/-- gate.js `evaluate` (lines 40–73), decision aspect: the credential stage
    runs only when a broker exists and a credential is presented — modelled
    by `cred = some tok`; `cred = none` (no broker, or no credential in the
    context) skips straight to `decide`.  The provider stage (lines 60–68)
    is abstracted into the assessment `a`: on success some provider produced
    it, and the decision depends only on its fields. -/
def evaluate (policy : Policy) (a : Assessment) (tool : String)
    (cred : Option Token) (now : Int) : Decision :=
  match cred with
  | none => decide policy a tool
  | some tok => evaluateWithToken policy a tool tok now

/-- Gate composition theorem: a presented credential that is invalid **or**
    does not cover the tool forces `deny`, no matter what the assessment
    and policy would otherwise decide (gate.js lines 46–54 — the provider
    is not even consulted). -/
theorem evaluate_deny_of_bad_credential (policy : Policy) (a : Assessment)
    (tool : String) (tok : Token) (now : Int)
    (h : validate tok now = false ∨ covers tok now tool = false) :
    evaluate policy a tool (some tok) now = .deny := by
  show evaluateWithToken policy a tool tok now = .deny
  unfold evaluateWithToken
  cases h with
  | inl hv => simp [hv]
  | inr hc =>
      cases hv : validate tok now with
      | false => simp
      | true => simp [hc]

/-! ### Post-review fix (2026-10-03): the completeness gate

`decide` above models the threshold ladder. After this review, policy.js
gained a rung between the override and the ladder: an assessment whose
environment is missing, or whose irreversibility / blast-radius values are
missing or non-finite (NaN), returns `require_confirmation` instead of
falling through to `allow`. The model's `Assessment` always carries all
three fields as exact rationals, so the sparse/NaN cases are not
representable in it directly; the fix is modelled as a wrapper keyed on a
`complete` flag abstracting the JS finiteness/presence check. -/

/-- policy.js `decide` as of the 2026-10-03 fix: per-tool override first
    (inside `decide`), then the completeness gate, then the ladder. -/
def decideChecked (complete : Bool) (policy : Policy) (a : Assessment)
    (tool : String) : Decision :=
  if complete then decide policy a tool else .requireConfirmation

/-- An incomplete assessment is never allowed — and never denied either:
    it is escalated to a human, for every policy, assessment, and tool. -/
theorem decideChecked_incomplete (policy : Policy) (a : Assessment)
    (tool : String) :
    decideChecked false policy a tool = .requireConfirmation := rfl

/-- The fix preserves the safety theorem: under the default policy, an
    `allow` out of the checked decision still implies every safety
    condition of `decide_allow_safe` (which now additionally requires the
    assessment to have been complete). -/
theorem decideChecked_allow_safe (a : Assessment) (tool : String)
    (h : decideChecked true defaultPolicy a tool = .allow) :
    defaultPolicy.toolOverrides.lookup tool = none
      ∧ a.env ∈ defaultPolicy.environmentAllowlist
      ∧ a.pIrr ≤ 3 / 10
      ∧ a.blast < 4
      ∧ ¬ (a.env = "production" ∧ (1 / 2 : Rat) < a.pIrr) := by
  have h' : decide defaultPolicy a tool = .allow := h
  exact decide_allow_safe a tool h'

end BlastRadiusGuard
