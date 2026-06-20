# Per-Model Breakdown: Show Only Enabled Models — Requirements

## Problem

The **Per-model breakdown** table on the Analytics page shows *every* model that has historical request rows in `requests`, including models the user has explicitly disabled (`models.enabled = 0`). This creates noise:

- A user disabled a flaky or deprecated model, but it still appears with stale request counts, dragging down success-rate and latency figures.
- The table mixes active and inactive models with no visual distinction — hard to focus on what matters right now.
- The existing `analytics-filter` spec already filters out inactive **providers** (platforms with no enabled keys/models). But within an *active* provider, individually disabled models still appear because the `/by-model` query only filters by platform, not by model-level `enabled`.

**Goal:** The Per-model breakdown must only show models that are currently **enabled** (`models.enabled = 1`). Disabled models are hidden from the table — not deleted from `requests`, just invisible in the analytics response.

## Stakeholders

| Role | Interest |
|---|---|
| Dashboard user | Wants a clean per-model table showing only models the router would actually use |
| Operator debugging | Needs to see only active models to trace routing decisions |
| Developer | Needs clear spec on what "enabled model" means and where the filter applies |

---

## Functional Requirements

### FR-1: By-model endpoint excludes disabled models

`GET /api/analytics/by-model` must exclude rows where the model is disabled in the `models` table (`models.enabled = 0`).

A model row is included only when **both** hold:

1. The model's **platform** is in the active set (already enforced by the `active_platforms` filter).
2. The model itself has `models.enabled = 1`.

A disabled model on an active platform (e.g. one disabled model among several enabled ones) is hidden from the breakdown.

### FR-2: No change to other analytics endpoints

Only `/by-model` is affected. The other five endpoints (`/summary`, `/by-platform`, `/timeline`, `/error-distribution`, `/errors`) count requests at the platform level and do not need model-level filtering. They remain unchanged.

### FR-3: Historical data preserved

Disabled models' request rows stay in the `requests` table untouched. They simply don't appear in the per-model breakdown. This is a visibility filter, not a data deletion.

### FR-4: Re-enable restores visibility

If a model is re-enabled (`UPDATE models SET enabled = 1`), its historical request data must immediately appear in the per-model breakdown on the next analytics fetch. No manual resync or cache clear needed.

### FR-5: Client unchanged

Filtering is server-side. The client (`AnalyticsPage.tsx`) renders whatever the API returns — no client-side filter logic or UI changes required.

### FR-6: Edge case — model unknown to models table

If a request row references a `model_id` that has **no matching row** in the `models` table (e.g. a custom or decommissioned model that was pruned), the query yields `NULL` for `m.enabled`. These untracked models should remain **visible** — they are not "disabled", they are simply untracked. Only rows where `m.enabled = 0` (explicitly disabled) are excluded.

---

## Non-Functional Requirements

### NFR-1: Performance

The additional `AND (m.enabled IS NULL OR m.enabled = 1)` condition is a simple column check on a row already JOINed. No new table scans or subqueries. Negligible performance impact.

### NFR-2: No schema changes

No database migrations. The `models.enabled` column already exists.

### NFR-3: No API contract changes

The response shape of `/by-model` is unchanged — some rows are simply absent.

### NFR-4: Consistency with active-provider filter

The model-level enabled check is **in addition to** the existing platform-level filter. Both are applied in the same query — no separate code path.

---

## Scope — What This Spec Does NOT Cover

- Filtering disabled models from `/error-distribution` or `/errors` (those show request-level data, not model breakdown).
- Adding a "Show disabled models" toggle to the client.
- Changing how the router selects models (that already uses `models.enabled`).
