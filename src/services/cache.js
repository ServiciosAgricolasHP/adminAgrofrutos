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

// Parse the cacheKey suffix back to its params object so we can check filters
// without re-running the full key derivation. Only used inside additive merge.
function parseKeyParams(key, scopePrefix) {
  const prefix = `${scopePrefix}::`;
  if (!key.startsWith(prefix)) return null;
  const suffix = key.slice(prefix.length);
  if (!suffix) return null;
  try { return JSON.parse(suffix); } catch { return null; }
}

// Returns true if the cache entry was built from a "list all" query (no
// where clauses). We refuse to merge into filtered lists because we can't
// know whether the new/changed doc satisfies their predicate.
function isUnfilteredListKey(key, scopePrefix) {
  const p = parseKeyParams(key, scopePrefix);
  if (!p) return false;
  return !p.wheres || p.wheres.length === 0;
}

// Additive cache update: insert (or replace) an item in every cached "list
// all" result for this scope. Used by services that opt into additive
// mutations to avoid re-fetching the entire collection after one write.
// Filtered lists (with `wheres`) are left alone — they will repopulate from
// Firestore on next access.
export function mergeListItem(scopePrefix, item, { idKey = "id" } = {}) {
  if (!item || !item[idKey]) return;
  // mem
  for (const [key, entry] of mem) {
    if (!isUnfilteredListKey(key, scopePrefix)) continue;
    if (!Array.isArray(entry.data)) continue;
    const idx = entry.data.findIndex((x) => x?.[idKey] === item[idKey]);
    const nextData = idx >= 0
      ? entry.data.map((x, i) => (i === idx ? item : x))
      : [...entry.data, item];
    mem.set(key, { ...entry, data: nextData });
  }
  // localStorage
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LS_PREFIX)) continue;
      const baseKey = k.slice(LS_PREFIX.length);
      if (!isUnfilteredListKey(baseKey, scopePrefix)) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      if (!parsed || !Array.isArray(parsed.data)) continue;
      if (parsed.expires <= now()) continue;
      const idx = parsed.data.findIndex((x) => x?.[idKey] === item[idKey]);
      const nextData = idx >= 0
        ? parsed.data.map((x, j) => (j === idx ? item : x))
        : [...parsed.data, item];
      localStorage.setItem(k, JSON.stringify({ data: nextData, expires: parsed.expires }));
    }
  } catch { /* ignore */ }
}

export function removeListItem(scopePrefix, id, { idKey = "id" } = {}) {
  for (const [key, entry] of mem) {
    if (!isUnfilteredListKey(key, scopePrefix)) continue;
    if (!Array.isArray(entry.data)) continue;
    mem.set(key, { ...entry, data: entry.data.filter((x) => x?.[idKey] !== id) });
  }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LS_PREFIX)) continue;
      const baseKey = k.slice(LS_PREFIX.length);
      if (!isUnfilteredListKey(baseKey, scopePrefix)) continue;
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      let parsed;
      try { parsed = JSON.parse(raw); } catch { continue; }
      if (!parsed || !Array.isArray(parsed.data)) continue;
      if (parsed.expires <= now()) continue;
      const filtered = parsed.data.filter((x) => x?.[idKey] !== id);
      localStorage.setItem(k, JSON.stringify({ data: filtered, expires: parsed.expires }));
    }
  } catch { /* ignore */ }
}
