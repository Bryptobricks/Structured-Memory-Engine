#!/usr/bin/env node
/**
 * Tests for v8.0 Synonym & Alias Expansion (Item 1)
 */
const { SYNONYM_MAP, mergeWithAliases, expandWithSynonyms, isSynonymOnlyMatch } = require('../lib/synonym-expansion');
const { DEFAULT_ALIASES } = require('../lib/retrieve');

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// ─── Test 1: "supplements" expands to include "stack", "nootropics" ───
console.log('Test 1: supplements expansion');
{
  const syns = SYNONYM_MAP['supplements'];
  assert(syns && syns.includes('stack'), '"supplements" should expand to "stack"');
  assert(syns && syns.includes('nootropics'), '"supplements" should expand to "nootropics"');
}

// ─── Test 2: "girlfriend" expands to include "parri", "partner" ───
console.log('Test 2: girlfriend expansion');
{
  const syns = SYNONYM_MAP['girlfriend'];
  assert(syns && syns.includes('parri'), '"girlfriend" should expand to "parri"');
  assert(syns && syns.includes('partner'), '"girlfriend" should expand to "partner"');
}

// ─── Test 3: mergeWithAliases deduplicates correctly ───
console.log('Test 3: mergeWithAliases deduplication');
{
  const aliases = { 'stack': ['supplement', 'protocol'] };
  const synonyms = { 'stack': ['supplement', 'nootropics', 'regimen'] };
  const merged = mergeWithAliases(aliases, synonyms);
  assert(merged['stack'].includes('supplement'), 'Should include "supplement"');
  assert(merged['stack'].includes('protocol'), 'Should keep original alias "protocol"');
  assert(merged['stack'].includes('nootropics'), 'Should add new synonym "nootropics"');
  assert(merged['stack'].includes('regimen'), 'Should add new synonym "regimen"');
  // No duplicates
  const dupes = merged['stack'].filter(t => t === 'supplement');
  assert(dupes.length === 1, `"supplement" should appear exactly once, got ${dupes.length}`);
}

// ─── Test 4: mergeWithAliases adds new keys ───
console.log('Test 4: mergeWithAliases adds new keys');
{
  const aliases = { 'existing': ['a', 'b'] };
  const synonyms = { 'newkey': ['x', 'y'] };
  const merged = mergeWithAliases(aliases, synonyms);
  assert(merged['existing'] != null, 'Should keep existing key');
  assert(merged['newkey'] != null, 'Should add new key');
  assert(merged['newkey'].includes('x'), 'New key should have synonym values');
}

// ─── Test 5: expandWithSynonyms tracks original vs synonym terms ───
console.log('Test 5: expandWithSynonyms tracking');
{
  const { originalTerms, synonymOnlyTerms } = expandWithSynonyms(['supplements', 'daily'], SYNONYM_MAP);
  assert(originalTerms.has('supplements'), 'Original terms should include "supplements"');
  assert(originalTerms.has('daily'), 'Original terms should include "daily"');
  assert(synonymOnlyTerms.has('stack'), 'Synonym-only terms should include "stack"');
  assert(!synonymOnlyTerms.has('supplements'), '"supplements" is original, not synonym-only');
}

// ─── Test 6: isSynonymOnlyMatch — direct match returns false ───
console.log('Test 6: isSynonymOnlyMatch — direct match');
{
  const content = 'I take supplements daily including creatine';
  const origTerms = new Set(['supplements', 'daily']);
  assert(!isSynonymOnlyMatch(content, origTerms), 'Content with original terms should NOT be synonym-only');
}

// ─── Test 7: isSynonymOnlyMatch — synonym-only returns true ───
console.log('Test 7: isSynonymOnlyMatch — synonym only');
{
  const content = 'Current Stack: creatine 5g, vitamin D 5000IU';
  const origTerms = new Set(['supplements', 'daily']);
  assert(isSynonymOnlyMatch(content, origTerms), 'Content without original terms should be synonym-only match');
}

// ─── Test 8: User aliases.json overrides take precedence ───
console.log('Test 8: User aliases override precedence');
{
  // Simulate: user aliases.json defines 'supplements' differently
  const userAliases = { 'supplements': ['vitamins', 'pills'] };
  // DEFAULT_ALIASES has 'supplement' → ['stack', 'protocol', 'nootropic']
  // User aliases replace the key entirely (as designed in loadAliases)
  const merged = mergeWithAliases(userAliases, SYNONYM_MAP);
  // SYNONYM_MAP adds to user aliases (not replaces)
  assert(merged['supplements'].includes('vitamins'), 'User alias values should be preserved');
  assert(merged['supplements'].includes('stack'), 'Synonym values should be merged in');
}

// ─── Test 9: portfolio expansion ───
console.log('Test 9: portfolio expansion');
{
  const syns = SYNONYM_MAP['portfolio'];
  assert(syns && syns.includes('holdings'), '"portfolio" should expand to "holdings"');
  assert(syns && syns.includes('allocation'), '"portfolio" should expand to "allocation"');
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
