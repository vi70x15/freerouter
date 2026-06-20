# Analytics Fallback-Config Consistency — Design

## Architecture Decision: Add LEFT JOIN models + LEFT JOIN fallback_config to All 6 Endpoints

The `/by-model` endpoint already has the correct JOINs and filters (from commit `3db0c29`):

```sql
LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
LEFT JOIN fallback_config fc ON fc.model_db_id = m.id
WHERE ...
  AND (m.enabled IS NULL OR m.enabled = 1)
  AND (fc.enabled IS NULL OR fc.enabled = 1)
```

The same pattern must be applied to the other 5 endpoints. Every endpoint must count only requests whose model is **routable** (enabled in both `models` and `fallback_config`), with NULL-safe conditions preserving untracked models.

## NULL-safe filtering logic

For each endpoint, after the existing platform filter (`${pf.sql}`), add:

```sql
AND (m.enabled IS NULL OR m.enabled = 1)
AND (fc.enabled IS NULL OR fc.enabled = 1)
```

This handles all cases:

| `m.enabled` | `fc.enabled` | Meaning | Included? |
|---|---|---|---|
| 1 | 1 | Model enabled + in fallback chain | ✅ Yes |
| 1 | 0 | Model enabled but disabled in fallback | ❌ No |
| 0 | any | Model disabled | ❌ No |
| NULL | NULL | No models row (untracked) | ✅ Yes (FR-7) |

---

## Helper: `buildModelEnabledFilter()`

A small helper that returns the JOIN + WHERE fragment, to avoid copy-pasting 3 lines into every endpoint:

```ts
/**
 * Returns the SQL fragments for the models + fallback_config enabled filter.
 * - joinSql: LEFT JOIN clauses to append after FROM requests r
 * - whereSql: AND conditions to append after ${pf.sql}
 * Both fragments are pure SQL with no bind params (the JOINs use m.id, no new params needed).
 */
function buildModelEnabledFilter(): { joinSql: string; whereSql: string } {
  return {
    joinSql: `LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id`,
    whereSql: `AND (m.enabled IS NULL OR m.enabled = 1)
      AND (fc.enabled IS NULL OR fc.enabled = 1)`,
  };
}
```

Since both JOINs are on indexed columns (`models` has a UNIQUE on `(platform, model_id)`, `fallback_config` has a UNIQUE on `model_db_id`), the join is fast and adds no bind params.

---

## Endpoint-by-Endpoint Changes

### 1. `GET /api/analytics/summary`

**Current SQL** (simplified):
```sql
SELECT
  COUNT(*) as total_requests,
  SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) as success_count,
  SUM(r.input_tokens) as total_input_tokens,
  SUM(r.output_tokens) as total_output_tokens,
  AVG(r.latency_ms) as avg_latency_ms,
  SUM(CASE WHEN r.requested_model IS NOT NULL THEN 1 ELSE 0 END) as pinned_count,
  SUM(CASE WHEN r.requested_model = r.model_id THEN 1 ELSE 0 END) as pin_honored_count
FROM requests r
WHERE r.created_at >= ?
  ${pf.sql}
```

**New SQL**:
```sql
SELECT
  COUNT(*) as total_requests,
  SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) as success_count,
  SUM(r.input_tokens) as total_input_tokens,
  SUM(r.output_tokens) as total_output_tokens,
  AVG(r.latency_ms) as avg_latency_ms,
  SUM(CASE WHEN r.requested_model IS NOT NULL THEN 1 ELSE 0 END) as pinned_count,
  SUM(CASE WHEN r.requested_model = r.model_id THEN 1 ELSE 0 END) as pin_honored_count
FROM requests r
${mf.joinSql}
WHERE r.created_at >= ?
  ${pf.sql}
  ${mf.whereSql}
```

Bind params unchanged — the model filter has no bind params.

### 2. `GET /api/analytics/by-model`

**Already fixed** in commit `3db0c29`. Refactor to use `buildModelEnabledFilter()` for consistency but no functional change.

### 3. `GET /api/analytics/by-platform`

**Current SQL** uses unaliased `requests` table (no `r.` alias). Must add `r` alias or use different join condition.

**Important:** The `by-platform` query currently doesn't use the `r.` alias — it selects `platform` directly. To add JOINs we need to alias `requests AS r`:

```sql
SELECT
  r.platform,
  COUNT(*) as requests,
  SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
  AVG(r.latency_ms) as avg_latency_ms,
  SUM(r.input_tokens) as total_input_tokens,
  SUM(r.output_tokens) as total_output_tokens
FROM requests r
${mf.joinSql}
WHERE r.created_at >= ?
  ${pf.sql}
  ${mf.whereSql}
GROUP BY r.platform
ORDER BY requests DESC
```

All column references must use `r.` prefix. Also change `buildPlatformFilter(active)` to `buildPlatformFilter(active, 'r')`.

### 4. `GET /api/analytics/timeline`

Same pattern: add `r` alias, `${mf.joinSql}`, `${mf.whereSql}`.

```sql
SELECT
  strftime('${dateFormat}', r.created_at) as timestamp,
  COUNT(*) as requests,
  SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) as success_count,
  SUM(CASE WHEN r.status = 'error' THEN 1 ELSE 0 END) as failure_count
FROM requests r
${mf.joinSql}
WHERE r.created_at >= ?
  ${pf.sql}
  ${mf.whereSql}
GROUP BY strftime('${dateFormat}', r.created_at)
ORDER BY timestamp ASC
```

Change `buildPlatformFilter(active)` to `buildPlatformFilter(active, 'r')`.

### 5. `GET /api/analytics/error-distribution`

All three internal queries need the same treatment. Add `r` alias, JOINs, WHERE filter, `r.` column prefixes.

Change `buildPlatformFilter(active)` to `buildPlatformFilter(active, 'r')` for all three.

### 6. `GET /api/analytics/errors`

Add `r` alias, JOINs, WHERE filter, `r.` column prefixes.

Change `buildPlatformFilter(active)` to `buildPlatformFilter(active, 'r')`.

---

## Files Changed

| File | Change |
|---|---|
| `server/src/routes/analytics.ts` | Add `buildModelEnabledFilter()` helper. Update all 6 endpoints per above. |
| `server/src/__tests__/routes/analytics.test.ts` | Add `insertFallbackConfig()` calls to all test setups missing them. Add cross-endpoint consistency tests. |

No other files change. No client changes. No schema changes.

## Rollback

Remove the helper, remove the JOIN/filter lines from each endpoint, revert to unaliased `requests` table in endpoints 3-6. Purely additive changes make rollback trivial.

## Interaction with Existing Specs

- **`analytics-filter`**: Platform-level filter unchanged. Model-level `fallback_config` filter is applied **after** the platform filter as additional WHERE conditions.
- **`per-model-enabled-only` (commit `3db0c29`)**: The `/by-model` fix was correct. This spec extends the same fix to the other 5 endpoints.
