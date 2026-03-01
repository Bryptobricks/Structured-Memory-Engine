'use strict';

/**
 * Temporal query preprocessor.
 * Detects temporal language in queries and returns date filters + recency boosts.
 *
 * @param {string} query - raw user message
 * @param {Date} [now] - current time (injectable for testing)
 * @returns {{ since: string|null, until: string|null, recencyBoost: number|null, dateTerms: string[], strippedQuery: string, forwardLooking: boolean, forwardTerms: string[] }}
 */
function resolveTemporalQuery(query, now = new Date()) {
  let strippedQuery = query;
  let since = null;
  let until = null;
  let recencyBoost = null;
  let forwardLooking = false;
  const dateTerms = [];
  const forwardTerms = []; // content search terms for forward-looking queries (e.g., month names)

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

  // --- Day-of-week references ---

  const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  // Compound: "day of last week", "last week's day", "day of this last week"
  const DAY_NAMES_RE = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
  const dayOfLastWeekMatch = query.match(
    new RegExp(`\\b(?:(${DAY_NAMES_RE})\\s+(?:of\\s+)?(?:this\\s+)?last\\s+week|last\\s+week(?:'s)?\\s+(${DAY_NAMES_RE}))\\b`, 'i')
  );

  if (dayOfLastWeekMatch && !since) {
    const dayName = (dayOfLastWeekMatch[1] || dayOfLastWeekMatch[2]).toLowerCase();
    const targetDay = DAYS.indexOf(dayName);
    const currentDay = now.getDay();
    const startOfThisWeek = new Date(now);
    startOfThisWeek.setDate(now.getDate() - currentDay);
    const lastWeekDay = new Date(startOfThisWeek);
    lastWeekDay.setDate(startOfThisWeek.getDate() - 7 + targetDay);
    const nextDay = new Date(lastWeekDay);
    nextDay.setDate(nextDay.getDate() + 1);

    since = fmt(lastWeekDay) + 'T00:00:00.000Z';
    until = fmt(nextDay) + 'T00:00:00.000Z';
    dateTerms.push(fmt(lastWeekDay));
    strippedQuery = strippedQuery.replace(dayOfLastWeekMatch[0], '');
  }

  const lastDayMatch = query.match(/\blast\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);
  const onDayMatch = !lastDayMatch && query.match(/\b(?:on\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i);

  if (lastDayMatch && !since) {
    const dayName = lastDayMatch[1].toLowerCase();
    const targetDay = DAYS.indexOf(dayName);
    const currentDay = now.getDay();
    let daysBack = (currentDay - targetDay + 7) % 7;
    if (daysBack === 0) daysBack = 7; // "last monday" on Monday → previous week
    const d = daysAgo(daysBack);
    since = fmt(d) + 'T00:00:00.000Z';
    until = fmt(daysAgo(daysBack - 1)) + 'T00:00:00.000Z';
    dateTerms.push(fmt(d));
    strippedQuery = strippedQuery.replace(lastDayMatch[0], '');
  } else if (onDayMatch && !since) {
    const dayName = onDayMatch[1].toLowerCase();
    const targetDay = DAYS.indexOf(dayName);
    const currentDay = now.getDay();
    const daysBack = (currentDay - targetDay + 7) % 7;
    const d = daysAgo(daysBack);
    since = fmt(d) + 'T00:00:00.000Z';
    until = fmt(daysAgo(daysBack - 1)) + 'T00:00:00.000Z';
    dateTerms.push(fmt(d));
    strippedQuery = strippedQuery.replace(onDayMatch[0], '');
  }

  // --- Range references ---

  if (/\bthis week\b/i.test(query)) {
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay());
    since = fmt(startOfWeek) + 'T00:00:00.000Z';
    recencyBoost = 7;
    strippedQuery = strippedQuery.replace(/\bthis week\b/gi, '');
  }

  if (/\blast week\b/i.test(query) && !since) {
    const endOfLastWeek = new Date(now);
    endOfLastWeek.setDate(now.getDate() - now.getDay());
    const startOfLastWeek = new Date(endOfLastWeek);
    startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);
    since = fmt(startOfLastWeek) + 'T00:00:00.000Z';
    until = fmt(endOfLastWeek) + 'T00:00:00.000Z';
    recencyBoost = 14;
    strippedQuery = strippedQuery.replace(/\blast week\b/gi, '');
  }

  if (/\bnext week\b/i.test(query) && !since) {
    const startOfNextWeek = new Date(now);
    startOfNextWeek.setDate(now.getDate() + (7 - now.getDay()));
    const endOfNextWeek = new Date(startOfNextWeek);
    endOfNextWeek.setDate(startOfNextWeek.getDate() + 7);
    since = fmt(startOfNextWeek) + 'T00:00:00.000Z';
    until = fmt(endOfNextWeek) + 'T00:00:00.000Z';
    recencyBoost = 14;
    forwardLooking = true;
    strippedQuery = strippedQuery.replace(/\bnext week\b/gi, '');
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

  if (/\bnext month\b/i.test(query) && !since) {
    const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const endOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 2, 1);
    since = fmt(startOfNextMonth) + 'T00:00:00.000Z';
    until = fmt(endOfNextMonth) + 'T00:00:00.000Z';
    recencyBoost = 30;
    forwardLooking = true;
    strippedQuery = strippedQuery.replace(/\bnext month\b/gi, '');
  }

  // Named month — "in january", "in march", etc.
  const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const monthMatch = query.match(/\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/i);
  if (monthMatch && !since) {
    const monthName = monthMatch[1].toLowerCase();
    const monthIdx = MONTHS.indexOf(monthName);
    const year = now.getFullYear();
    const startOfMonth = new Date(year, monthIdx, 1);
    const endOfMonth = new Date(year, monthIdx + 1, 1);
    since = fmt(startOfMonth) + 'T00:00:00.000Z';
    until = fmt(endOfMonth) + 'T00:00:00.000Z';
    recencyBoost = 30;
    // Future named month → forward-looking (content about March written in Feb)
    if (startOfMonth > now) {
      forwardLooking = true;
      forwardTerms.push(monthName);
    }
    strippedQuery = strippedQuery.replace(monthMatch[0], '');
  }

  // --- Vague recency ---

  if (/\b(recently|lately)\b/i.test(query)) {
    since = fmt(daysAgo(7)) + 'T00:00:00.000Z';
    recencyBoost = 7;
    strippedQuery = strippedQuery.replace(/\b(recently|lately)\b/gi, '');
  }

  if (/\b(last few days|past few days|last couple days|past couple days)\b/i.test(query) && !since) {
    since = fmt(daysAgo(3)) + 'T00:00:00.000Z';
    recencyBoost = 7;
    strippedQuery = strippedQuery.replace(/\b(last few days|past few days|last couple days|past couple days)\b/gi, '');
  }

  if (/\bwhen did (I|we) (start|begin|stop|quit)\b/i.test(query)) {
    recencyBoost = 90;
    strippedQuery = strippedQuery.replace(/\bwhen did (I|we) (start|begin|stop|quit)\b/gi, '');
  }

  // Detect forward-looking intent from keywords (plans, goals, upcoming, scheduled, etc.)
  if (!forwardLooking && /\b(plan|plans|planned|planning|goal|goals|schedule|scheduled|upcoming|deadline|deadlines|due|milestones?|todo|to-do|coming\s+up)\b/i.test(query)) {
    forwardLooking = true;
  }

  strippedQuery = strippedQuery.replace(/\s+/g, ' ').replace(/\s+([?!.,;:])/g, '$1').trim();

  return { since, until, recencyBoost, dateTerms, strippedQuery, forwardLooking, forwardTerms };
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
