import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db, auth } from "../firebase";

const LOGS = "logs";

function diff(before, after) {
  if (!before || !after) return null;
  const changes = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    const a = before[k];
    const b = after[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) changes[k] = { from: a ?? null, to: b ?? null };
  }
  return Object.keys(changes).length ? changes : null;
}

export async function logAction({ action, entity, entityId, before = null, after = null, meta = null }) {
  try {
    const user = auth.currentUser;
    await addDoc(collection(db, LOGS), {
      uid: user?.uid || null,
      email: user?.email || null,
      action,
      entity,
      entityId: entityId || null,
      changes: action === "update" ? diff(before, after) : null,
      before: action === "delete" ? before : null,
      after: action === "create" ? after : null,
      meta,
      timestamp: serverTimestamp(),
    });
  } catch (err) {
    console.error("logAction failed", err);
  }
}
