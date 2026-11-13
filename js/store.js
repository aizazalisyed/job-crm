/*
 * Data layer.
 * The UI only talks to `Store`. Two adapters share the same methods:
 *   LocalAdapter    : browser localStorage (used when Firebase is disabled)
 *   FirebaseAdapter : Firestore + Google sign-in (used when FIREBASE_CONFIG.enabled is true)
 *
 * Firestore layout (each user only sees their own data, enforced by firestore.rules):
 *   users/{uid}/jobs/{jobId}
 *   users/{uid}/contacts/{contactId}
 *   users/{uid}/meta/settings
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

const DEFAULT_SETTINGS = { countries: ["Estonia", "Lithuania", "Latvia", "Malta", "Cyprus", "Luxembourg"] };
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

class LocalAdapter {
  constructor(prefix = "jobtrack") { this.prefix = prefix; this.mode = "Local (browser)"; this.user = null; }
  async init() { return null; }
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
      if (i >= 0) items[i] = item = { ...items[i], ...item, updatedAt: now };
      else items.push(item = { ...item, createdAt: now, updatedAt: now });
    } else {
      item = { ...item, id: uid(), createdAt: now, updatedAt: now };
      items.push(item);
    }
    this._set(collection, items);
    return item;
  }
  async remove(collection, id) { this._set(collection, this._get(collection, []).filter(x => x.id !== id)); }
  async replaceAll(collection, items) { this._set(collection, items); }
  async getSettings() { return this._get("settings", structuredClone(DEFAULT_SETTINGS)); }
  async saveSettings(s) { this._set("settings", s); }
}

class FirebaseAdapter {
  constructor(config) {
    const { enabled, sdkVersion, ...cfg } = config;
    this.config = cfg;
    this.sdk = sdkVersion || "10.14.1";
    this.mode = "Firebase";
    this.user = null;
  }

  async init() {
    const base = `https://www.gstatic.com/firebasejs/${this.sdk}`;
    const [appMod, A, F] = await Promise.all([
      import(`${base}/firebase-app.js`),
      import(`${base}/firebase-auth.js`),
      import(`${base}/firebase-firestore.js`)
    ]);
    this.A = A; this.F = F;
    this.app = appMod.initializeApp(this.config);
    this.auth = A.getAuth(this.app);
    try {
      // Offline cache: the app keeps working on a bad connection and syncs later.
      this.db = F.initializeFirestore(this.app, {
        ignoreUndefinedProperties: true,
        localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() })
      });
    } catch (e) {
      console.warn("Offline cache unavailable, using memory cache", e);
      this.db = F.initializeFirestore(this.app, { ignoreUndefinedProperties: true });
    }
    // Wait for Firebase to restore any existing session.
    this.user = await new Promise(resolve => {
      const stop = A.onAuthStateChanged(this.auth, u => { stop(); resolve(u); });
    });
    return this.user;
  }

  async signIn() {
    const provider = new this.A.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const res = await this.A.signInWithPopup(this.auth, provider);
    this.user = res.user;
    return res.user;
  }
  async signOut() { await this.A.signOut(this.auth); this.user = null; }

  _col(name) { return this.F.collection(this.db, "users", this.user.uid, name); }
  _settingsRef() { return this.F.doc(this.db, "users", this.user.uid, "meta", "settings"); }

  async list(name) {
    const snap = await this.F.getDocs(this._col(name));
    return snap.docs.map(d => ({ ...d.data(), id: d.id }));
  }

  async save(name, item) {
    const now = new Date().toISOString();
    const { id, ...data } = item;
    const ref = id ? this.F.doc(this._col(name), id) : this.F.doc(this._col(name));
    const out = { ...data, createdAt: data.createdAt || now, updatedAt: now };
    await this.F.setDoc(ref, out, { merge: true });
    return { ...out, id: ref.id };
  }

  async remove(name, id) { await this.F.deleteDoc(this.F.doc(this._col(name), id)); }

  async replaceAll(name, items) {
    const existing = await this.F.getDocs(this._col(name));
    const ops = [
      ...existing.docs.map(d => b => b.delete(d.ref)),
      ...items.map(it => {
        const { id, ...data } = it;
        const ref = id ? this.F.doc(this._col(name), id) : this.F.doc(this._col(name));
        return b => b.set(ref, data);
      })
    ];
    // Firestore batches are capped at 500 writes.
    for (let i = 0; i < ops.length; i += 400) {
      const batch = this.F.writeBatch(this.db);
      ops.slice(i, i + 400).forEach(op => op(batch));
      await batch.commit();
    }
  }

  async getSettings() {
    const snap = await this.F.getDoc(this._settingsRef());
    return snap.exists() ? { ...structuredClone(DEFAULT_SETTINGS), ...snap.data() } : structuredClone(DEFAULT_SETTINGS);
  }
  async saveSettings(s) { await this.F.setDoc(this._settingsRef(), s); }
}

const LocalStore = new LocalAdapter();
const Store = window.FIREBASE_CONFIG && window.FIREBASE_CONFIG.enabled
  ? new FirebaseAdapter(window.FIREBASE_CONFIG)
  : LocalStore;
