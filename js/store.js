/*
 * Data layer.
 * The UI only talks to `Store`, which is backed by Firebase (Firestore + Google sign-in).
 * Nothing is stored in the browser: Firestore runs with an in-memory cache only, and all
 * data is fetched from Firebase after sign-in.
 *
 * Firestore layout (each user only sees their own data, enforced by firestore.rules):
 *   users/{uid}/jobs/{jobId}
 *   users/{uid}/contacts/{contactId}
 *   users/{uid}/meta/settings       (countries, CV profile, theme, search preferences)
 *   users/{uid}/matches/{id}        (last AI Job Match results, with full job descriptions)
 *   users/{uid}/applications/{jobId} (tailored CV, cover letter and answers per job)
 *   users/{uid}/private/keys        (Claude API key, Apify token)
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
    // Memory cache only: no copy of your data is written to the browser's storage.
    this.db = F.initializeFirestore(this.app, { ignoreUndefinedProperties: true });
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

  async getOne(name, id) {
    const snap = await this.F.getDoc(this.F.doc(this._col(name), id));
    return snap.exists() ? { ...snap.data(), id: snap.id } : null;
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

  // API keys live in their own private doc (users/{uid}/private/keys), separate from
  // settings so they never end up in JSON exports. Protected by firestore.rules.
  _keysRef() { return this.F.doc(this.db, "users", this.user.uid, "private", "keys"); }
  async getKeys() {
    const snap = await this.F.getDoc(this._keysRef());
    return snap.exists() ? snap.data() : { anthropicKey: "", apifyToken: "", model: "" };
  }
  async saveKeys(keys) { await this.F.setDoc(this._keysRef(), { ...keys, updatedAt: new Date().toISOString() }); }

  // Generic single documents under users/{uid}/meta/{name}
  async getMeta(name) {
    const snap = await this.F.getDoc(this.F.doc(this.db, "users", this.user.uid, "meta", name));
    return snap.exists() ? snap.data() : null;
  }
  async saveMeta(name, data) { await this.F.setDoc(this.F.doc(this.db, "users", this.user.uid, "meta", name), data); }
}

const Store = new FirebaseAdapter(window.FIREBASE_CONFIG || {});
