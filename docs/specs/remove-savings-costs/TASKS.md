# Tasks: Remove Cost/Savings Calculator

> **STATUS: COMPLETE** — All tasks below have already been executed on `main`.

## Summary

The cost/savings calculator has been fully removed from the codebase. No further action is needed.

## Completed Tasks

### ✅ Task 1: Delete Model Pricing Module
- `server/src/db/model-pricing.ts` — deleted

### ✅ Task 2: Remove Migration Call
- `server/src/db/migrations.ts` — `applyModelPricing` import and call removed

### ✅ Task 3: Rewrite Analytics `/summary` Endpoint
- `server/src/routes/analytics.ts` — savings SQL, LEFT JOIN, `estimatedCostSavings`, `firstRequestAt` removed
- Active-provider filtering added (bonus)

### ✅ Task 4: Rewrite Analytics `/by-model` Endpoint
- `server/src/routes/analytics.ts` — cost SQL, LEFT JOIN, `display_name`, `estimatedCost` removed
- Active-provider filtering added (bonus)

### ✅ Task 5: Update Shared Types
- `shared/types.ts` — `estimatedCostSavings` removed from `AnalyticsSummary`

### ✅ Task 6: Update Client AnalyticsPage
- `client/src/pages/AnalyticsPage.tsx` — savings card, savings variables, "Saved" column removed
- Grid: `lg:grid-cols-6` → `lg:grid-cols-5`
- "Out tokens" header now has `pr-4` as last column

### ✅ Task 7: Update Server Tests
- `server/src/__tests__/routes/analytics.test.ts` — 4 savings test cases removed
- `insertTokensRequest` helper retained (used by active-provider tests)

### ✅ Task 8: Verify
- No remaining references to `estimatedCostSavings`, `estimatedCost`, `est_savings`, `est_cost`, `FALLBACK_INPUT`, `FALLBACK_OUTPUT`, `model-pricing`, `applyModelPricing`

## Open Items (for future consideration)

- [ ] Per-model table shows raw model IDs instead of display names — a lightweight display-name lookup could be added in a separate PR if the UX needs it
- [ ] Existing databases may still have `paid_input_per_m` and `paid_output_per_m` columns on the `models` table — these are harmless orphans and can be ignored
