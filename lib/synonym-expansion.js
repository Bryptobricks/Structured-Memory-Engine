'use strict';

/**
 * v8.0 Synonym & Alias Expansion — bridges vocabulary gaps in recall.
 * "supplements" → finds "stack", "girlfriend" → finds "parri", etc.
 */

const SYNONYM_MAP = {
  // Health / Supplements
  'supplements': ['stack', 'nootropics', 'vitamins', 'medication', 'pills', 'capsules', 'dose', 'dosage'],
  'medication': ['prescription', 'rx', 'drug', 'med', 'meds'],
  'workout': ['gym', 'exercise', 'training', 'lift', 'lifting'],
  // Personal
  'girlfriend': ['partner', 'parri', 'relationship'],
  'partner': ['girlfriend', 'parri', 'relationship'],
  'apartment': ['home', 'place', 'living room', 'bedroom', 'kitchen', 'patio'],
  'lights': ['govee', 'lighting', 'lamps', 'smart lights', 'scenes'],
  // Temporal
  'morning': ['am', 'breakfast', 'wake up', 'start of day'],
  'night': ['evening', 'pm', 'bedtime', 'late', 'end of day'],
  'routine': ['protocol', 'schedule', 'daily', 'habit', 'ritual'],
  // Finance
  'portfolio': ['holdings', 'positions', 'allocation', 'deployed', 'stabled'],
  'trading': ['trades', 'positions', 'entries', 'exits', 'buys', 'sells', 'flipping'],
  // Dev
  'agent': ['clawd', 'assistant', 'bot', 'ai'],
  'build': ['ship', 'implement', 'code', 'develop', 'create'],
};

function mergeWithAliases(aliases, synonymMap) {
  const merged = { ...aliases };
  for (const [key, syns] of Object.entries(synonymMap)) {
    if (merged[key]) {
      merged[key] = [...new Set([...merged[key], ...syns])];
    } else {
      merged[key] = syns;
    }
  }
  return merged;
}

function expandWithSynonyms(queryTerms, synonymMap) {
  const originalTerms = new Set(queryTerms.map(t => t.toLowerCase()));
  const synonymOnlyTerms = new Set();
  for (const term of queryTerms) {
    const key = term.toLowerCase();
    const syns = synonymMap[key];
    if (syns) {
      for (const s of syns) {
        if (!originalTerms.has(s.toLowerCase())) synonymOnlyTerms.add(s.toLowerCase());
      }
    }
  }
  return { originalTerms, synonymOnlyTerms };
}

function isSynonymOnlyMatch(content, originalTerms) {
  const lower = content.toLowerCase();
  for (const term of originalTerms) {
    if (lower.includes(term)) return false;
  }
  return true;
}

module.exports = { SYNONYM_MAP, mergeWithAliases, expandWithSynonyms, isSynonymOnlyMatch };
