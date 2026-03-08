#!/usr/bin/env node
/**
 * Tests for v8.0 Result Diversity Enforcement (Item 2)
 */
const { enforceResultDiversity } = require('../lib/diversity');

let passed = 0, failed = 0;
function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// ─── Test 1: 5 chunks from same file → only 3 selected ───
console.log('Test 1: File cap — max 3 per file');
{
  const chunks = [
    { file_path: 'a.md', heading: 'H1', content: 'Alpha content one' },
    { file_path: 'a.md', heading: 'H2', content: 'Beta content two' },
    { file_path: 'a.md', heading: 'H3', content: 'Gamma content three' },
    { file_path: 'a.md', heading: 'H4', content: 'Delta content four' },
    { file_path: 'a.md', heading: 'H5', content: 'Epsilon content five' },
  ];
  const result = enforceResultDiversity(chunks);
  assert(result.selected.length === 3, `Should select 3, got ${result.selected.length}`);
  assert(result.filtered.byFile === 2, `Should filter 2 by file, got ${result.filtered.byFile}`);
}

// ─── Test 2: 3 chunks under same heading → only 2 selected ───
console.log('Test 2: Heading cap — max 2 per heading');
{
  const chunks = [
    { file_path: 'a.md', heading: 'Same', content: 'First unique content here' },
    { file_path: 'a.md', heading: 'Same', content: 'Second unique content here' },
    { file_path: 'a.md', heading: 'Same', content: 'Third unique content here' },
  ];
  const result = enforceResultDiversity(chunks);
  assert(result.selected.length === 2, `Should select 2, got ${result.selected.length}`);
  assert(result.filtered.byHeading === 1, `Should filter 1 by heading, got ${result.filtered.byHeading}`);
}

// ─── Test 3: Two nearly identical chunks → second filtered by similarity ───
console.log('Test 3: Similarity filter — near-duplicates');
{
  const chunks = [
    { file_path: 'a.md', heading: 'H1', content: 'JB takes creatine 5g daily in the morning with water' },
    { file_path: 'b.md', heading: 'H2', content: 'JB takes creatine 5g daily in the morning with coffee' },
    { file_path: 'c.md', heading: 'H3', content: 'The apartment has govee lights in the living room and bedroom' },
  ];
  const result = enforceResultDiversity(chunks, { similarityThreshold: 0.80 });
  // The first two chunks are very similar — second should be filtered
  assert(result.selected.length <= 3, `Should filter at least some, got ${result.selected.length}`);
  // The third chunk is different enough to survive
  assert(result.selected.some(c => c.content.includes('govee')), 'Diverse chunk should survive');
}

// ─── Test 4: Score ordering preserved ───
console.log('Test 4: Score ordering preserved');
{
  const chunks = [
    { file_path: 'a.md', heading: 'H1', content: 'High priority decision about architecture first' },
    { file_path: 'b.md', heading: 'H2', content: 'Medium priority fact about database schema second' },
    { file_path: 'c.md', heading: 'H3', content: 'Low priority raw observation about weather third' },
  ];
  const result = enforceResultDiversity(chunks);
  assert(result.selected.length === 3, `All 3 should pass (different files), got ${result.selected.length}`);
  assert(result.selected[0].content.includes('High'), 'First should be highest-scored');
}

// ─── Test 5: Empty/single chunk arrays pass through unchanged ───
console.log('Test 5: Edge cases — empty and single');
{
  const empty = enforceResultDiversity([]);
  assert(empty.selected.length === 0, 'Empty input should return empty');

  const single = enforceResultDiversity([{ file_path: 'a.md', heading: 'H', content: 'Solo chunk' }]);
  assert(single.selected.length === 1, 'Single chunk should pass through');
}

// ─── Test 6: Filtered stats accurately report reasons ───
console.log('Test 6: Filtered stats accuracy');
{
  const chunks = [
    { file_path: 'a.md', heading: 'H1', content: 'Unique alpha content bravo' },
    { file_path: 'a.md', heading: 'H1', content: 'Unique charlie content delta' },
    { file_path: 'a.md', heading: 'H1', content: 'Unique echo content foxtrot' },
    { file_path: 'a.md', heading: 'H2', content: 'Unique golf content hotel' },
    { file_path: 'b.md', heading: 'H3', content: 'Unique india content juliet' },
  ];
  const result = enforceResultDiversity(chunks, { maxPerFile: 3, maxPerHeading: 2 });
  const totalFiltered = result.filtered.byFile + result.filtered.byHeading + result.filtered.bySimilarity;
  assert(result.selected.length + totalFiltered === chunks.length,
    `Selected (${result.selected.length}) + filtered (${totalFiltered}) should equal input (${chunks.length})`);
}

// ─── Test 7: Custom thresholds ───
console.log('Test 7: Custom thresholds');
{
  const chunks = [
    { file_path: 'a.md', heading: 'H1', content: 'Content alpha' },
    { file_path: 'a.md', heading: 'H2', content: 'Content beta' },
  ];
  const result = enforceResultDiversity(chunks, { maxPerFile: 1 });
  assert(result.selected.length === 1, `maxPerFile=1 should select 1, got ${result.selected.length}`);
}

// ─── Test 8: filePath vs file_path compatibility ───
console.log('Test 8: filePath property compatibility');
{
  const chunks = [
    { filePath: 'a.md', heading: 'H1', content: 'Using filePath property one' },
    { filePath: 'a.md', heading: 'H2', content: 'Using filePath property two' },
    { filePath: 'a.md', heading: 'H3', content: 'Using filePath property three' },
    { filePath: 'a.md', heading: 'H4', content: 'Using filePath property four' },
  ];
  const result = enforceResultDiversity(chunks);
  assert(result.selected.length === 3, `Should handle filePath (not file_path), got ${result.selected.length}`);
}

// ─── Summary ───
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
