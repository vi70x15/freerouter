# Analytics Fallback-Config Consistency — Requirements

## Problem

Commit `3db0c29` fixed the `/by-model` endpoint to check `fallback_config.enabled` (not just `models.enabled`), matching how users actually disable models. This was correct — but it **broke cross-endpoint consistency** on staging:

| Endpoint | What it filters | Result |
|---|---|---|
| `/summary` | Active platforms only (by `api_keys.enabled` + `models.enabled`) | **7076 requests** |
| `/by-model` | Active platforms + `fallback_config.enabled = 1` | **5012 requests** |
| `/by-platform` | Active platforms only | Includes all platform traffic |
| `/timeline` | Active platforms only | Includes all platform traffic |
| `/error-distribution` | Active platforms only | Includes all platform traffic |
| `/errors` | Active platforms only | Includes all platform traffic |

The summary says 7076 total requests, but the by-model table only sums to 5012. The remaining 2064 requests belong to models disabled in the fallback tab — counted in summary but invisible in by-model. **This is the staging breakage.**

## Root Cause

The analytics endpoints filter at two levels:

1. **Platform level** — "is this provider active?" (has enabled keys + enabled models). Implemented by `getActivePlatforms()` + `buildPlatformFilter()`. Used by all 6 endpoints.
2. **Model level** — "is this specific model in the routing chain?" (fallback_config.enabled = 1). Currently only used by `/by-model`.

The router (`routeRequest()` in `server/src/services/router.ts`) only sends traffic to models where **both** `m.enabled = 1 AND fc.enabled = 1`. So analytics should reflect the same reality — if the router won't route to a model, that model's historical traffic is noise in analytics.

## Goal

All 6 analytics endpoints must filter by the same definition of "active": **requests are only counted if they belong to a model that is both `models.enabled = 1` AND `fallback_config.enabled = 1`** (or is untracked — no models row at all).

After the fix, the sum of per-model requests must equal the summary total (barring untracked models, which are a rare edge case), and all charts/tables are consistent.

## Stakeholders

| Role | Interest |
|---|---|
| Dashboard user | Sees consistent numbers between summary cards and per-model breakdown |
| Operator | Can trust that analytics reflects what the router would actually use |
| Developer | Needs clear spec on where fallback_config filter applies |

---

## Functional Requirements

### FR-1: Summary endpoint counts only fallback-enabled models

`GET /api/analytics/summary` must only count requests where the model is both `models.enabled = 1` and `fallback_config.enabled = 1`. Requests to fallback-disabled models are excluded from:
- `totalRequests`
- `successRate`
- `totalInputTokens`, `totalOutputTokens`
- `avgLatencyMs`
- `pinnedRequests`, `pinHonoredRequests`

### FR-2: By-platform endpoint counts only fallback-enabled models

`GET /api/analytics/by-platform` must only count requests where the model is fallback-enabled. A platform's aggregate counts only reflect traffic to models the router would actually use.

### FR-3: Timeline endpoint counts only fallback-enabled models

`GET /api/analytics/timeline` must only count requests where the model is fallback-enabled. Success/failure buckets only reflect routable traffic.

### FR-4: Error-distribution endpoint counts only fallback-enabled models

`GET /api/analytics/error-distribution` must exclude errors from fallback-disabled models in all three sub-responses.

### FR-5: Errors endpoint counts only fallback-enabled models

`GET /api/analytics/errors` must exclude error rows from fallback-disabled models.

### FR-6: By-model endpoint unchanged

`GET /api/analytics/by-model` already checks `fallback_config.enabled`. No changes needed — the fix from `3db0c29` is correct.

### FR-7: Untracked models preserved

If a request row references a `model_id` with **no matching row** in the `models` table (both JOINs yield NULL), it must still appear in analytics. These are untracked models, not disabled ones. The NULL-safe conditions `(m.enabled IS NULL OR m.enabled = 1) AND (fc.enabled IS NULL OR fc.enabled = 1)` already handle this correctly.

### FR-8: Client unchanged

Filtering is server-side. The client renders whatever the API returns.

---

## Non-Functional Requirements

### NFR-1: Shared helper

The `fallback_config` JOIN + filter should be implemented as a shared helper or pattern, not copy-pasted into each endpoint. The existing `getActivePlatforms()` + `buildPlatformFilter()` pattern is the model.

### NFR-2: Performance

The `LEFT JOIN fallback_config fc ON fc.model_db_id = m.id` + NULL-safe filter adds one JOIN per query. `fallback_config` is small (one row per model). Negligible performance impact.

### NFR-3: No schema changes

No database migrations. Both `models.enabled` and `fallback_config.enabled` already exist.

### NFR-4: No API contract changes

Response shapes are identical. Some rows/values are simply absent.

---

## Scope — What This Spec Does NOT Cover

- Adding a "Show disabled models" toggle to the client.
- Changing how the router selects models.
- Changing the `getActivePlatforms()` definition.
