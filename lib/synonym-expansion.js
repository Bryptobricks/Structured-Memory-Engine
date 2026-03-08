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
  'health': ['bloodwork', 'labs', 'blood', 'medical', 'recovery', 'wellness'],
  'bloodwork': ['labs', 'blood', 'health', 'panels', 'results'],
  'weight': ['lbs', 'pounds', 'body weight', 'mass', 'scale'],
  'sleep': ['recovery', 'rest', 'whoop', 'hrv', 'bedtime'],
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
  'money': ['portfolio', 'holdings', 'allocation', 'net worth', 'funds', 'capital', 'deployed'],
  'portfolio': ['holdings', 'positions', 'allocation', 'deployed', 'stabled', 'money', 'capital'],
  'trading': ['trades', 'positions', 'entries', 'exits', 'buys', 'sells', 'flipping'],
  'crypto': ['tokens', 'coins', 'on-chain', 'defi', 'web3', 'blockchain'],
  'profit': ['gains', 'pnl', 'returns', 'up', 'green'],
  'loss': ['drawdown', 'losses', 'down', 'red', 'underwater'],
  // Work
  'work': ['movement', 'movement labs', 'job', 'day job', 'offsite'],
  'meeting': ['sync', 'call', 'standup', 'check-in', 'huddle'],
  // Priorities
  'priorities': ['priority', 'focus', 'urgency', 'goals', 'targets', 'action items', 'open loops'],
  'priority': ['priorities', 'focus', 'urgency', 'goals', 'targets'],
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
