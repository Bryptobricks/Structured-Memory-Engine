/**
 * v2 Retain — Structured fact extraction from tagged markdown
 */

const TAG_PATTERN = /\[(fact|decision|pref|opinion|confirmed|inferred|outdated\?)\]\s*(.+)/gi;

const TAG_CONFIDENCE = {
  'fact': 1.0,
  'decision': 1.0,
  'pref': 1.0,
  'confirmed': 1.0,
  'opinion': 0.8,
  'inferred': 0.7,
  'outdated?': 0.3,
};

const TAG_TYPE = {
  'fact': 'fact',
  'decision': 'decision',
  'pref': 'preference',
  'confirmed': 'fact',
  'inferred': 'fact',
  'outdated?': 'fact',
  'opinion': 'opinion',
};

const HEADING_TYPE = {
  'decisions': 'decision',
  'facts': 'fact',
  'preferences': 'preference',
  'learned': 'fact',
  'open questions': 'opinion',
};

function extractEntities(text) {
  const entities = new Set();
  for (const m of text.matchAll(/@(\w+)/g)) entities.add('@' + m[1]);
  for (const m of text.matchAll(/\*\*([^*]+)\*\*/g)) entities.add(m[1]);
  return [...entities];
}

function extractFacts(text, filePath) {
  const lines = text.split('\n');
  const facts = [];

  // Pass 1: tagged facts
  for (let i = 0; i < lines.length; i++) {
    TAG_PATTERN.lastIndex = 0;
    let match;
    while ((match = TAG_PATTERN.exec(lines[i])) !== null) {
      const tag = match[1].toLowerCase();
      facts.push({
        content: match[2].trim(),
        type: TAG_TYPE[tag],
        confidence: TAG_CONFIDENCE[tag],
        lineStart: i + 1,
        lineEnd: i + 1,
        entities: extractEntities(match[2]),
        source: filePath || null,
      });
    }
  }

  // Pass 2: bullets under known headings
  let currentHeadingType = null;
  for (let i = 0; i < lines.length; i++) {
    const headingMatch = lines[i].match(/^#{1,4}\s+(.+)/);
    if (headingMatch) {
      const heading = headingMatch[1].trim().toLowerCase();
      currentHeadingType = HEADING_TYPE[heading] || null;
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
