/**
 * v2 Retain — Structured fact extraction from tagged markdown
 */

const TAG_PATTERN = /\[(fact|decision|pref|opinion|confirmed|inferred|outdated\?|action_item)\]\s*(.+)/gi;

const TAG_CONFIDENCE = {
  'fact': 1.0,
  'decision': 1.0,
  'pref': 1.0,
  'confirmed': 1.0,
  'opinion': 0.8,
  'inferred': 0.7,
  'outdated?': 0.3,
  'action_item': 0.85,
};

const TAG_TYPE = {
  'fact': 'fact',
  'decision': 'decision',
  'pref': 'preference',
  'confirmed': 'confirmed',
  'inferred': 'inferred',
  'outdated?': 'outdated',
  'opinion': 'opinion',
  'action_item': 'action_item',
};

// Heading keywords — matched as substrings for flexibility
// e.g., "Key Decisions" or "What I Learned" will both match
const HEADING_KEYWORDS = [
  { pattern: 'decision', type: 'decision' },
  { pattern: 'fact', type: 'fact' },
  { pattern: 'preference', type: 'preference' },
  { pattern: 'learned', type: 'fact' },
  { pattern: 'open question', type: 'opinion' },
  { pattern: 'todo', type: 'decision' },
  { pattern: 'pending', type: 'decision' },
];

function matchHeadingType(heading) {
  const lower = heading.toLowerCase();
  for (const { pattern, type } of HEADING_KEYWORDS) {
    if (lower.includes(pattern)) return type;
  }
  return null;
}

function extractFacts(text, filePath) {
  // Lazy require to avoid circular dependency (indexer.js requires retain.js)
  const { extractEntities } = require('./indexer');
  const lines = text.split('\n');
  const facts = [];

  // Pass 1: tagged facts
  for (let i = 0; i < lines.length; i++) {
    TAG_PATTERN.lastIndex = 0;
    let match;
    while ((match = TAG_PATTERN.exec(lines[i])) !== null) {
      const tag = match[1].toLowerCase();
      const content = match[2].trim();
      if (!content) continue; // skip empty tagged lines
      facts.push({
        content,
        type: TAG_TYPE[tag],
        confidence: TAG_CONFIDENCE[tag],
        lineStart: i + 1,
        lineEnd: i + 1,
        entities: extractEntities(content),
        source: filePath || null,
      });
    }
  }

  // Pass 2: bullets under known headings
  let currentHeadingType = null;
  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^#{1,4}\s+(.+)/);
    if (headingMatch) {
      currentHeadingType = matchHeadingType(headingMatch[1].trim());
      continue;
    }
    if (currentHeadingType) {
      const bulletMatch = lines[i].match(/^\s*[-*]\s+(.+)/);
      if (bulletMatch) {
        const content = bulletMatch[1].trim();
        // Skip if this line was already captured as a tagged fact
        if (!facts.some(f => f.lineStart === i + 1)) {
          facts.push({
            content,
            type: currentHeadingType,
            confidence: 0.9,
            lineStart: i + 1,
            lineEnd: i + 1,
            entities: extractEntities(content),
            source: filePath || null,
          });
        }
      } else if (lines[i].trim() === '') {
        // blank line — keep heading context
      } else {
        // non-bullet, non-blank — reset
        currentHeadingType = null;
      }
    }
  }

  return facts;
}

module.exports = { extractFacts, TAG_CONFIDENCE, TAG_TYPE };
