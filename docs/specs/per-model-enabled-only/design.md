# Per-Model Breakdown: Show Only Enabled Models — Design

## Architecture Decision: Add LEFT JOIN + NULL-safe WHERE Clause

The current `/by-model` query has **no JOIN to the `models` table** — it only queries `requests r`. To filter by `models.enabled`, we must add a `LEFT JOIN models m` (needed to get the `enabled` column) and then a NULL-safe WHERE condition.

### Why LEFT JOIN, not INNER JOIN?

Using `INNER JOIN models m … AND m.enabled = 1` would:
1. **Exclude untracked models** (no `models` row → no JOIN match → row dropped). FR-6 requires untracked models stay visible.
2. Lose the ability to detect `m.enabled IS NULL` vs `m.enabled = 0`.

A `LEFT JOIN` preserves all request rows and lets us filter with a NULL-safe condition.

### Chosen condition

```sql
AND (m.enabled IS NULL OR m.enabled = 1)
```

| `m.enabled` value | Meaning | Included? |
|---|---|---|
| `1` | Model enabled | ✅ Yes |
| `0` | Model disabled | ❌ No |
| `NULL` | No models row (untracked) | ✅ Yes (FR-6) |

---

## Current SQL

```sql
SELECT
  r.platform,
  r.model_id,
  COUNT(*) as requests,
  SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
  AVG(r.latency_ms) as avg_latency_ms,
  SUM(r.input_tokens) as total_input_tokens,
  SUM(r.output_tokens) as total_output_tokens,
  SUM(CASE WHEN r.requested_model = r.model_id THEN 1 ELSE 0 END) as pinned_requests
FROM requests r
WHERE r.created_at >= ?
  ${pf.sql}
GROUP BY r.platform, r.model_id
ORDER BY requests DESC
```

## New SQL

```sql
SELECT
  r.platform,
  r.model_id,
  m.display_name,
  COUNT(*) as requests,
  SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
  AVG(r.latency_ms) as avg_latency_ms,
  SUM(r.input_tokens) as total_input_tokens,
  SUM(r.output_tokens) as total_output_tokens,
  SUM(CASE WHEN r.requested_model = r.model_id THEN 1 ELSE 0 END) as pinned_requests
FROM requests r
LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
WHERE r.created_at >= ?
  ${pf.sql}
  AND (m.enabled IS NULL OR m.enabled = 1)
GROUP BY r.platform, r.model_id
ORDER BY requests DESC
```

Changes:
1. Added `LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id`
2. Added `m.display_name` to SELECT (uses the model's display name if available, falls back to `model_id` in the mapper)
3. Added `AND (m.enabled IS NULL OR m.enabled = 1)` to WHERE

The response mapper now uses `m.display_name ?? r.model_id` for `displayName`:

```ts
res.json(rows.map(r => ({
  platform: r.platform,
  modelId: r.model_id,
  displayName: r.display_name ?? r.model_id,
  requests: r.requests,
  successRate: Math.round(r.success_rate * 10) / 10,
  avgLatencyMs: Math.round(r.avg_latency_ms),
  totalInputTokens: r.total_input_tokens ?? 0,
  totalOutputTokens: r.total_output_tokens ?? 0,
  pinnedRequests: r.pinned_requests ?? 0,
})));
```

## Bonus: Display Name

The `LEFT JOIN` also brings in `m.display_name` for free. If a model has a custom display name set in the `models` table, the per-model breakdown will now show it instead of the raw `model_id`. This is a non-breaking enhancement — when `display_name` is NULL, the mapper falls back to `model_id` (same as before).

## Files Changed

| File | Change |
|---|---|
| `server/src/routes/analytics.ts` | Add `LEFT JOIN models m`, `m.display_name` to SELECT, `AND (m.enabled IS NULL OR m.enabled = 1)` to WHERE, update mapper to use `display_name` |
| `server/src/__tests__/routes/analytics.test.ts` | Add `describe('disabled model filtering in by-model')` test block with 4+ new tests |

No other files change. No client changes. No schema changes.

## Interaction with Existing Specs

- **`analytics-filter`**: The `active_platforms` + `buildPlatformFilter` logic remains unchanged. The model-level `enabled` check is applied **after** the platform filter as an additional WHERE condition. The two filters compose naturally with AND.
- **`analytics-filter-disabled-models`**: This spec supersedes that earlier spec (same goals, updated to match the current codebase which no longer has the `LEFT JOIN models` in the query).

## Rollback

Remove the `LEFT JOIN` line, the `m.display_name` column, the `AND (m.enabled …)` condition, and revert the mapper. A 4-line revert in one file. No migration, no client change to undo.
