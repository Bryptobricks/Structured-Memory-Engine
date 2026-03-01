'use strict';

const FIELD_START = 0;
const UNQUOTED_FIELD = 1;
const QUOTED_FIELD = 2;
const QUOTE_IN_QUOTED = 3;

/**
 * State machine CSV parser.
 * Handles: quoted fields, escaped quotes (""), newlines in quotes, ragged rows.
 */
function parseCsv(text, options = {}) {
  const delimiter = options.delimiter || ',';
  const hasHeaderOpt = options.hasHeader != null ? options.hasHeader : 'auto';

  if (!text || !text.trim()) {
    return { headers: [], rows: [], metadata: {} };
  }

  const rows = [];
  let currentRow = [];
  let currentField = '';
  let state = FIELD_START;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    switch (state) {
      case FIELD_START:
        if (ch === '"') {
          state = QUOTED_FIELD;
          currentField = '';
        } else if (ch === delimiter) {
          currentRow.push(currentField);
          currentField = '';
        } else if (ch === '\n') {
          currentRow.push(currentField);
          if (currentRow.length > 1 || currentRow[0] !== '') {
            rows.push(currentRow);
          }
          currentRow = [];
          currentField = '';
        } else if (ch === '\r') {
          // skip, handle \r\n
        } else {
          currentField = ch;
          state = UNQUOTED_FIELD;
        }
        break;

      case UNQUOTED_FIELD:
        if (ch === delimiter) {
          currentRow.push(currentField);
          currentField = '';
          state = FIELD_START;
        } else if (ch === '\n') {
          currentRow.push(currentField);
          rows.push(currentRow);
          currentRow = [];
          currentField = '';
          state = FIELD_START;
        } else if (ch === '\r') {
          // skip
        } else {
          currentField += ch;
        }
        break;

      case QUOTED_FIELD:
        if (ch === '"') {
          state = QUOTE_IN_QUOTED;
        } else {
          currentField += ch;
        }
        break;

      case QUOTE_IN_QUOTED:
        if (ch === '"') {
          // Escaped quote
          currentField += '"';
          state = QUOTED_FIELD;
        } else if (ch === delimiter) {
          currentRow.push(currentField);
          currentField = '';
          state = FIELD_START;
        } else if (ch === '\n') {
          currentRow.push(currentField);
          rows.push(currentRow);
          currentRow = [];
          currentField = '';
          state = FIELD_START;
        } else if (ch === '\r') {
          // skip
        } else {
          // Malformed but be lenient — treat as field content
          currentField += ch;
          state = UNQUOTED_FIELD;
        }
        break;
    }
  }

  // Flush last field/row
  if (state !== FIELD_START || currentField !== '' || currentRow.length > 0) {
    currentRow.push(currentField);
    if (currentRow.length > 1 || currentRow[0] !== '') {
      rows.push(currentRow);
    }
  }

  if (rows.length === 0) {
    return { headers: [], rows: [], metadata: {} };
  }

  // Determine if first row is a header
  let headers;
  let dataRows;

  const hasHeader = detectHeader(rows, hasHeaderOpt);
  if (hasHeader) {
    headers = rows[0];
    dataRows = rows.slice(1);
  } else {
    // Generate headers
    const maxCols = Math.max(...rows.map(r => r.length));
    headers = Array.from({ length: maxCols }, (_, i) => `col_${i}`);
    dataRows = rows;
  }

  // Pad ragged rows
  const colCount = headers.length;
  for (let i = 0; i < dataRows.length; i++) {
    while (dataRows[i].length < colCount) {
      dataRows[i].push('');
    }
  }

  return {
    headers,
    rows: dataRows,
    metadata: {
      rowCount: dataRows.length,
      columnCount: headers.length,
      hasHeader,
    },
  };
}

/**
 * Detect whether first row is a header.
 * Auto-detect: if first row looks numeric / same pattern as row 2, treat as data.
 */
function detectHeader(rows, option) {
  if (option === true) return true;
  if (option === false) return false;

  // Auto-detect
  if (rows.length < 2) return true; // single row, treat as header

  const firstRow = rows[0];
  const secondRow = rows[1];

  // If all fields in first row are numeric, it's probably data not headers
  const allNumeric = firstRow.every(f => /^-?\d+(\.\d+)?$/.test(f.trim()));
  if (allNumeric) return false;

  // If first row and second row have the same numeric/non-numeric pattern, likely no header
  const pattern = (row) => row.map(f => /^-?\d+(\.\d+)?$/.test(f.trim()) ? 'N' : 'S').join('');
  if (pattern(firstRow) === pattern(secondRow)) {
    // Same pattern — check if first row looks like labels (non-numeric strings)
    const hasLabels = firstRow.some(f => /^[a-zA-Z]/.test(f.trim()));
    if (!hasLabels) return false;
  }

  return true;
}

/**
 * Generate tagged markdown from parsed CSV data.
 */
function generateMarkdown(parsed, sourceName, options = {}) {
  const entityColumn = options.entityColumn || null;
  const lines = [];
  lines.push(`# CSV Import — ${sourceName}`);
  lines.push('');

  // Data table
  if (parsed.headers.length > 0 && parsed.rows.length > 0) {
    lines.push('## Data');
    lines.push('| ' + parsed.headers.join(' | ') + ' |');
    lines.push('|' + parsed.headers.map(() => '---').join('|') + '|');
    for (const row of parsed.rows) {
      lines.push('| ' + row.join(' | ') + ' |');
    }
    lines.push('');
  }

  // Entities
  if (entityColumn) {
    const colIdx = parsed.headers.indexOf(entityColumn);
    if (colIdx >= 0) {
      const seen = new Map();
      for (let i = 0; i < parsed.rows.length; i++) {
        const val = parsed.rows[i][colIdx];
        if (val && !seen.has(val)) {
          seen.set(val, i + 1);
        }
      }
      if (seen.size > 0) {
        lines.push('## Entities');
        for (const [entity, row] of seen) {
          lines.push(`- **${entity}** — first seen row ${row}`);
        }
        lines.push('');
      }
    }
  }

  // Summary
  lines.push('## Summary');
  lines.push(`- [fact] ${parsed.rows.length} records imported from ${sourceName}`);
  lines.push(`- [fact] Columns: ${parsed.headers.join(', ')}`);
  lines.push('');

  return lines.join('\n');
}

module.exports = { parseCsv, generateMarkdown };
