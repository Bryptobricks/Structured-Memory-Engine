# SME v6.10.1 Bug Fix Spec

**Version:** 6.10.0 → 6.10.1
**Priority:** Ship before public launch (March 3)
**Test requirement:** All 990 existing tests must pass + new tests for each fix

---

## Bug 1: Double-tag in `remember` (P0)

**File:** `lib/remember.js`

**Issue:** When the `tag` parameter is passed AND the content string already starts with `[tag]`, the output becomes `[fact] [fact] content...`. The tag is prepended unconditionally.

**Fix:** Before prepending `[${tag}]`, check if `content` already matches `/^\[${tag}\]/i`. If it does, skip the prepend.

**Tests:**
- `sme.remember("test", { tag: "fact" })` → writes `[fact] test`
- `sme.remember("[fact] test", { tag: "fact" })` → writes `[fact] test` (NOT `[fact] [fact] test`)
- `sme.remember("[decision] changed plan", { tag: "fact" })` → writes `[fact] [decision] changed plan` (different tags, prepend is correct)

---

## Bug 2: Entity extraction noise (P0)

**File:** `lib/entities.js`

**Issue:** Common words in ALL-CAPS or title-case get extracted as entities: "WHAT", "NEVER", "TBD", "TODO", "NOTE", etc. These pollute the entity graph and degrade co-occurrence analysis.

**Fix:**
1. Add a `STOP_ENTITIES` Set at the top of the file
2. Filter extracted entities against it before returning
3. Also filter any entity that is ≤2 characters

**Stoplist:**
```js
const STOP_ENTITIES = new Set([
  'what', 'never', 'tbd', 'todo', 'note', 'important', 'warning',
  'critical', 'updated', 'fixed', 'done', 'none', 'yes', 'no',
  'true', 'false', 'n/a', 'na', 'ok', 'all', 'any', 'new', 'old',
  'now', 'how', 'why', 'when', 'where', 'who', 'the', 'and', 'but',
  'not', 'for', 'with', 'this', 'that', 'from', 'also', 'only',
  'just', 'still', 'even', 'very', 'most', 'some', 'each', 'both',
  'such', 'status', 'issue', 'closed', 'open', 'pending', 'blocked',
  'added', 'removed', 'changed', 'started', 'completed', 'planned'
]);
```

**Filter logic:** Normalize entity to lowercase before checking against stoplist. Apply filter after all extraction passes.

**Tests:**
- Index a file containing `"NEVER do this, TODO for later, TBD on timing"` — none of these should appear in entity graph
- Index a file containing `"Josh met with Sarah at Google"` — Josh, Sarah, Google should all appear
- Entities ≤2 chars (e.g., "AI") — keep these? Decision: YES, keep 2-char entities that are in the existing graph. Only filter ≤1 char.

**Correction:** Filter entities ≤1 char, not ≤2. "AI", "ML", "BTC", "ETH" are all valid 2-3 char entities.

---

## Bug 3: Entity privacy controls (P1)

**Files:** `lib/entities.js` + `lib/config.js`

**Issue:** Entity graph can expose personal information via co-occurrence (e.g., real name linked to username). Users need a way to exclude sensitive entities.

**Fix:**
1. Add `entityExclude: []` to config schema in `lib/config.js` (array of strings or regex patterns)
2. In entity extraction, after all passes, filter out any entity matching an exclude entry
3. String entries = exact match (case-insensitive). Entries wrapped in `/` = regex.

**Config example:**
```json
{
  "entityExclude": ["josh", "joshua", "/burke/i"]
}
```

**Tests:**
- With `entityExclude: ["josh"]`, indexing a file with "Josh went to Denver" → "josh" should NOT appear in entity graph
- With `entityExclude: ["/burke/i"]`, "Joshua Burke" → "burke" filtered, "joshua" filtered only if also in list
- Empty `entityExclude` (default) → no filtering, backward compatible

---

## Bug 4: Contradiction detection false positives (P1)

**File:** `lib/reflect.js` (contradiction detection section)

**Issue:** Same generic section headings ("Decisions", "Claude Code", "Status") appearing across different files trigger false contradiction flags. The system sees overlapping text and flags it, but it's just common headings.

**Fix:** Before flagging a contradiction, apply these heuristic guards:
1. If overlapping text is ≤10 words AND starts with `#` or `**` → skip (heading match, not content)
2. If overlapping text is a common section heading (maintain a small list: "Decisions", "Status", "Notes", "TODO", "Progress", "Issues", "Context") → skip
3. If both chunks come from different files AND the similarity is driven primarily by structural text (headings, bullet prefixes) rather than content → skip

**Tests:**
- Two files each with `## Decisions` section containing different decisions → NOT flagged
- Two files with genuinely contradictory content (e.g., "budget is $5000" vs "budget is $3000") → correctly flagged
- Same file with contradictory content in different sections → correctly flagged

---

## Bug 5: Duplicated retrieval logic (P1)

**Files:** `lib/recall.js` + `lib/context.js`

**Issue:** Both files implement ~60% overlapping retrieval logic with subtle divergences. Fixes applied to one don't automatically propagate to the other. This is how the v6.9.0 bugs happened — the always-OR FTS fix had to be applied in both places.

**Fix:** Extract shared retrieval into a common module:
1. Create `lib/retrieve.js` (or add to existing shared module)
2. Move the core retrieval pipeline there: FTS query → semantic search → merge → score → rank → rescue pass
3. `recall.js` and `context.js` both call the shared pipeline, then apply their own post-processing (recall returns raw results, context applies token budgeting and formatting)

**Key constraint:** Don't break the existing APIs. `recall()` and `context()` should behave identically to current versions. This is a refactor, not a behavior change.

**Tests:** All existing recall and context tests must pass unchanged. Add a test that patches the shared retrieval and confirms both `recall()` and `context()` pick up the change.

---

## Bug 6: Silent catch blocks (P2)

**Files:** Multiple (45 instances across codebase)

**Issue:** 45 `catch (_) {}` blocks silently swallow errors. At scale, this makes debugging impossible — errors vanish without a trace.

**Fix:**
1. Audit all 45 catch blocks
2. Replace empty catches with `catch (err) { console.debug('[sme]', err.message); }` minimum
3. For catches that are genuinely expected (e.g., file-not-found on optional config), add a comment explaining why the catch is intentional
4. For catches that mask real errors, add proper error handling

**This can be a separate commit/PR.** Don't let it block the other fixes.

---

## Bug 7 (Investigate): Temporal query edge case

**Issue:** CC reports that querying "What happened on February 23?" on v6.10.0 returned Feb 20 content instead of Feb 23. This may have been fixed by v6.9.0 rescue ordering, or it may be a workspace config issue in CC's test environment.

**Before fixing:** Reproduce it.
1. Run `sme status` in the test workspace — confirm the Feb 23 file is indexed
2. Run the query with `--debug` flag to see scoring breakdown
3. If the Feb 23 file IS indexed and still loses, there's a real bug in temporal scoring
4. If it's NOT indexed, it's a config issue (missing glob pattern)

**Do not spec a fix until reproduction confirms it's a real bug.**

---

## Version & Publish

- Bump `package.json` version: `6.10.0` → `6.10.1`
- After all tests pass, commit with message: `fix: entity noise, double-tag, privacy controls, contradiction FP, retrieval dedup (v6.10.1)`
- Do NOT publish to npm — I'll handle that separately with a fresh token

---

## File Summary

| Bug | File(s) | Priority | Est. Effort |
|-----|---------|----------|-------------|
| 1. Double-tag | `lib/remember.js` | P0 | 5 min |
| 2. Entity noise | `lib/entities.js` | P0 | 15 min |
| 3. Privacy controls | `lib/entities.js` + `lib/config.js` | P1 | 30 min |
| 4. Contradiction FP | `lib/reflect.js` | P1 | 30 min |
| 5. Retrieval dedup | `lib/recall.js` + `lib/context.js` → `lib/retrieve.js` | P1 | 1-2 hr |
| 6. Silent catches | Multiple | P2 | 1 hr |
| 7. Temporal edge | Investigate first | P2 | TBD |
