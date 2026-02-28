'use strict';

/**
 * Temporal query preprocessor.
 * Detects temporal language in queries and returns date filters + recency boosts.
 *
 * @param {string} query - raw user message
 * @param {Date} [now] - current time (injectable for testing)
 * @returns {{ since: string|null, until: string|null, recencyBoost: number|null, dateTerms: string[], strippedQuery: string }}
 */
function resolveTemporalQuery(query, now = new Date()) {
  let strippedQuery = query;
  let since = null;
  let until = null;
  let recencyBoost = null;
  const dateTerms = [];

  const fmt = (d) => d.toISOString().split('T')[0];
  const daysAgo = (n) => {
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return d;
  };

  // --- Exact day references ---

  if (/\b(today|this morning|tonight|this evening)\b/i.test(query)) {
    since = fmt(now) + 'T00:00:00.000Z';
    dateTerms.push(fmt(now));
    strippedQuery = strippedQuery.replace(/\b(today|this morning|tonight|this evening)\b/gi, '');
  }

  if (/\byesterday\b/i.test(query)) {
    const yd = daysAgo(1);
    since = fmt(yd) + 'T00:00:00.000Z';
    until = fmt(now) + 'T00:00:00.000Z';
    dateTerms.push(fmt(yd));
    strippedQuery = strippedQuery.replace(/\byesterday\b/gi, '');
  }

  if (/\b(day before yesterday|two days ago|2 days ago)\b/i.test(query)) {
    const d = daysAgo(2);
    since = fmt(d) + 'T00:00:00.000Z';
    until = fmt(daysAgo(1)) + 'T00:00:00.000Z';
    dateTerms.push(fmt(d));
    strippedQuery = strippedQuery.replace(/\b(day before yesterday|two days ago|2 days ago)\b/gi, '');
  }

  const daysAgoMatch = query.match(/\b(\d+)\s*days?\s*ago\b/i);
  if (daysAgoMatch && !since) {
    const n = parseInt(daysAgoMatch[1]);
    if (n > 0 && n < 365) {
      const d = daysAgo(n);
      since = fmt(d) + 'T00:00:00.000Z';
      until = fmt(daysAgo(n - 1)) + 'T00:00:00.000Z';
      dateTerms.push(fmt(d));
      strippedQuery = strippedQuery.replace(daysAgoMatch[0], '');
    }
  }

  // --- Range references ---

  if (/\bthis week\b/i.test(query)) {
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    since = fmt(startOfWeek) + 'T00:00:00.000Z';
    recencyBoost = 7;
    strippedQuery = strippedQuery.replace(/\bthis week\b/gi, '');
  }

  if (/\blast week\b/i.test(query)) {
    const endOfLastWeek = new Date(now);
    endOfLastWeek.setDate(now.getDate() - now.getDay());
    const startOfLastWeek = new Date(endOfLastWeek);
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);
    since = fmt(startOfLastWeek) + 'T00:00:00.000Z';
    until = fmt(endOfLastWeek) + 'T00:00:00.000Z';
    recencyBoost = 14;
    strippedQuery = strippedQuery.replace(/\blast week\b/gi, '');
  }

  if (/\bthis month\b/i.test(query)) {
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    since = fmt(startOfMonth) + 'T00:00:00.000Z';
    recencyBoost = 14;
    strippedQuery = strippedQuery.replace(/\bthis month\b/gi, '');
  }

  if (/\blast month\b/i.test(query)) {
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    since = fmt(startOfLastMonth) + 'T00:00:00.000Z';
    until = fmt(endOfLastMonth) + 'T00:00:00.000Z';
    recencyBoost = 30;
    strippedQuery = strippedQuery.replace(/\blast month\b/gi, '');
  }

  // --- Vague recency ---

  if (/\b(recently|lately)\b/i.test(query)) {
    since = fmt(daysAgo(7)) + 'T00:00:00.000Z';
    recencyBoost = 7;
    strippedQuery = strippedQuery.replace(/\b(recently|lately)\b/gi, '');
  }

  if (/\bwhen did (I|we) (start|begin|stop|quit)\b/i.test(query)) {
    recencyBoost = 90;
    strippedQuery = strippedQuery.replace(/\bwhen did (I|we) (start|begin|stop|quit)\b/gi, '');
  }

  strippedQuery = strippedQuery.replace(/\s+/g, ' ').replace(/\s+([?!.,;:])/g, '$1').trim();

  return { since, until, recencyBoost, dateTerms, strippedQuery };
}

// --- Attribution query detection ---

const SPEECH_VERBS = /\b(said|say|says|mentioned|mention|mentions|talked|told|tell|tells|asked|ask|asks|suggest|suggested|suggests|argued|argue|argues|discussed|discuss|brought up|pointed out|noted|explained|described|proposed|recommended|warned|claimed|stated|announced|reported)\b/i;

/**
 * Detect if a query is asking about what someone said.
 * Returns { isAttribution, entity } if a known entity + speech verb is found.
 *
 * @param {string} message
 * @param {Set<string>} knownEntities - lowercase entity names
 * @returns {{ isAttribution: boolean, entity: string|null }}
 */
function isAttributionQuery(message, knownEntities) {
  if (!SPEECH_VERBS.test(message)) return { isAttribution: false, entity: null };

  const msgLower = message.toLowerCase();
  for (const entity of knownEntities) {
    if (entity.length >= 2 && msgLower.includes(entity.toLowerCase())) {
      return { isAttribution: true, entity };
    }
  }
  return { isAttribution: false, entity: null };
}

module.exports = { resolveTemporalQuery, isAttributionQuery, SPEECH_VERBS };
