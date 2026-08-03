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
  /* Not pray-now-15f80.firebaseapp.com, which is where Firebase actually
     serves the OAuth handler. That host is what Google prints on the account
     chooser — "to continue to pray-now-15f80.firebaseapp.com" — and to anyone
     who did not create the project it reads like a phishing domain. Project
     IDs can never be renamed, so the fix is to serve the handler from a
     domain of ours: gul.fareedtareen.com is a Cloudflare Pages project whose
     functions/__/[[path]].js forwards the whole /__/ namespace straight to
     Firebase. Same handshake, our name on it.

     If Google sign-in ever breaks, check that proxy first — and note this
     domain must also be listed under Firebase → Authentication → Settings →
     Authorized domains, or the flow is rejected before it starts. */
  authDomain: 'gul.fareedtareen.com',
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
      /* A Google sign-in that had to fall back to a full-page redirect
         finishes here, on the way back in. Failures are not worth
         surfacing — onAuthStateChanged is the source of truth either way. */
      /* A Google sign-in that fell back to a full-page redirect lands here
         on the way back in — including, sometimes, a brand-new account. So
         this is a sign-up site too, not just a sign-in one. */
      auth.getRedirectResult(a).then(cred => { if (cred) this._welcome(cred); })
        .catch(() => {});
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
    /* Neither claim nor blame carries across a sign-in. */
    this.lastError = null;
    this.synced = false;
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
    } catch (e) {
      /* A denied read is the loudest possible signal that sync is dead, and
         for two days it went to console.warn and nowhere else. It has to
         reach lastError or the UI will keep claiming success. */
      console.warn('Gul: settings pull failed', e);
      this.lastError = e;
      this.onChange?.();
    }

    try {
      let first = true;
      const u1 = fs.onSnapshot(fs.collection(db, 'gulUsers', uid, 'days'), qs => {
        qs.docChanges().forEach(ch => {
          const d = ch.doc.data();
          this.remoteU[ch.doc.id] = d.u || 0;
          if (ch.type === 'removed') return;
          this.onRemoteNotes?.(ch.doc.id, { p: d.p || {}, u: d.u || 0 });
        });
        /* Proof, not intent: the cloud answered, so reads work. */
        this.synced = true;
        this.lastError = null;
        if (first) { first = false; this.onFirstSync?.(); }
        this.onChange?.();
      }, err => {
        console.warn('Gul: sync listen failed', err);
        this.lastError = err;
        this.synced = false;
        this.onChange?.();
      });
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

  /* Google is one tap and arrives already verified, which is why it is the
     first thing on the card. Two things must be true in the Firebase
     console or this throws: the Google provider has to be enabled, and the
     site's domain has to be in Auth → Settings → Authorized domains. The
     error codes for both are mapped in app.js so the card says which. */
  /* ── Preflight ────────────────────────────────────────────────────────
     Firebase publishes the project's authorized-domain list at an open
     endpoint. Asking it first is the difference between a sentence on the
     card and a one-way trip: if the domain is not on that list, the OAuth
     request is invalid, and Google answers an invalid request by bouncing
     the visitor to a generic Google Workspace sign-up page — off our site,
     with no way back and nothing explaining what happened. A friend who
     lands there is simply lost. So we never start the flow we know will
     fail. A failed probe returns true rather than false: a network hiccup
     should not disable a working button. */
  async googleAvailable() {
    if (this._googleOK !== undefined) return this._googleOK;
    try {
      const r = await fetch(
        `https://identitytoolkit.googleapis.com/v1/projects?key=${FIREBASE_CONFIG.apiKey}`);
      const cfg = await r.json();
      this._googleOK = (cfg.authorizedDomains || []).includes(location.hostname);
    } catch (e) { this._googleOK = true; }
    return this._googleOK;
  },

  /* ── The welcome letter ───────────────────────────────────────────────
     Fired once, on a genuine first sign-up. The server re-checks everything
     that matters — it verifies the ID token itself and refuses accounts
     older than fifteen minutes — so a client that lies achieves nothing
     except mailing its own owner.

     Never awaited by callers, and silent on failure by design: nobody's
     account should fail to be created because a letter did not go out. */
  async _welcome(cred) {
    try {
      if (!cred || !cred.user) return;
      const { authMod } = this._fb;
      const info = authMod.getAdditionalUserInfo?.(cred);
      /* Google hands back the existing account on every later sign-in.
         isNewUser is the only thing separating "just created" from "signed
         in again" — without it, every returning user gets welcomed. When
         the SDK gives us nothing, we let the server's account-age check be
         the guard rather than mailing on a guess. */
      if (info && info.isNewUser === false) return;
      const token = await cred.user.getIdToken();
      const r = await fetch('/api/gul/welcome', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: '{}',
      });
      if (!r.ok) console.warn('Gul: welcome mail not sent —', r.status);
    } catch (e) {
      console.warn('Gul: welcome mail not sent', e);
    }
  },

  async signInWithGoogle() {
    if (!await this.googleAvailable()) {
      const e = new Error('This domain is not authorized for Google sign-in.');
      e.code = 'auth/unauthorized-domain';
      throw e;
    }
    const { auth: a, authMod } = this._fb;
    const provider = new authMod.GoogleAuthProvider();
    /* Always ask which account. A shared laptop should not silently sign
       someone into the last person's record. */
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      const cred = await authMod.signInWithPopup(a, provider);
      this._welcome(cred);          /* not awaited — sign-in must not wait on mail */
      return cred;
    } catch (e) {
      /* Popups die in in-app browsers and some mobile Safari settings. The
         redirect always works; it just leaves the page and comes back. */
      const fallback = ['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'];
      if (fallback.includes(e?.code)) return authMod.signInWithRedirect(a, provider);
      throw e;
    }
  },
  /* A new account gets a verification mail immediately. It is not a gate —
     the app works and syncs straight away — it is so that a typo'd address
     is caught while the person is still sitting there, instead of at the
     moment they need a password reset and cannot receive one. If the mail
     fails to send, the account is still good; we do not fail the sign-up
     over it. */
  async signUp(email, password) {
    const { auth: a, authMod } = this._fb;
    const cred = await authMod.createUserWithEmailAndPassword(a, email, password);
    try { await authMod.sendEmailVerification(cred.user); } catch (e) {
      console.warn('Gul: verification mail did not send', e);
    }
    this._welcome(cred);            /* not awaited — sign-up must not wait on mail */
    return cred;
  },

  /* Offered again from the account panel, because the first mail is the one
     most likely to end up in spam. */
  async resendVerification() {
    const { authMod } = this._fb;
    if (!this.user) throw new Error('not signed in');
    return authMod.sendEmailVerification(this.user);
  },
  get verified() { return !!this.user && this.user.emailVerified !== false; },
  async resetPassword(email) {
    const { auth: a, authMod } = this._fb;
    return authMod.sendPasswordResetEmail(a, email);
  },
  async signOut() {
    const { auth: a, authMod } = this._fb;
    return authMod.signOut(a);
  },

  /* ── Deleting the account ─────────────────────────────────────────────
     Firestore first, then the auth user — never the other way round. The
     security rules key on request.auth.uid, so the moment the auth record
     is gone every one of these deletes would be denied and the person's
     prayer history would be left orphaned in the database forever, with
     nobody able to reach it. Data first is the only safe order.

     Firebase requires a recent login before it will delete an account.
     That is a real protection — it stops someone deleting an account from
     a session left open on a borrowed laptop — so we honour it rather
     than working around it, and re-authenticate in place where we can. */
  async deleteAccount() {
    if (!this._fb) throw new Error('cloud unavailable');
    const { auth: a, authMod, db, fs } = this._fb;
    const u = this.user;
    if (!u) throw new Error('not signed in');

    const wipe = async () => {
      /* Every day document, then the profile that owns them. */
      const days = await fs.getDocs(fs.collection(db, 'gulUsers', u.uid, 'days'));
      for (const d of days.docs) await fs.deleteDoc(d.ref);
      await fs.deleteDoc(fs.doc(db, 'gulUsers', u.uid));
    };

    /* Stop the listeners before deleting, or they fire permission-denied
       errors against documents that are on their way out. */
    this._unsub.forEach(f => f());
    this._unsub = [];

    await wipe();

    try {
      await authMod.deleteUser(u);
    } catch (e) {
      if (e?.code !== 'auth/requires-recent-login') throw e;
      /* Google can prove it is still them without asking for anything. A
         password account cannot, so that person is asked to sign in again
         — their cloud data is already gone either way, which is why the
         caller reports this as "signed out, finish the job". */
      const google = (u.providerData || []).some(p => p.providerId === 'google.com');
      if (!google) { await authMod.signOut(a); const err = new Error('reauth'); err.code = 'gul/reauth-needed'; throw err; }
      const provider = new authMod.GoogleAuthProvider();
      await authMod.reauthenticateWithPopup(u, provider);
      await authMod.deleteUser(u);
    }
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
