import {
  doc, getDoc, setDoc, deleteDoc,
  collection, query, where, getDocs, documentId,
} from "firebase/firestore";
import { db } from "./firebase";

// Drop-in replacement for the window.storage.{get,set,delete,list} API the
// app was originally built against (that API only exists inside Claude
// artifacts). Every key is stored as its own document in one Firestore
// collection, so the rest of the app didn't need to change at all — only
// these four functions did.
const COLLECTION = "kv_store";

export async function storageSet(key, value) {
  try {
    await setDoc(doc(db, COLLECTION, key), { value, updatedAt: Date.now() });
    return { key, value, shared: true };
  } catch (e) {
    console.error("storageSet failed", key, e);
    return null;
  }
}

export async function storageGet(key) {
  try {
    const snap = await getDoc(doc(db, COLLECTION, key));
    if (!snap.exists()) return null;
    return { key, value: snap.data().value, shared: true };
  } catch (e) {
    console.error("storageGet failed", key, e);
    return null;
  }
}

export async function storageDelete(key) {
  try {
    await deleteDoc(doc(db, COLLECTION, key));
    return { key, deleted: true, shared: true };
  } catch (e) {
    console.error("storageDelete failed", key, e);
    return null;
  }
}

export async function storageList(prefix = "") {
  try {
    const colRef = collection(db, COLLECTION);
    // Prefix match on document ID using Firestore's standard range trick:
    // any doc ID starting with `prefix` sorts between `prefix` and
    // `prefix + '\uf8ff'` (a very high Unicode code point).
    const q = prefix
      ? query(colRef, where(documentId(), ">=", prefix), where(documentId(), "<", prefix + "\uf8ff"))
      : query(colRef);
    const snap = await getDocs(q);
    const keys = [];
    snap.forEach((d) => keys.push(d.id));
    return { keys, prefix, shared: true };
  } catch (e) {
    console.error("storageList failed", prefix, e);
    return null;
  }
}
