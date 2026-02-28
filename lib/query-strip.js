'use strict';

/**
 * Generic query stripping — removes metadata envelopes, system prefixes,
 * and code blocks that pollute FTS terms and embedding vectors.
 *
 * Consumer-agnostic: strips common patterns without hardcoding any
 * specific consumer (OpenClaw, Claude Code, etc.).
 */

function stripQuery(input) {
  if (!input || typeof input !== 'string') return '';

  let q = input;

  // Remove fenced code blocks (```...```)
  q = q.replace(/```[\s\S]*?```/g, '');

  // Remove inline code (`...`)
  q = q.replace(/`[^`]+`/g, '');

  // Remove system-prefixed lines (System:, Context:, Instructions:, etc.)
  q = q.replace(/^(system|context|instructions|memory|metadata|assistant|human):\s*.*/gim, '');

  // Remove markdown headers that look like metadata sections
  q = q.replace(/^#{1,3}\s*(system|context|instructions|memory|metadata)\b.*$/gim, '');

  // Remove XML-like metadata tags and their content
  q = q.replace(/<(system|context|instructions|metadata)[^>]*>[\s\S]*?<\/\1>/gi, '');
  q = q.replace(/<(system|context|instructions|metadata)[^/]*\/>/gi, '');

  // Metadata label lines with parenthetical qualifiers containing metadata keywords
  // Catches "Conversation info (untrusted metadata):" without hardcoding consumer patterns
  q = q.replace(/^[\w][\w\s]*\((?:untrusted|metadata|system|context|internal)[^)]*\):?\s*$/gim, '');

  // Recalled Context sections (SME's own output fed back as input)
  q = q.replace(/## Recalled Context\n[\s\S]*?(?=\n\n(?![- ↳])|\n## |$)/g, '');

  // Collapse whitespace
  q = q.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+/g, ' ').trim();

  return q;
}

module.exports = { stripQuery };
