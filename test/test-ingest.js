#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { parseTranscript, generateMarkdown: generateTranscriptMd } = require('../lib/ingest/transcripts');
const { parseCsv, generateMarkdown: generateCsvMd } = require('../lib/ingest/csv');
const { syncFile, syncAll } = require('../lib/ingest/sync');
const { openDb } = require('../lib/store');
const { recall } = require('../lib/recall');
const { indexWorkspace } = require('../lib/indexer');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; }
  else { failed++; console.error(`  \u2717 ${msg}`); }
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sme-ingest-test-'));
}

// ============================================================
// TRANSCRIPT TESTS (1-8)
// ============================================================

const SAMPLE_TRANSCRIPT = `## Summary
Product review meeting covering Q1 roadmap priorities.

## Attendees
- Lisa Park, Mike Chen, Sarah Johnson

## Discussion
Lisa Park: We need to finalize the API design before next sprint.
Mike Chen: I agree. We decided to go with REST over GraphQL.
Lisa Park: Good. I will follow up with the backend team on Monday.

Sarah Johnson: The performance tests showed a 40% improvement.
We should document these results in the wiki.

## Action Items
- Lisa Park will send the API spec to the backend team
- Mike Chen will prepare the Q1 roadmap presentation
- TODO: Review the deployment checklist before Friday`;

console.log('--- Transcript Tests ---');

// Test 1: Speaker detection
console.log('Test 1: Parses speaker lines');
{
  const result = parseTranscript(SAMPLE_TRANSCRIPT);
  assert(result.speakers.includes('Lisa Park'), `Expected speaker 'Lisa Park', got: ${result.speakers}`);
  assert(result.speakers.includes('Mike Chen'), `Expected speaker 'Mike Chen', got: ${result.speakers}`);
  assert(result.speakers.includes('Sarah Johnson'), `Expected speaker 'Sarah Johnson', got: ${result.speakers}`);
}

// Test 2: Continuation lines inherit currentSpeaker
console.log('Test 2: Continuation lines inherit currentSpeaker');
{
  const text = `## Discussion
Lisa Park: Starting point for the discussion.
This is a continuation line.
Mike Chen: Another speaker takes over.`;
  const result = parseTranscript(text);
  assert(result.speakers.includes('Lisa Park'), 'Lisa Park should be a speaker');
  assert(result.speakers.includes('Mike Chen'), 'Mike Chen should be a speaker');
  // Continuation line shouldn't create a new speaker
  assert(result.speakers.length === 2, `Expected 2 speakers, got ${result.speakers.length}`);
}

// Test 3: Summary section lines tagged [fact] with confidence 0.9
console.log('Test 3: Summary section generates [fact] tags');
{
  const result = parseTranscript(SAMPLE_TRANSCRIPT);
  const md = generateTranscriptMd(result, 'test-meeting.txt');
  assert(md.includes('[fact] Product review meeting'), `Summary should be tagged [fact], got:\n${md.split('\n').filter(l => l.includes('Product review')).join('\n')}`);
}

// Test 4: Decision detection
console.log('Test 4: Decision detection');
{
  const result = parseTranscript(SAMPLE_TRANSCRIPT);
  assert(result.decisions.length > 0, `Expected at least 1 decision, got ${result.decisions.length}`);
  const decisionTexts = result.decisions.map(d => d.text);
  assert(decisionTexts.some(t => /decided|go with/i.test(t)), `Expected decision with 'decided/go with', got: ${decisionTexts}`);
}

// Test 5: Action item detection
console.log('Test 5: Action item detection');
{
  const result = parseTranscript(SAMPLE_TRANSCRIPT);
  assert(result.actionItems.length >= 3, `Expected at least 3 action items, got ${result.actionItems.length}`);
  const md = generateTranscriptMd(result, 'test.txt');
  assert(md.includes('[action_item]'), 'Markdown should contain [action_item] tags');
}

// Test 6: Attendees extraction
console.log('Test 6: Attendees extracted from speakers + section');
{
  const result = parseTranscript(SAMPLE_TRANSCRIPT);
  const attendees = result.metadata.attendees;
  assert(attendees.includes('Lisa Park'), `Expected 'Lisa Park' in attendees, got: ${attendees}`);
  assert(attendees.includes('Mike Chen'), `Expected 'Mike Chen' in attendees, got: ${attendees}`);
  assert(attendees.includes('Sarah Johnson'), `Expected 'Sarah Johnson' in attendees, got: ${attendees}`);
}

// Test 7: Empty input → empty result
console.log('Test 7: Empty input');
{
  const result = parseTranscript('');
  assert(result.sections.length === 0, 'Empty input should produce no sections');
  assert(result.speakers.length === 0, 'Empty input should produce no speakers');
  assert(result.decisions.length === 0, 'Empty input should produce no decisions');
  assert(result.actionItems.length === 0, 'Empty input should produce no action items');
}

// Test 8: No sections/speakers → plain text wrapped
console.log('Test 8: No sections/speakers');
{
  const text = 'Just some plain text with no special formatting.';
  const result = parseTranscript(text);
  assert(result.sections.length === 0, `Expected 0 sections, got ${result.sections.length}`);
  assert(result.speakers.length === 0, `Expected 0 speakers, got ${result.speakers.length}`);
  // generateMarkdown should still work
  const md = generateTranscriptMd(result, 'plain.txt');
  assert(md.includes('# Meeting Notes'), 'Should still generate heading');
}

// ============================================================
// CSV TESTS (9-13)
// ============================================================

console.log('\n--- CSV Tests ---');

// Test 9: Simple CSV
console.log('Test 9: Simple CSV parse');
{
  const csv = 'Name,Age,City\nAlice,30,NYC\nBob,25,LA';
  const result = parseCsv(csv);
  assert(result.headers.length === 3, `Expected 3 headers, got ${result.headers.length}`);
  assert(result.headers[0] === 'Name', `Expected header 'Name', got '${result.headers[0]}'`);
  assert(result.rows.length === 2, `Expected 2 rows, got ${result.rows.length}`);
  assert(result.rows[0][0] === 'Alice', `Expected 'Alice', got '${result.rows[0][0]}'`);
  assert(result.rows[1][2] === 'LA', `Expected 'LA', got '${result.rows[1][2]}'`);
}

// Test 10: Quoted fields with commas
console.log('Test 10: Quoted fields with commas');
{
  const csv = 'Name,Address,Phone\nAlice,"123 Main St, Apt 4",555-1234\nBob,"456 Oak Ave, Suite 100",555-5678';
  const result = parseCsv(csv);
  assert(result.rows[0][1] === '123 Main St, Apt 4', `Expected '123 Main St, Apt 4', got '${result.rows[0][1]}'`);
  assert(result.rows[1][1] === '456 Oak Ave, Suite 100', `Expected '456 Oak Ave, Suite 100', got '${result.rows[1][1]}'`);
}

// Test 11: Escaped quotes
console.log('Test 11: Escaped quotes');
{
  const csv = 'Name,Quote\nAlice,"She said ""hello"""\nBob,"He said ""goodbye"""';
  const result = parseCsv(csv);
  assert(result.rows[0][1] === 'She said "hello"', `Expected 'She said "hello"', got '${result.rows[0][1]}'`);
  assert(result.rows[1][1] === 'He said "goodbye"', `Expected 'He said "goodbye"', got '${result.rows[1][1]}'`);
}

// Test 12: Ragged rows padded
console.log('Test 12: Ragged rows padded');
{
  const csv = 'A,B,C\n1,2,3\n4,5\n6';
  const result = parseCsv(csv);
  assert(result.rows[1].length === 3, `Expected 3 fields in ragged row, got ${result.rows[1].length}`);
  assert(result.rows[1][2] === '', `Expected empty string for padding, got '${result.rows[1][2]}'`);
  assert(result.rows[2].length === 3, `Expected 3 fields in very ragged row, got ${result.rows[2].length}`);
}

// Test 13: Headerless detection
console.log('Test 13: Headerless detection');
{
  const csv = '1,2,3\n4,5,6\n7,8,9';
  const result = parseCsv(csv);
  assert(result.headers[0] === 'col_0', `Expected 'col_0' auto-header, got '${result.headers[0]}'`);
  assert(result.headers[2] === 'col_2', `Expected 'col_2' auto-header, got '${result.headers[2]}'`);
  assert(result.rows.length === 3, `Expected 3 data rows (no header consumed), got ${result.rows.length}`);
}

// ============================================================
// SYNC TESTS (14-16)
// ============================================================

console.log('\n--- Sync Tests ---');

// Test 14: syncFile writes markdown + indexes
console.log('Test 14: syncFile writes markdown and indexes');
{
  const tmpDir = makeTempDir();
  const sourceFile = path.join(tmpDir, 'meeting.txt');
  fs.writeFileSync(sourceFile, SAMPLE_TRANSCRIPT, 'utf-8');

  const db = openDb(tmpDir);
  try {
    const result = syncFile(db, tmpDir, sourceFile);
    assert(!result.skipped, 'Should not be skipped on first sync');
    assert(result.outputPath === path.join('ingest', 'meeting.md'), `Expected ingest/meeting.md, got ${result.outputPath}`);

    // Check file was written
    const outputPath = path.join(tmpDir, result.outputPath);
    assert(fs.existsSync(outputPath), `Output file should exist at ${outputPath}`);

    const content = fs.readFileSync(outputPath, 'utf-8');
    assert(content.includes('# Meeting Notes'), 'Output should contain meeting notes heading');
    assert(content.includes('[action_item]'), 'Output should contain action_item tags');
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Test 15: syncAll skips unchanged files
console.log('Test 15: syncAll skips unchanged files');
{
  const tmpDir = makeTempDir();
  const sourceDir = path.join(tmpDir, 'sources');
  fs.mkdirSync(sourceDir);

  fs.writeFileSync(path.join(sourceDir, 'meeting1.txt'), '## Summary\nFirst meeting.', 'utf-8');
  fs.writeFileSync(path.join(sourceDir, 'meeting2.txt'), '## Summary\nSecond meeting.', 'utf-8');

  const db = openDb(tmpDir);
  try {
    // First sync — should sync both
    const result1 = syncAll(db, tmpDir, sourceDir);
    assert(result1.synced.length === 2, `Expected 2 synced, got ${result1.synced.length}`);
    assert(result1.skipped.length === 0, `Expected 0 skipped, got ${result1.skipped.length}`);

    // Second sync — should skip both (unchanged)
    const result2 = syncAll(db, tmpDir, sourceDir);
    assert(result2.synced.length === 0, `Expected 0 synced on re-run, got ${result2.synced.length}`);
    assert(result2.skipped.length === 2, `Expected 2 skipped on re-run, got ${result2.skipped.length}`);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Test 16: Roundtrip — sync transcript → query → find Lisa Park action item
console.log('Test 16: Roundtrip sync → query → find Lisa Park action item');
{
  const tmpDir = makeTempDir();
  const sourceFile = path.join(tmpDir, 'team-meeting.txt');
  fs.writeFileSync(sourceFile, SAMPLE_TRANSCRIPT, 'utf-8');

  const db = openDb(tmpDir);
  try {
    // Sync the file
    syncFile(db, tmpDir, sourceFile);

    // Now index the workspace so the ingest/ dir is discoverable
    indexWorkspace(db, tmpDir, { force: true });

    // Query for Lisa Park action item
    const results = recall(db, 'Lisa Park action item', { workspace: tmpDir });
    assert(results.length > 0, 'Should find results for "Lisa Park action item"');

    const found = results.some(r => {
      const content = (r.content || '').toLowerCase();
      return content.includes('lisa park') && (content.includes('action_item') || content.includes('api spec') || content.includes('follow up') || content.includes('send'));
    });
    assert(found, `Expected to find Lisa Park action item in results. Got: ${results.map(r => r.content.slice(0, 80)).join(' | ')}`);
  } finally {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================
// Summary
// ============================================================

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
