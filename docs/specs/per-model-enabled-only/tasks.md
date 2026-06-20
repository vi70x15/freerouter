# Analytics Fallback-Config Consistency — Tasks

> **Branch:** `fix/analytics-fallback-consistency`
> **Touch:** `server/src/routes/analytics.ts` + `server/src/__tests__/routes/analytics.test.ts`
> **Do NOT touch:** client code, other server routes, DB migrations

---

## Staging Bug

After commit `3db0c29`, the `/by-model` endpoint filters by `fallback_config.enabled` but the other 5 endpoints don't. Result: summary shows 7076 total requests but by-model only sums to 5012. The 2064 missing requests belong to models disabled in the fallback tab.

---

## Task 1: Add `buildModelEnabledFilter()` helper

**File:** `server/src/routes/analytics.ts`

Add after `buildPlatformFilter()` (around line 52):

```ts
/**
 * Returns the SQL fragments for the models + fallback_config enabled filter.
 * Appends LEFT JOINs to requests r and AND conditions to the WHERE clause.
 * No bind params — the JOINs link via m.id, not user input.
 */
function buildModelEnabledFilter() {
  return {
    joinSql: `LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
      LEFT JOIN fallback_config fc ON fc.model_db_id = m.id`,
    whereSql: `AND (m.enabled IS NULL OR m.enabled = 1)
      AND (fc.enabled IS NULL OR fc.enabled = 1)`,
  };
}
```

**Verification:** TypeScript compiles. Helper is not yet called.

---

## Task 2: Update `GET /api/analytics/summary`

Add model-enabled filter to the summary query:

```ts
const mf = buildModelEnabledFilter();
```

SQL changes:
- Add `${mf.joinSql}` after `FROM requests r`
- Add `${mf.whereSql}` after `${pf.sql}`

No bind param changes — the model filter has no params.

**Verification:** Summary total should now match by-model sum.

---

## Task 3: Refactor `GET /api/analytics/by-model`

Replace the inline `LEFT JOIN models` + `LEFT JOIN fallback_config` + `AND` conditions with the helper:

```ts
const mf = buildModelEnabledFilter();
```

Then use `${mf.joinSql}` and `${mf.whereSql}` in the SQL.

Keep `m.display_name` in SELECT — it comes from the same `LEFT JOIN models m` that the helper provides. The function is identical; just uses the helper for DRY.

---

## Task 4: Update `GET /api/analytics/by-platform`

This endpoint currently uses unaliased `requests` (no `r.`). Must refactor:

1. Change `FROM requests` → `FROM requests r`
2. Prefix all column references with `r.`: `r.platform`, `r.status`, `r.latency_ms`, `r.input_tokens`, `r.output_tokens`, `r.created_at`
3. Change `buildPlatformFilter(active)` → `buildPlatformFilter(active, 'r')`
4. Add `const mf = buildModelEnabledFilter();`
5. Add `${mf.joinSql}` after `FROM requests r`
6. Add `${mf.whereSql}` after `${pf.sql}`

**Verification:** by-platform only counts traffic from fallback-enabled models.

---

## Task 5: Update `GET /api/analytics/timeline`

Same pattern as Task 4:

1. `FROM requests` → `FROM requests r`
2. Prefix all columns with `r.`
3. `buildPlatformFilter(active)` → `buildPlatformFilter(active, 'r')`
4. Add `const mf = buildModelEnabledFilter();`
5. Add `${mf.joinSql}` + `${mf.whereSql}`

**Verification:** Timeline only counts fallback-enabled traffic.

---

## Task 6: Update `GET /api/analytics/error-distribution`

All three internal queries need the same treatment:

1. `FROM requests` → `FROM requests r`
2. Prefix columns with `r.`
3. `buildPlatformFilter(active)` → `buildPlatformFilter(active, 'r')` for all three
4. Add `const mf = buildModelEnabledFilter();` before the queries
5. Add `${mf.joinSql}` + `${mf.whereSql}` to each query

**Verification:** Error distribution only counts fallback-enabled models' errors.

---

## Task 7: Update `GET /api/analytics/errors`

Same pattern:

1. `FROM requests` → `FROM requests r`
2. Prefix columns with `r.`
3. `buildPlatformFilter(active)` → `buildPlatformFilter(active, 'r')`
4. Add `const mf = buildModelEnabledFilter();`
5. Add `${mf.joinSql}` + `${mf.whereSql}`

**Verification:** Recent errors only shows fallback-enabled models.

---

## Task 8: Update existing tests

**File:** `server/src/__tests__/routes/analytics.test.ts`

The test file already has `insertFallbackConfig()` helper (from commit `3db0c29`).

### 8a. Ensure all test models have fallback_config rows

The parent `beforeEach` already seeds fallback rows for `test`, `groq`, `custom` platforms and clears `fallback_config`. Verify all existing tests still pass after the 6-endpoint change.

### 8b. Add fallback-disabled models to the `active provider filtering` describe block

Some tests in the `active provider filtering` block insert models without fallback rows. Since `fc.enabled IS NULL` passes the filter (untracked models are included), this should still work — but adding explicit `insertFallbackConfig` calls makes the tests more realistic and catches edge cases.

For each `insertModel` in the active-provider-filtering tests, add a corresponding `insertFallbackConfig(platform, modelId, 1)`.

### 8c. Add cross-endpoint consistency test

Add a new test in the `disabled model filtering in by-model` block:

```
'by-model request counts match summary total'
```

Setup:
- `insertKey('cons', 1)`
- `insertModel('cons', 'fc-on', 1)` + `insertFallbackConfig('cons', 'fc-on', 1)`
- `insertModel('cons', 'fc-off', 1)` + `insertFallbackConfig('cons', 'fc-off', 0)`
- Insert 10 requests for `fc-on`, 5 requests for `fc-off`

Assert:
- `byModel` has 1 row (fc-on with 10 requests)
- `summary.totalRequests === 10` (not 15)
- `byPlatform` has 1 row for `cons` with 10 requests

---

## Task 9: Broader regression check

```bash
npm run test -w server -- --run
```

All 663+ tests must pass. Watch for failures in:
- `analytics.test.ts` — primary
- `full-flow.test.ts` — integration

---

## Task 10: Smoke test against real DB

```bash
npm run dev
```

1. Open the Analytics tab → summary total should match by-model sum.
2. Verify that by-platform, timeline, and error-distribution counts are also reduced (they no longer include fallback-disabled model traffic).
3. The numbers across all panels should be consistent.

---

## Acceptance Checklist

- [ ] All 6 analytics endpoints filter by `fallback_config.enabled`
- [ ] Summary total matches by-model request sum (within untracked-model tolerance)
- [ ] By-platform counts consistent with by-model
- [ ] `buildModelEnabledFilter()` helper used consistently
- [ ] Existing 19 analytics tests pass
- [ ] New cross-endpoint consistency test passes
- [ ] Full server test suite passes
- [ ] Client `AnalyticsPage.tsx` is **not modified**
- [ ] No DB schema changes
