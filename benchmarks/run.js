#!/usr/bin/env node
/**
 * SME Benchmarks — measures all critical operations on synthetic data.
 * Run: node benchmarks/run.js  or  npm run bench
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const { openDb, getStats } = require('../lib/store');
const { indexWorkspace } = require('../lib/indexer');
const { recall } = require('../lib/recall');
const { runReflectCycle } = require('../lib/reflect');
const { loadConfig, resolveIncludes } = require('../lib/config');
const { getRelevantContext } = require('../lib/context');

// ─── Machine spec ───

const spec = `${os.cpus()[0].model.trim()}, ${Math.round(os.totalmem() / 1e9)}GB RAM, ${os.platform()} ${os.release()}, Node ${process.version}`;

// ─── Timing utility ───

function time(fn, runs = 5) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    const result = fn();
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    times.push({ elapsed, result });
  }
  times.sort((a, b) => a.elapsed - b.elapsed);
  return {
    avg: times.reduce((s, t) => s + t.elapsed, 0) / times.length,
    p50: times[Math.floor(times.length / 2)].elapsed,
    p95: times[Math.ceil(times.length * 0.95) - 1].elapsed,
    min: times[0].elapsed,
    max: times[times.length - 1].elapsed,
    result: times[0].result,
  };
}

// ─── Synthetic content fragments ───

const SENTENCES = [
  'Discussed the quarterly roadmap and agreed on priorities for next sprint.',
  'Reviewed database migration strategy — decided on incremental approach.',
  'API rate limits need to be bumped to 1000 req/min for production tier.',
  'Sarah confirmed the deployment timeline for production release.',
  'Mike raised concerns about the budget allocation for Q3 infrastructure.',
  'Agreed to use PostgreSQL for the new analytics pipeline.',
  'Tom presented the research findings on caching strategies.',
  'Action item: finalize the integration test suite by end of week.',
  'Nexus platform requires CloudStack SDK v3.2 for compatibility.',
  'Creatine protocol: 5g daily, taken with morning coffee.',
  'Zinc picolinate 30mg before bed for recovery optimization.',
  'Bromantane 25mg sublingual — focus and motivation stack.',
  'DataSync module handles real-time event propagation across services.',
  'CloudStack deployment uses blue-green strategy with 5-minute canary.',
  'Acme Corp contract renewal deadline is March 15th.',
  'Project Alpha milestone 3 completed ahead of schedule.',
  'Performance benchmarks show 40% improvement after index optimization.',
  'Decision: use FTS5 over vector DB for local search — no API dependency.',
  'Meeting with stakeholders moved to Thursday at 2pm.',
  'Research indicates WebSocket outperforms SSE for our latency requirements.',
  'The monitoring dashboard needs additional metrics for error rates.',
  'Agreed on TypeScript strict mode for all new modules.',
  'Budget review complete — approved $15k for cloud infrastructure.',
  'Authentication flow migrated from session-based to JWT tokens.',
  'Load testing revealed bottleneck in the connection pooling layer.',
  'Scheduled maintenance window: Saturday 2am-4am UTC.',
  'User feedback suggests simplifying the onboarding wizard.',
  'Documentation sprint planned for next week — all hands.',
  'Dependency audit found 3 outdated packages needing updates.',
  'Feature flag system deployed — gradual rollout starts Monday.',
];

const ENTITIES_PEOPLE = ['@sarah', '@mike', '@tom', '@alex', '@dana'];
const ENTITIES_PROJECTS = ['**DataSync**', '**CloudStack**', '**Nexus**', '**Acme Corp**', '**Project Alpha**'];
const TAGS = ['[fact]', '[decision]', '[confirmed]', '[inferred]', '[pref]', '[opinion]', '[action_item]'];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function pickN(arr, n) {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}
function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function generateChunk(opts = {}) {
  const lines = [];
  const numSentences = randInt(opts.minSentences || 1, opts.maxSentences || 5);
  for (let i = 0; i < numSentences; i++) {
    let line = pick(SENTENCES);
    // Randomly inject entities
    if (Math.random() < 0.3) line += ' ' + pick(ENTITIES_PEOPLE);
    if (Math.random() < 0.2) line += ' ' + pick(ENTITIES_PROJECTS);
    // Randomly prepend a tag
    if (Math.random() < 0.4 && opts.useTags !== false) {
      line = pick(TAGS) + ' ' + line;
    }
    lines.push('- ' + line);
  }
  return lines.join('\n');
}

function generateSection(heading, opts = {}) {
  return `## ${heading}\n\n${generateChunk(opts)}\n`;
}

// ─── Workspace generator ───

function generateWorkspace(dir) {
  // MEMORY.md — 8-10 sections, ~40 chunks
  const memorySections = [
    'Key Decisions', 'Health Stack', 'Technical Architecture', 'People & Contacts',
    'Project Status', 'Infrastructure', 'Research Notes', 'Financial Overview',
    'Long-term Goals', 'Learned Lessons',
  ];
  let memoryContent = '# Long-Term Memory\n\n';
  for (const s of memorySections) {
    memoryContent += generateSection(s, { minSentences: 3, maxSentences: 6 }) + '\n';
  }
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), memoryContent);

  // USER.md — 3-4 sections, ~15 chunks
  let userContent = '# User Profile\n\n';
  for (const s of ['Preferences', 'Background', 'Current Focus', 'Communication Style']) {
    userContent += generateSection(s, { minSentences: 2, maxSentences: 5 }) + '\n';
  }
  fs.writeFileSync(path.join(dir, 'USER.md'), userContent);

  // memory/ daily logs — 58 files
  const memoryDir = path.join(dir, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });

  for (let d = 1; d <= 31; d++) {
    const dd = String(d).padStart(2, '0');
    let content = `# Session Log — 2026-01-${dd}\n\n`;
    const numSections = randInt(3, 5);
    const headings = pickN(['Morning Review', 'Afternoon Work', 'Decisions Made', 'Research', 'Action Items', 'Evening Notes', 'Standup'], numSections);
    for (const h of headings) {
      content += generateSection(h, { minSentences: 2, maxSentences: 4 }) + '\n';
    }
    fs.writeFileSync(path.join(memoryDir, `2026-01-${dd}.md`), content);
  }

  for (let d = 1; d <= 27; d++) {
    const dd = String(d).padStart(2, '0');
    let content = `# Session Log — 2026-02-${dd}\n\n`;
    const numSections = randInt(3, 5);
    const headings = pickN(['Sprint Review', 'Deep Work', 'Blockers', 'Debugging', 'Planning', 'Code Review', 'Retrospective'], numSections);
    for (const h of headings) {
      content += generateSection(h, { minSentences: 2, maxSentences: 4 }) + '\n';
    }
    fs.writeFileSync(path.join(memoryDir, `2026-02-${dd}.md`), content);
  }

  // notes/ — projects, meetings, research
  const notesDir = path.join(dir, 'notes');
  fs.mkdirSync(notesDir, { recursive: true });

  const projects = ['project-alpha', 'project-bravo', 'project-charlie', 'project-delta', 'project-echo'];
  for (const p of projects) {
    let content = `# ${p.replace('-', ' ').replace(/\b\w/g, c => c.toUpperCase())}\n\n`;
    const numSections = randInt(5, 8);
    const headings = pickN(['Overview', 'Architecture', 'Milestones', 'Dependencies', 'Risks', 'Team', 'Budget', 'Timeline'], numSections);
    for (const h of headings) {
      content += generateSection(h, { minSentences: 3, maxSentences: 5 }) + '\n';
    }
    fs.writeFileSync(path.join(notesDir, `${p}.md`), content);
  }

  for (let i = 1; i <= 20; i++) {
    const dd = String((i % 28) + 1).padStart(2, '0');
    let content = `# Meeting Notes — 2026-01-${dd}\n\n`;
    const speakers = pickN(['Sarah', 'Mike', 'Tom', 'Dana', 'Alex'], randInt(2, 4));
    content += `**Attendees:** ${speakers.join(', ')}\n\n`;
    const numSections = randInt(3, 5);
    const headings = pickN(['Agenda', 'Discussion', 'Decisions', 'Action Items', 'Follow-ups', 'Parking Lot'], numSections);
    for (const h of headings) {
      content += generateSection(h, { minSentences: 2, maxSentences: 4 }) + '\n';
    }
    fs.writeFileSync(path.join(notesDir, `meeting-${String(i).padStart(2, '0')}.md`), content);
  }

  for (let i = 1; i <= 15; i++) {
    let content = `# Research — Topic ${i}\n\n`;
    const numSections = randInt(2, 4);
    const headings = pickN(['Summary', 'Findings', 'Methodology', 'Sources', 'Conclusions', 'Open Questions'], numSections);
    for (const h of headings) {
      content += generateSection(h, { minSentences: 2, maxSentences: 4 }) + '\n';
    }
    fs.writeFileSync(path.join(notesDir, `research-${String(i).padStart(2, '0')}.md`), content);
  }

  // .memory/config.json — include notes/ via glob
  const dotMemory = path.join(dir, '.memory');
  fs.mkdirSync(dotMemory, { recursive: true });
  fs.writeFileSync(path.join(dotMemory, 'config.json'), JSON.stringify({
    includeGlobs: ['notes/*.md'],
    fileTypeDefaults: {
      'MEMORY.md': 'confirmed',
      'USER.md': 'confirmed',
      'memory/*.md': 'fact',
      'notes/*.md': 'inferred',
    },
  }, null, 2));

  // Count files
  let fileCount = 2; // MEMORY.md + USER.md
  fileCount += 31 + 27; // daily logs
  fileCount += 5 + 20 + 15; // notes
  return fileCount;
}

// ─── Benchmark runner ───

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sme-bench-'));

  try {
    process.stderr.write(`Generating synthetic workspace in ${tmpDir}...\n`);
    const expectedFiles = generateWorkspace(tmpDir);

    const config = loadConfig(tmpDir);
    const extras = resolveIncludes(tmpDir, config);
    const include = extras.map(p => path.relative(tmpDir, p));
    const fileTypeDefaults = config.fileTypeDefaults || {};

    // ─── Suite 1: Full index ───
    process.stderr.write('Suite 1: Full index...\n');
    let db = openDb(tmpDir);
    const fullIndex = time(() => {
      return indexWorkspace(db, tmpDir, { force: true, include, fileTypeDefaults });
    }, 1); // single run for cold index
    const indexResult = fullIndex.result;
    const stats = getStats(db);

    // ─── Suite 2: Incremental reindex ───
    process.stderr.write('Suite 2: Incremental reindex...\n');
    // Modify 2 files
    const file1 = path.join(tmpDir, 'memory', '2026-01-15.md');
    const file2 = path.join(tmpDir, 'memory', '2026-02-10.md');
    fs.appendFileSync(file1, '\n- [fact] New benchmark entry added for testing incremental reindex.\n');
    fs.appendFileSync(file2, '\n- [decision] Decided to optimize the indexing pipeline further.\n');
    // Touch mtime
    const now = new Date();
    fs.utimesSync(file1, now, now);
    fs.utimesSync(file2, now, now);

    const incIndex = time(() => {
      return indexWorkspace(db, tmpDir, { force: false, include, fileTypeDefaults });
    }, 5);

    // ─── Suite 3: Query latency ───
    process.stderr.write('Suite 3: Query latency...\n');
    const queries = [
      'database migration',
      'Sarah',
      'quarterly review results',
      'API rate limits',
      'what did Mike decide',
      'creatine protocol',
      'deployment timeline production',
      'budget',
      'Nexus CloudStack integration',
      'action items from last meeting',
    ];

    // Warmup run
    for (const q of queries) recall(db, q, { limit: 5 });

    const queryTimes = [];
    for (const q of queries) {
      const t = time(() => recall(db, q, { limit: 5 }), 5);
      queryTimes.push(t);
    }
    const queryAvg = queryTimes.reduce((s, t) => s + t.avg, 0) / queryTimes.length;
    const allQueryElapsed = queryTimes.map(t => t.p50).sort((a, b) => a - b);
    const queryP50 = allQueryElapsed[Math.floor(allQueryElapsed.length / 2)];
    const queryP95 = allQueryElapsed[Math.ceil(allQueryElapsed.length * 0.95) - 1];

    // ─── Suite 4: CIL context pipeline ───
    process.stderr.write('Suite 4: CIL context pipeline...\n');

    // Warmup
    for (const q of queries) getRelevantContext(db, q, { maxTokens: 1500, workspace: tmpDir });

    const cilTimes = [];
    let totalChunksReturned = 0;
    let totalTokens = 0;
    let cilHits = 0;
    for (const q of queries) {
      const t = time(() => getRelevantContext(db, q, { maxTokens: 1500, workspace: tmpDir }), 5);
      cilTimes.push(t);
      if (t.result.chunks.length > 0) {
        totalChunksReturned += t.result.chunks.length;
        totalTokens += t.result.tokenEstimate;
        cilHits++;
      }
    }
    const cilAvg = cilTimes.reduce((s, t) => s + t.avg, 0) / cilTimes.length;
    const allCilElapsed = cilTimes.map(t => t.p50).sort((a, b) => a - b);
    const cilP50 = allCilElapsed[Math.floor(allCilElapsed.length / 2)];
    const cilP95 = allCilElapsed[Math.ceil(allCilElapsed.length * 0.95) - 1];
    const avgChunks = cilHits > 0 ? (totalChunksReturned / cilHits).toFixed(1) : '—';
    const avgTokens = cilHits > 0 ? Math.round(totalTokens / cilHits) : '—';

    // ─── Suite 5: Reflect cycle ───
    process.stderr.write('Suite 5: Reflect cycle...\n');
    const reflect = time(() => runReflectCycle(db, { dryRun: false }), 5);
    const reflectResult = reflect.result;
    const phases = ['decay', 'reinforce', 'stale', 'contradictions', 'prune']
      .filter(p => reflectResult[p])
      .length;

    // ─── Suite 6: DB overhead ───
    process.stderr.write('Suite 6: DB overhead...\n');
    // Sum source markdown sizes
    let srcBytes = 0;
    function sumDir(d) {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory() && entry.name !== '.memory') {
          sumDir(full);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          srcBytes += fs.statSync(full).size;
        }
      }
    }
    sumDir(tmpDir);

    db.close();
    const dbPath = path.join(tmpDir, '.memory', 'index.sqlite');
    const dbBytes = fs.statSync(dbPath).size;
    // Also count WAL if present
    const walPath = dbPath + '-wal';
    let walBytes = 0;
    try { walBytes = fs.statSync(walPath).size; } catch (_) {}
    const totalDbBytes = dbBytes + walBytes;
    const srcKB = (srcBytes / 1024).toFixed(0);
    const dbKB = (totalDbBytes / 1024).toFixed(0);
    const ratio = (totalDbBytes / srcBytes).toFixed(1);

    // ─── Output ───
    const pad = (s, n) => String(s).padEnd(n);
    const rpad = (s, n) => String(s).padStart(n);

    console.log('');
    console.log('## SME Benchmarks');
    console.log('');
    console.log(`Machine: ${spec}`);
    console.log(`Dataset: ${stats.fileCount} files, ${stats.chunkCount} chunks`);
    console.log('');
    console.log(`| ${pad('Operation', 22)} | ${pad('Dataset', 22)} | ${rpad('Avg', 9)} | ${rpad('p95', 9)} | ${pad('Notes', 30)} |`);
    console.log(`| ${'-'.repeat(22)} | ${'-'.repeat(22)} | ${'-'.repeat(9)} | ${'-'.repeat(9)} | ${'-'.repeat(30)} |`);
    console.log(`| ${pad('Full index', 22)} | ${pad(`${stats.fileCount} files → ${stats.chunkCount} chunks`, 22)} | ${rpad(fullIndex.avg.toFixed(0) + 'ms', 9)} | ${rpad('—', 9)} | ${pad('Cold start, force=true', 30)} |`);
    console.log(`| ${pad('Incremental reindex', 22)} | ${pad(`2/${stats.fileCount} files changed`, 22)} | ${rpad(incIndex.avg.toFixed(1) + 'ms', 9)} | ${rpad('—', 9)} | ${pad(`mtime skip, ${incIndex.result.skipped} unchanged`, 30)} |`);
    console.log(`| ${pad('Query (FTS5)', 22)} | ${pad(`10 queries, ${stats.chunkCount} chunks`, 22)} | ${rpad(queryAvg.toFixed(1) + 'ms', 9)} | ${rpad(queryP95.toFixed(1) + 'ms', 9)} | ${pad('Top 5 results, recall()', 30)} |`);
    console.log(`| ${pad('CIL context', 22)} | ${pad(`10 msgs, 1500 tk budget`, 22)} | ${rpad(cilAvg.toFixed(1) + 'ms', 9)} | ${rpad(cilP95.toFixed(1) + 'ms', 9)} | ${pad(`avg ${avgChunks} chunks, ${avgTokens} tokens`, 30)} |`);
    console.log(`| ${pad('Reflect cycle', 22)} | ${pad(`${stats.chunkCount} chunks`, 22)} | ${rpad(reflect.avg.toFixed(0) + 'ms', 9)} | ${rpad('—', 9)} | ${pad(`${phases}/5 phases`, 30)} |`);
    console.log(`| ${pad('DB overhead', 22)} | ${pad(`${stats.fileCount} files (${srcKB} KB src)`, 22)} | ${rpad(dbKB + ' KB', 9)} | ${rpad('—', 9)} | ${pad(`${ratio}x source size`, 30)} |`);
    console.log('');

  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.stderr.write('Cleaned up temp directory.\n');
  }
}

run();
