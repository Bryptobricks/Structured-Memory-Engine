'use strict';

const path = require('path');

const SPEAKER_PATTERN = /^([A-Z][a-zA-Z\s]+):\s*(.+)/;
const BOLD_SPEAKER_PATTERN = /^\*\*([^*]+)\*\*:\s*(.+)/;
const SECTION_PATTERN = /^##\s+(.+)/;
const DECISION_PATTERN = /\b(?:decided|agreed|decision|approved|will go with)\b/i;
const ACTION_ITEM_PATTERN = /\b(?:action item|TODO|will (?:follow up|send|prepare|update|review|create|draft|investigate))\b/i;

const KNOWN_SECTIONS = ['summary', 'discussion', 'action items', 'attendees'];

function parseTranscript(text, options = {}) {
  if (!text || !text.trim()) {
    return { sections: [], speakers: [], decisions: [], actionItems: [], metadata: {} };
  }

  const lines = text.split('\n');
  const sections = [];
  const speakers = new Set();
  const decisions = [];
  const actionItems = [];
  let currentSection = null;
  let currentSpeaker = null;
  let inActionItemsSection = false;
  let inAttendeesSection = false;
  const attendeesFromSection = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Check for section headers
    const sectionMatch = trimmed.match(SECTION_PATTERN);
    if (sectionMatch) {
      const sectionName = sectionMatch[1].trim();
      currentSection = sectionName;
      inActionItemsSection = sectionName.toLowerCase() === 'action items';
      inAttendeesSection = sectionName.toLowerCase() === 'attendees';
      sections.push({ name: sectionName, startLine: i + 1, lines: [] });
      continue;
    }

    // Track section content
    if (sections.length > 0) {
      sections[sections.length - 1].lines.push(line);
    }

    // Attendees section — collect names
    if (inAttendeesSection && trimmed) {
      const attendeeMatch = trimmed.match(/^[-*]\s*(.+)/);
      if (attendeeMatch) {
        // Could be comma-separated list or single name
        const names = attendeeMatch[1].split(',').map(n => n.trim()).filter(Boolean);
        attendeesFromSection.push(...names);
      } else if (!trimmed.startsWith('#')) {
        const names = trimmed.split(',').map(n => n.trim()).filter(Boolean);
        attendeesFromSection.push(...names);
      }
      continue;
    }

    // Check for speaker lines
    let speakerMatch = trimmed.match(BOLD_SPEAKER_PATTERN) || trimmed.match(SPEAKER_PATTERN);
    if (speakerMatch) {
      currentSpeaker = speakerMatch[1].trim();
      speakers.add(currentSpeaker);
      const content = speakerMatch[2].trim();

      checkForDecision(content, currentSpeaker, i + 1, decisions);
      checkForActionItem(content, currentSpeaker, i + 1, actionItems, inActionItemsSection);
      continue;
    }

    // Continuation lines inherit currentSpeaker
    if (trimmed && currentSpeaker && !trimmed.startsWith('#')) {
      checkForDecision(trimmed, currentSpeaker, i + 1, decisions);
      checkForActionItem(trimmed, currentSpeaker, i + 1, actionItems, inActionItemsSection);
    }

    // Action items section — bullets are action items even without keyword match
    if (inActionItemsSection && trimmed) {
      const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
      if (bulletMatch) {
        const content = bulletMatch[1].trim();
        // Avoid duplicating if already caught by keyword detection
        if (!actionItems.some(a => a.line === i + 1)) {
          const assignee = extractAssignee(content) || currentSpeaker || null;
          actionItems.push({ text: content, assignee, line: i + 1 });
        }
      }
    }

    // Blank line doesn't reset speaker in same section
    if (trimmed === '' && sectionMatch) {
      // Section change resets speaker only on next section header (handled above)
    }
  }

  // Combine attendees from section + speaker names
  const allAttendees = [...new Set([...speakers, ...attendeesFromSection])];

  return {
    sections,
    speakers: [...speakers],
    decisions,
    actionItems,
    metadata: {
      attendees: allAttendees,
      sectionCount: sections.length,
      lineCount: lines.length,
    },
  };
}

function checkForDecision(text, speaker, line, decisions) {
  if (DECISION_PATTERN.test(text)) {
    if (!decisions.some(d => d.line === line)) {
      decisions.push({ text, speaker, line });
    }
  }
}

function checkForActionItem(text, speaker, line, actionItems, inSection) {
  if (ACTION_ITEM_PATTERN.test(text)) {
    if (!actionItems.some(a => a.line === line)) {
      const assignee = extractAssignee(text) || speaker || null;
      actionItems.push({ text, assignee, line });
    }
  }
}

function extractAssignee(text) {
  // Look for patterns like "Assigned: Name" or "Owner: Name" or "(Name)"
  const assignedMatch = text.match(/(?:assigned|owner):\s*([A-Z][a-zA-Z\s]+?)(?:\s*[-—]|\s*$)/i);
  if (assignedMatch) return assignedMatch[1].trim();
  return null;
}

/**
 * Generate tagged markdown from parsed transcript data.
 */
function generateMarkdown(parsed, sourceName) {
  const lines = [];
  lines.push(`# Meeting Notes — ${sourceName}`);
  lines.push('');

  // Summary section
  const summarySection = parsed.sections.find(s => s.name.toLowerCase() === 'summary');
  if (summarySection) {
    lines.push('## Summary');
    for (const line of summarySection.lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const bulletMatch = trimmed.match(/^[-*]\s+(.+)/);
        if (bulletMatch) {
          lines.push(`- [fact] ${bulletMatch[1].trim()}`);
        } else {
          lines.push(`- [fact] ${trimmed}`);
        }
      }
    }
    lines.push('');
  }

  // Decisions
  if (parsed.decisions.length > 0) {
    lines.push('## Decisions');
    for (const d of parsed.decisions) {
      lines.push(`- [decision] ${d.text} (Speaker: ${d.speaker || 'unknown'})`);
    }
    lines.push('');
  }

  // Action Items
  if (parsed.actionItems.length > 0) {
    lines.push('## Action Items');
    for (const a of parsed.actionItems) {
      lines.push(`- [action_item] ${a.text} (Assigned: ${a.assignee || 'unassigned'})`);
    }
    lines.push('');
  }

  // Discussion
  const discussionSection = parsed.sections.find(s => s.name.toLowerCase() === 'discussion');
  if (discussionSection) {
    lines.push('## Discussion');
    for (const line of discussionSection.lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        lines.push(`- [fact] ${trimmed}`);
      }
    }
    lines.push('');
  }

  // Attendees
  if (parsed.metadata.attendees && parsed.metadata.attendees.length > 0) {
    lines.push('## Attendees');
    lines.push(`- ${parsed.metadata.attendees.join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = { parseTranscript, generateMarkdown };
