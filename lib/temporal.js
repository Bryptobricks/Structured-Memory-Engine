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
  const DAY_ABBREVS = { sun: 'sunday', mon: 'monday', tue: 'tuesday', tues: 'tuesday', wed: 'wednesday', thu: 'thursday', thur: 'thursday', thurs: 'thursday', fri: 'friday', sat: 'saturday' };
  function normalizeDayName(name) {
    const lower = name.toLowerCase();
    return DAY_ABBREVS[lower] || lower;
  }

  // Compound: "day of last week", "last week's day", "day of this last week"
  const DAY_NAMES_RE = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun';
  const dayOfLastWeekMatch = query.match(
    new RegExp(`\\b(?:(${DAY_NAMES_RE})\\s+(?:of\\s+)?(?:this\\s+)?last\\s+week|last\\s+week(?:'s)?\\s+(${DAY_NAMES_RE}))\\b`, 'i')
  );

  if (dayOfLastWeekMatch && !since) {
    const dayName = normalizeDayName(dayOfLastWeekMatch[1] || dayOfLastWeekMatch[2]);
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

  const lastDayMatch = query.match(new RegExp(`\\b(?:last|past|previous)\\s+(${DAY_NAMES_RE})\\b`, 'i'));
  const thisDayMatch = !lastDayMatch && query.match(new RegExp(`\\b(?:this|current)\\s+(${DAY_NAMES_RE})\\b`, 'i'));
  const nextDayMatch = !lastDayMatch && !thisDayMatch && query.match(new RegExp(`\\bnext\\s+(${DAY_NAMES_RE})\\b`, 'i'));
  const onDayMatch = !lastDayMatch && !thisDayMatch && !nextDayMatch && query.match(new RegExp(`\\b(?:on\\s+)?(${DAY_NAMES_RE})\\b`, 'i'));

  if (lastDayMatch && !since) {
    const dayName = normalizeDayName(lastDayMatch[1]);
    const targetDay = DAYS.indexOf(dayName);
    const currentDay = now.getDay();
    let daysBack = (currentDay - targetDay + 7) % 7;
    if (daysBack === 0) daysBack = 7; // "last monday" on Monday → previous week
    const d = daysAgo(daysBack);
    since = fmt(d) + 'T00:00:00.000Z';
    until = fmt(daysAgo(daysBack - 1)) + 'T00:00:00.000Z';
    dateTerms.push(fmt(d));
    strippedQuery = strippedQuery.replace(lastDayMatch[0], '');
  } else if (thisDayMatch && !since) {
    const dayName = normalizeDayName(thisDayMatch[1]);
    const targetDay = DAYS.indexOf(dayName);
    const currentDay = now.getDay();
    if (targetDay === currentDay) {
      // "this tuesday" on Tuesday → today
      since = fmt(now) + 'T00:00:00.000Z';
      const nextDay = new Date(now);
      nextDay.setDate(nextDay.getDate() + 1);
      until = fmt(nextDay) + 'T00:00:00.000Z';
      dateTerms.push(fmt(now));
    } else {
      // "this friday" on Tuesday → friday of this week (forward or back)
      const diff = targetDay - currentDay;
      const d = new Date(now);
      d.setDate(d.getDate() + diff);
      const nextDay = new Date(d);
      nextDay.setDate(nextDay.getDate() + 1);
      since = fmt(d) + 'T00:00:00.000Z';
      until = fmt(nextDay) + 'T00:00:00.000Z';
      dateTerms.push(fmt(d));
      if (diff > 0) forwardLooking = true;
    }
    strippedQuery = strippedQuery.replace(thisDayMatch[0], '');
  } else if (nextDayMatch && !since) {
    const dayName = normalizeDayName(nextDayMatch[1]);
    const targetDay = DAYS.indexOf(dayName);
    const currentDay = now.getDay();
    let daysForward = (targetDay - currentDay + 7) % 7;
    if (daysForward === 0) daysForward = 7; // "next tuesday" on Tuesday → next week
    const d = new Date(now);
    d.setDate(d.getDate() + daysForward);
    const nextDay = new Date(d);
    nextDay.setDate(nextDay.getDate() + 1);
    since = fmt(d) + 'T00:00:00.000Z';
    until = fmt(nextDay) + 'T00:00:00.000Z';
    dateTerms.push(fmt(d));
    forwardLooking = true;
    strippedQuery = strippedQuery.replace(nextDayMatch[0], '');
  } else if (onDayMatch && !since) {
    const dayName = normalizeDayName(onDayMatch[1]);
    const targetDay = DAYS.indexOf(dayName);
    if (targetDay !== -1) {
      const currentDay = now.getDay();
      const daysBack = (currentDay - targetDay + 7) % 7;
      const d = daysAgo(daysBack);
      since = fmt(d) + 'T00:00:00.000Z';
      until = fmt(daysAgo(daysBack - 1)) + 'T00:00:00.000Z';
      dateTerms.push(fmt(d));
      strippedQuery = strippedQuery.replace(onDayMatch[0], '');
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

  // Specific date — "February 23", "Feb 23 2026", "on March 1st", etc.
  // Must come BEFORE named month block so "February 23" doesn't get caught by "in February"
  const MONTH_ABBREVS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const MONTH_FULL = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
  const ALL_MONTHS = { ...MONTH_ABBREVS, ...MONTH_FULL };
  const monthNamePattern = Object.keys(ALL_MONTHS).join('|');

  const specificDateMatch = query.match(
    new RegExp(`\\b(?:on\\s+)?(${monthNamePattern})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'i')
  );

  if (specificDateMatch && !since) {
    const monthName = specificDateMatch[1].toLowerCase();
    const day = parseInt(specificDateMatch[2]);
    const year = specificDateMatch[3] ? parseInt(specificDateMatch[3]) : now.getFullYear();
    const monthIdx = ALL_MONTHS[monthName];

    if (monthIdx !== undefined && day >= 1 && day <= 31) {
      const targetDate = new Date(year, monthIdx, day);
      const nextDay = new Date(year, monthIdx, day + 1);
      since = fmt(targetDate) + 'T00:00:00.000Z';
      until = fmt(nextDay) + 'T00:00:00.000Z';
      dateTerms.push(fmt(targetDate));
      strippedQuery = strippedQuery.replace(specificDateMatch[0], '');
    }
  }

  // ISO date — "2026-02-23", "on 2026-02-23"
  const isoDateMatch = query.match(/\b(?:on\s+)?(\d{4}-\d{2}-\d{2})\b/);
  if (isoDateMatch && !since) {
    const dateStr = isoDateMatch[1];
    const [y, m, d] = dateStr.split('-').map(Number);
    const targetDate = new Date(y, m - 1, d);
    const nextDay = new Date(y, m - 1, d + 1);
    since = fmt(targetDate) + 'T00:00:00.000Z';
    until = fmt(nextDay) + 'T00:00:00.000Z';
    dateTerms.push(fmt(targetDate));
    strippedQuery = strippedQuery.replace(isoDateMatch[0], '');
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

// --- Referenced date extraction (v9: three-date temporal model) ---

const MONTH_ABBREVS_EXT = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const MONTH_FULL_EXT = { january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 };
const ALL_MONTHS_EXT = { ...MONTH_ABBREVS_EXT, ...MONTH_FULL_EXT };
const MONTH_NAMES_RE = Object.keys(ALL_MONTHS_EXT).join('|');

const DAYS_EXT = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_ABBREVS_EXT = { sun: 'sunday', mon: 'monday', tue: 'tuesday', tues: 'tuesday', wed: 'wednesday', thu: 'thursday', thur: 'thursday', thurs: 'thursday', fri: 'friday', sat: 'saturday' };

/**
 * Extract a referenced date from content being stored.
 * Returns { referencedDate: string|null, relativeOffset: number|null }
 *
 * @param {string} content - chunk content
 * @param {Date} [now] - reference time (defaults to now, injectable for testing)
 */
function extractReferencedDate(content, now = new Date()) {
  if (!content || content.length < 5) return { referencedDate: null, relativeOffset: null };

  const fmt = (d) => d.toISOString().split('T')[0];
  const nowDate = fmt(now);

  // Priority 1: ISO date — "2026-04-15"
  const isoMatch = content.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const [, y, m, d] = isoMatch.map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const target = new Date(y, m - 1, d);
      const offset = Math.round((target.getTime() - now.getTime()) / 86400000);
      return { referencedDate: fmt(target), relativeOffset: offset };
    }
  }

  // Priority 2: US date — "12/22/1997", "03/15/2026"
  const usDateMatch = content.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (usDateMatch) {
    const [, m, d, y] = usDateMatch.map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      const target = new Date(y, m - 1, d);
      const offset = Math.round((target.getTime() - now.getTime()) / 86400000);
      return { referencedDate: fmt(target), relativeOffset: offset };
    }
  }

  // Priority 3: Named date — "January 31", "Feb 5th", "March 5th 2026"
  const namedDateMatch = content.match(
    new RegExp(`\\b(${MONTH_NAMES_RE})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:[,\\s]+(\\d{4}))?\\b`, 'i')
  );
  if (namedDateMatch) {
    const monthName = namedDateMatch[1].toLowerCase();
    const day = parseInt(namedDateMatch[2]);
    const year = namedDateMatch[3] ? parseInt(namedDateMatch[3]) : now.getFullYear();
    const monthIdx = ALL_MONTHS_EXT[monthName];
    if (monthIdx !== undefined && day >= 1 && day <= 31) {
      const target = new Date(year, monthIdx, day);
      const offset = Math.round((target.getTime() - now.getTime()) / 86400000);
      return { referencedDate: fmt(target), relativeOffset: offset };
    }
  }

  // Priority 4: Relative references — "yesterday", "last Tuesday", "in 3 days", "next week"
  if (/\byesterday\b/i.test(content)) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    return { referencedDate: fmt(d), relativeOffset: -1 };
  }

  if (/\btomorrow\b/i.test(content)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return { referencedDate: fmt(d), relativeOffset: 1 };
  }

  if (/\btoday\b/i.test(content)) {
    return { referencedDate: nowDate, relativeOffset: 0 };
  }

  // "in N days" / "N days from now"
  const inDaysMatch = content.match(/\bin\s+(\d+)\s+days?\b/i) || content.match(/\b(\d+)\s+days?\s+from\s+now\b/i);
  if (inDaysMatch) {
    const n = parseInt(inDaysMatch[1]);
    const d = new Date(now);
    d.setDate(d.getDate() + n);
    return { referencedDate: fmt(d), relativeOffset: n };
  }

  // "N days ago"
  const agoMatch = content.match(/\b(\d+)\s+days?\s+ago\b/i);
  if (agoMatch) {
    const n = parseInt(agoMatch[1]);
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    return { referencedDate: fmt(d), relativeOffset: -n };
  }

  // "last/next Tuesday" etc.
  const DAY_NAMES_CONTENT_RE = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun';
  const lastDayMatch = content.match(new RegExp(`\\b(?:last|past|previous)\\s+(${DAY_NAMES_CONTENT_RE})\\b`, 'i'));
  if (lastDayMatch) {
    const dayName = (DAY_ABBREVS_EXT[lastDayMatch[1].toLowerCase()] || lastDayMatch[1].toLowerCase());
    const targetDay = DAYS_EXT.indexOf(dayName);
    if (targetDay !== -1) {
      const currentDay = now.getDay();
      let daysBack = (currentDay - targetDay + 7) % 7;
      if (daysBack === 0) daysBack = 7;
      const d = new Date(now);
      d.setDate(d.getDate() - daysBack);
      return { referencedDate: fmt(d), relativeOffset: -daysBack };
    }
  }

  const nextDayMatch = content.match(new RegExp(`\\bnext\\s+(${DAY_NAMES_CONTENT_RE})\\b`, 'i'));
  if (nextDayMatch) {
    const dayName = (DAY_ABBREVS_EXT[nextDayMatch[1].toLowerCase()] || nextDayMatch[1].toLowerCase());
    const targetDay = DAYS_EXT.indexOf(dayName);
    if (targetDay !== -1) {
      const currentDay = now.getDay();
      let daysForward = (targetDay - currentDay + 7) % 7;
      if (daysForward === 0) daysForward = 7;
      const d = new Date(now);
      d.setDate(d.getDate() + daysForward);
      return { referencedDate: fmt(d), relativeOffset: daysForward };
    }
  }

  return { referencedDate: null, relativeOffset: null };
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

module.exports = { resolveTemporalQuery, isAttributionQuery, extractReferencedDate, SPEECH_VERBS };
