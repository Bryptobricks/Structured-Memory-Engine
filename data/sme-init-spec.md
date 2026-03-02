# sme init — Quick-Start Scaffold Command

## Goal
Add an `init` subcommand to `lib/index.js` that creates a ready-to-use SME workspace in the current directory. Zero friction: run `npx sme init`, get a working memory system in 3 seconds.

## What `sme init` should do:

1. Create `.memory/config.json` with sensible defaults
2. Create a sample `MEMORY.md` with example content showing the format
3. Run `sme index` automatically after scaffolding
4. Print a clear "what to do next" message

## File: lib/index.js

Add a new command handler for `init` BEFORE the `const db = openDb(workspace)` line (since the db doesn't exist yet at init time).

```javascript
if (command === 'init') {
  const fs = require('fs');
  const memoryDir = path.join(workspace, '.memory');
  const configPath = path.join(memoryDir, 'config.json');
  const memoryMdPath = path.join(workspace, 'MEMORY.md');

  // Don't overwrite existing setup
  if (fs.existsSync(configPath)) {
    console.log('⚠️  .memory/config.json already exists. SME is already initialized here.');
    process.exit(1);
  }

  // Create .memory directory
  fs.mkdirSync(memoryDir, { recursive: true });

  // Write default config
  const defaultConfig = {
    include: ["MEMORY.md"],
    includeGlobs: ["memory/*.md"],
    fileWeights: {
      "MEMORY.md": 1.5
    },
    fileTypeDefaults: {
      "MEMORY.md": "confirmed",
      "memory/*.md": "fact"
    }
  };
  fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2) + '\n');
  console.log('✅ Created .memory/config.json');

  // Create sample MEMORY.md if it doesn't exist
  if (!fs.existsSync(memoryMdPath)) {
    const sampleMemory = `# Memory

## About This File
This is your long-term memory. SME indexes it automatically and uses it to give your AI agent context about you, your projects, and your decisions.

## Example Entries

### Decisions
- Chose PostgreSQL over MySQL for the main database (Jan 15)
- Using React + TypeScript for the frontend

### People
- **Sarah** — Backend lead, working on the migration
- **Alex** — Designer, prefers Figma over Sketch

### Projects
- **Project Atlas** — API rewrite, targeting March launch
- **Dashboard v2** — New analytics dashboard, in design phase

---

*Edit this file with your own memories. SME will index it automatically.*
*Create daily notes in memory/ folder for session logs.*
`;
    fs.writeFileSync(memoryMdPath, sampleMemory);
    console.log('✅ Created MEMORY.md with example content');
  } else {
    console.log('ℹ️  MEMORY.md already exists, keeping yours');
  }

  // Create memory/ directory for daily notes
  const memoryNotesDir = path.join(workspace, 'memory');
  if (!fs.existsSync(memoryNotesDir)) {
    fs.mkdirSync(memoryNotesDir, { recursive: true });
    console.log('✅ Created memory/ directory for daily notes');
  }

  // Auto-index
  const db2 = openDb(workspace);
  const config = loadConfig(workspace);
  const include = resolveIncludes(workspace, config).map(p => path.relative(workspace, p));
  const fileTypeDefaults = config.fileTypeDefaults || {};
  const result = indexWorkspace(db2, workspace, { force: true, include, fileTypeDefaults });
  console.log(`✅ Indexed ${result.indexed} file(s), ${result.total} discovered`);

  console.log(`
🧠 SME initialized! Here's what to do next:

  # Search your memory
  npx sme query "what did we decide about the database?"

  # Get auto-context for an AI message
  npx sme context "summarize the migration plan"

  # Check index status
  npx sme status

  # Add more files to index — edit .memory/config.json

Tip: Create daily notes in memory/YYYY-MM-DD.md for session logs.
`);
  process.exit(0);
}
```

## Also update:
1. The help text to include: `node lib/index.js init [--workspace PATH]`
2. Add `--help` as alias for the help command (currently only warns "unknown flag")

## Test:
```bash
# Test in temp directory
cd $(mktemp -d)
npx sme init
npx sme query "PostgreSQL"
npx sme status
```

## Files to modify:
- `lib/index.js` — add init command + update help text + --help flag
- `package.json` — bump to 6.10.0

## Do NOT:
- Modify any other files
- Change existing command behavior
- Add dependencies
