# 7. BYOK and managed AI keys, credits, and the Jev decision chain

Status: Accepted. Recorded retroactively from the code comments cited below; where the code does not say why, the text says "Rationale not recorded".

## Context

`src/lib/managed-ai-policy.ts` (pricing v2) states the rule: every plan includes a monthly allowance on Orbit's own provider keys, metered in credits (`src/lib/credits/`) and drawn from shared pools; an account may also save its own key, and calls on its own key never use credits. `MANAGED_AI_ENABLED` is a code constant (true) so no deployment flips the model by accident; `ORBIT_MANAGED_AI=off` and the admin pause (`site_settings.managed_ai_paused`) stop it without a deploy. `src/lib/ai-access.ts` is the only file allowed to hold a key. The comment in `src/lib/decisions/engine.ts` defines the chain for decisions: Jev (TypeSafe's classifier, ~200 ms, BYOK only) when the account has a key, then the account's own chat model if the decision's policy allows it, then the call site's deterministic rule, which is always last and never throws.

## Decision

Key selection and metering are decided in one place (`ai-access.ts`, with pure policy in `managed-ai-policy.ts`). Every model call goes through `completeJson` / `completeMultimodalJson` in `src/lib/ai.ts`, which write `usage_events`. Decisions go through `decide()` in `src/lib/decisions/`. Only `src/lib/ai*.ts` may import provider SDKs.

## Consequences

- A fresh or restored database reads included AI as paused in production until an admin turns it on (`managedAiPausedDefault`).
- `GEMINI_API_KEY`, `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` count as Orbit-paid keys anywhere `VERCEL` is unset.
- Without a TypeSafe key the chain starts at the LLM or the rule; Jev is an accelerator, not a dependency.
- Provider budgets cap total managed spend regardless of per-account credits.

## Revisit when

When pricing changes again or a provider is added or removed.
