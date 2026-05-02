// Tiny in-memory + localStorage cache with TTL.
// Designed for query results that are read-heavy and tolerate brief staleness.

const mem = new Map();
const LS_PREFIX = "af.cache.";
const SUBS = new Map(); // key prefix -> Set<fn>

const now = () => Date.now();

export function cacheKey(scope, params) {
  return `${scope}::${params ? JSON.stringify(params) : ""}`;
}

function readLS(key) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.expires <= now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLS(key, data, ttl) {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify({ data, expires: now() + ttl }));
  } catch {
    /* quota or serialization — ignore */
  }
}

function dropLS(prefix) {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_PREFIX + prefix)) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

export function getCache(key, { persist = false } = {}) {
  const m = mem.get(key);
  if (m && m.expires > now()) return m.data;
  if (persist) {
    const ls = readLS(key);
    if (ls) {
      mem.set(key, ls);
      return ls.data;
    }
  }
  return undefined;
}

export function setCache(key, data, { ttl = 60_000, persist = false } = {}) {
  const expires = now() + ttl;
  mem.set(key, { data, expires });
  if (persist) writeLS(key, data, ttl);
}

export function invalidate(scopePrefix) {
  for (const k of [...mem.keys()]) {
    if (k.startsWith(`${scopePrefix}::`)) mem.delete(k);
  }
  dropLS(`${scopePrefix}::`);
  const subs = SUBS.get(scopePrefix);
  if (subs) subs.forEach((fn) => { try { fn(); } catch { /* */ } });
}

export function subscribe(scopePrefix, fn) {
  if (!SUBS.has(scopePrefix)) SUBS.set(scopePrefix, new Set());
  SUBS.get(scopePrefix).add(fn);
  return () => SUBS.get(scopePrefix)?.delete(fn);
}
