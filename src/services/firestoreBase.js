import {
  collection,
  doc,
  addDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  setDoc,
  query,
  where,
  orderBy,
  limit,
  serverTimestamp,
} from "firebase/firestore";
import { db, auth } from "../firebase";
import { logAction } from "./logger";
import { cacheKey, getCache, setCache, invalidate as invalidateCache } from "./cache";

const stamp = () => ({
  updatedAt: serverTimestamp(),
  updatedBy: auth.currentUser?.uid || null,
});

export function createService(entityName, collectionName = entityName) {
  const col = () => collection(db, collectionName);
  const ref = (id) => doc(db, collectionName, id);
  const scope = collectionName;

  function invalidate() {
    invalidateCache(scope);
  }

  async function list({
    wheres = [],
    order,
    take,
    cache = false,
    ttl = 60_000,
    persist = false,
  } = {}) {
    const key = cacheKey(scope, { wheres, order, take });
    if (cache) {
      const hit = getCache(key, { persist });
      if (hit !== undefined) return hit;
    }
    const parts = [];
    for (const [field, op, value] of wheres) parts.push(where(field, op, value));
    if (order) parts.push(orderBy(order[0], order[1] || "asc"));
    if (take) parts.push(limit(take));
    const q = parts.length ? query(col(), ...parts) : col();
    const snap = await getDocs(q);
    const result = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (cache) setCache(key, result, { ttl, persist });
    return result;
  }

  async function getById(id) {
    const snap = await getDoc(ref(id));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  }

  async function create(data, { id } = {}) {
    const payload = {
      ...data,
      createdAt: serverTimestamp(),
      createdBy: auth.currentUser?.uid || null,
      ...stamp(),
    };
    let docId;
    if (id) {
      await setDoc(ref(id), payload);
      docId = id;
    } else {
      const created = await addDoc(col(), payload);
      docId = created.id;
    }
    invalidate();
    await logAction({ action: "create", entity: entityName, entityId: docId, after: data });
    return { id: docId, ...data };
  }

  async function update(id, data) {
    const before = await getById(id);
    const payload = { ...data, ...stamp() };
    await updateDoc(ref(id), payload);
    invalidate();
    const after = { ...(before || {}), ...data };
    await logAction({ action: "update", entity: entityName, entityId: id, before, after });
    return { id, ...after };
  }

  async function upsert(id, data) {
    const before = await getById(id);
    const payload = before
      ? { ...data, ...stamp() }
      : { ...data, createdAt: serverTimestamp(), createdBy: auth.currentUser?.uid || null, ...stamp() };
    await setDoc(ref(id), payload, { merge: true });
    invalidate();
    const after = { ...(before || {}), ...data };
    await logAction({
      action: before ? "update" : "create",
      entity: entityName,
      entityId: id,
      before: before || null,
      after,
    });
    return { id, ...after };
  }

  async function remove(id) {
    const before = await getById(id);
    await deleteDoc(ref(id));
    invalidate();
    await logAction({ action: "delete", entity: entityName, entityId: id, before });
  }

  return {
    list,
    getById,
    create,
    update,
    upsert,
    remove,
    ref,
    col,
    invalidate,
    name: entityName,
    collectionName,
  };
}
