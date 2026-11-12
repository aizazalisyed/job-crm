/*
 * Data layer.
 * The UI only talks to `Store`. Today it uses LocalAdapter (browser localStorage).
 * To move to Firebase, implement FirebaseAdapter with the same methods and
 * switch the adapter at the bottom of this file. The UI does not need to change.
 *
 * Data shapes
 * Job:     { id, title, company, country, city, status, priority, workMode, source,
 *            fitScore, salary, appliedDate, followUpDate, link, contact, language,
 *            visa, notes, createdAt, updatedAt }
 * Contact: { id, name, role, company, email, linkedin, notes, createdAt, updatedAt }
 * Settings:{ countries: [string] }
 */

const STAGES = [
  { key: "Saved", color: "var(--s-saved)" },
  { key: "Applied", color: "var(--s-applied)" },
  { key: "Screening", color: "var(--s-screening)" },
  { key: "Interview", color: "var(--s-interview)" },
  { key: "Offer", color: "var(--s-offer)" },
  { key: "Rejected", color: "var(--s-rejected)" },
  { key: "Withdrawn", color: "var(--s-withdrawn)" }
];

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

class LocalAdapter {
  constructor(prefix = "jobtrack") { this.prefix = prefix; }
  _get(key, fallback) {
    try { const v = localStorage.getItem(`${this.prefix}:${key}`); return v ? JSON.parse(v) : fallback; }
    catch { return fallback; }
  }
  _set(key, value) {
    try { localStorage.setItem(`${this.prefix}:${key}`, JSON.stringify(value)); } catch (e) { console.warn("Storage failed", e); }
  }
  async list(collection) { return this._get(collection, []); }
  async save(collection, item) {
    const items = this._get(collection, []);
    const now = new Date().toISOString();
    if (item.id) {
      const i = items.findIndex(x => x.id === item.id);
      if (i >= 0) items[i] = { ...items[i], ...item, updatedAt: now };
      else items.push({ ...item, createdAt: now, updatedAt: now });
    } else {
      item = { ...item, id: uid(), createdAt: now, updatedAt: now };
      items.push(item);
    }
    this._set(collection, items);
    return item;
  }
  async remove(collection, id) { this._set(collection, this._get(collection, []).filter(x => x.id !== id)); }
  async replaceAll(collection, items) { this._set(collection, items); }
  async getSettings() { return this._get("settings", { countries: ["Estonia", "Lithuania", "Latvia", "Malta", "Cyprus", "Luxembourg"] }); }
  async saveSettings(s) { this._set("settings", s); }
}

// Firebase adapter skeleton. Fill these in with Firestore calls later, e.g.
// list:   getDocs(collection(db, `users/${uid}/${name}`))
// save:   setDoc / addDoc
// remove: deleteDoc
class FirebaseAdapter {
  async list(collection) { throw new Error("FirebaseAdapter.list not implemented"); }
  async save(collection, item) { throw new Error("FirebaseAdapter.save not implemented"); }
  async remove(collection, id) { throw new Error("FirebaseAdapter.remove not implemented"); }
  async replaceAll(collection, items) { throw new Error("FirebaseAdapter.replaceAll not implemented"); }
  async getSettings() { throw new Error("FirebaseAdapter.getSettings not implemented"); }
  async saveSettings(s) { throw new Error("FirebaseAdapter.saveSettings not implemented"); }
}

const useFirebase = window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.enabled;
const Store = useFirebase ? new FirebaseAdapter() : new LocalAdapter();
Store.mode = useFirebase ? "Firebase" : "Local (browser)";
