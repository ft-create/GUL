/* GUL — cloud layer. Firebase Auth + Firestore sync, offline-first.
 *
 * The app is fully functional without an account: notes and settings
 * live in localStorage. When the user signs in, everything mirrors to
 * Firestore under gulUsers/{uid} and merges across devices — newest
 * write wins, per document. If the SDK can't load (offline, blocked
 * CDN) the app silently stays local.
 *
 * Data model:
 *   gulUsers/{uid}                       { settings, updatedAt }
 *   gulUsers/{uid}/days/{YYYY-MM-DD}     { p: {fajr:true,...}, u: millis }
 */

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyD6jN5hO3PD6opQkzl3FBLB2K52lJtfR-Y',
  authDomain: 'pray-now-15f80.firebaseapp.com',
  projectId: 'pray-now-15f80',
  storageBucket: 'pray-now-15f80.firebasestorage.app',
  messagingSenderId: '861447478625',
  appId: '1:861447478625:web:a6c761b2fa5caf9dba7920',
};

const V = '10.12.5';
const CDN = `https://www.gstatic.com/firebasejs/${V}`;

export const Sync = {
  user: null,
  ready: false,        // SDK loaded and auth state known
  online: false,       // signed in and Firestore reachable
  lastPush: null,
  remoteU: {},         // dateKey -> last-seen remote updatedAt
  remoteSettingsU: 0,
  onChange: null,      // () => void — re-render auth UI
  onRemoteNotes: null, // (dateKey, docData) => void — merge one day
  onRemoteSettings: null,
  onFirstSync: null,   // () => void — after first snapshot; push local-only data
  _fb: null,
  _unsub: [],

  async init() {
    try {
      const [{ initializeApp }, auth, fs] = await Promise.all([
        import(`${CDN}/firebase-app.js`),
        import(`${CDN}/firebase-auth.js`),
        import(`${CDN}/firebase-firestore.js`),
      ]);
      const app = initializeApp(FIREBASE_CONFIG);
      const a = auth.getAuth(app);
      const db = fs.getFirestore(app);
      this._fb = { auth: a, db, fs, authMod: auth };
      auth.onAuthStateChanged(a, u => this._setUser(u));
    } catch (e) {
      console.warn('Gul: cloud unavailable, staying local.', e);
    }
    this.ready = true;
    this.onChange?.();
  },

  async _setUser(u) {
    this._unsub.forEach(f => f());
    this._unsub = [];
    this.user = u;
    this.online = !!u;
    this.onChange?.();
    if (u) await this._subscribe();
  },

  async _subscribe() {
    const { db, fs } = this._fb;
    const uid = this.user.uid;
    this.remoteU = {};
    this.remoteSettingsU = 0;

    // Pull settings once, then watch the days collection.
    try {
      const snap = await fs.getDoc(fs.doc(db, 'gulUsers', uid));
      if (snap.exists() && snap.data().settings) {
        this.remoteSettingsU = snap.data().updatedAt || 0;
        this.onRemoteSettings?.(snap.data().settings, this.remoteSettingsU);
      }
    } catch (e) { console.warn('Gul: settings pull failed', e); }

    try {
      let first = true;
      const u1 = fs.onSnapshot(fs.collection(db, 'gulUsers', uid, 'days'), qs => {
        qs.docChanges().forEach(ch => {
          const d = ch.doc.data();
          this.remoteU[ch.doc.id] = d.u || 0;
          if (ch.type === 'removed') return;
          this.onRemoteNotes?.(ch.doc.id, { p: d.p || {}, u: d.u || 0 });
        });
        if (first) { first = false; this.onFirstSync?.(); }
      }, err => console.warn('Gul: sync listen failed', err));
      this._unsub.push(u1);

      const u2 = fs.onSnapshot(fs.doc(db, 'gulUsers', uid), snap => {
        if (snap.exists() && snap.data().settings) {
          this.remoteSettingsU = snap.data().updatedAt || 0;
          this.onRemoteSettings?.(snap.data().settings, this.remoteSettingsU);
        }
      });
      this._unsub.push(u2);
    } catch (e) { console.warn('Gul: subscribe failed', e); }
  },

  async signIn(email, password) {
    const { auth: a, authMod } = this._fb;
    return authMod.signInWithEmailAndPassword(a, email, password);
  },
  async signUp(email, password) {
    const { auth: a, authMod } = this._fb;
    return authMod.createUserWithEmailAndPassword(a, email, password);
  },
  async resetPassword(email) {
    const { auth: a, authMod } = this._fb;
    return authMod.sendPasswordResetEmail(a, email);
  },
  async signOut() {
    const { auth: a, authMod } = this._fb;
    return authMod.signOut(a);
  },

  async pushDay(dateKey, prayers, updatedAt) {
    if (!this.user || !this._fb) return;
    try {
      const { db, fs } = this._fb;
      await fs.setDoc(
        fs.doc(db, 'gulUsers', this.user.uid, 'days', dateKey),
        { p: prayers, u: updatedAt },
      );
      this.lastPush = Date.now();
      this.lastError = null;
    } catch (e) {
      this.lastError = e;
      console.warn('Gul: day push failed', e);
    }
    this.onChange?.();
  },

  async deleteDay(dateKey) {
    if (!this.user || !this._fb) return;
    try {
      const { db, fs } = this._fb;
      await fs.deleteDoc(fs.doc(db, 'gulUsers', this.user.uid, 'days', dateKey));
      this.lastError = null;
    } catch (e) {
      this.lastError = e;
      console.warn('Gul: day delete failed', e);
    }
    this.onChange?.();
  },

  async pushSettings(settings, updatedAt) {
    if (!this.user || !this._fb) return;
    try {
      const { db, fs } = this._fb;
      await fs.setDoc(
        fs.doc(db, 'gulUsers', this.user.uid),
        { settings, updatedAt },
        { merge: true },
      );
      this.lastPush = Date.now();
      this.lastError = null;
    } catch (e) {
      this.lastError = e;
      console.warn('Gul: settings push failed', e);
    }
    this.onChange?.();
  },
};
