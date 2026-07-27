# Moving Gul

A note to myself, written while everything is fresh, so that a future move is
a boring afternoon rather than an archaeology project.

The short version: **the app is portable, the hosting is trivial to change,
and the two things that will bite are Firebase's authorized domains and the
asset-version lockstep.** Everything below is verified against the code as it
stands, not assumed.

---

## 1. What is already portable

There is **no build step**. No `package.json`, no bundler, no framework, no
transpiler. What is in the repo is what runs in the browser. Copy the folder to
any static host and it works.

**Every internal path is relative** (`./app.js`, `./gul-mark.svg`,
`../solar.js`). That is why the app runs at `/gul/` and would run just as well
at `/`, `/apps/gul/`, or `gul.com`. Nothing needs rewriting.

The prayer engine has **no server and no API key**. `solar.js` computes
NOAA/Meeus solar position on the device. It works offline, on a plane, forever,
with no vendor in the middle. This is the part that would be most painful to
replace and it is the part with zero dependencies.

Runtime network calls, and that is the whole list:

| Host | What for | Removable? |
|---|---|---|
| `fonts.googleapis.com` / `fonts.gstatic.com` | Instrument Serif, DM Sans | Yes — self-host the woff2 files |
| `www.gstatic.com` | Firebase SDK (ES modules, versioned in `firebase.js`) | Only by vendoring the SDK |
| `identitytoolkit.googleapis.com` | The Google sign-in preflight | Dies with Firebase |

---

## 2. What is tied to *this* location

Only three things, and two of them are one line each.

**a. Two absolute links in the design brief.** `designbrief/index.html` has
`href="/"` (back to the experiments hub) and `href="/gul/"` (open the app).
These assume the app lives at `/gul/` on a site whose root is the hub. On a
move, these are the only two paths to change.

**b. The card on the experiments hub.** It lives in a *different repo* —
`ft-create/ironcade`, at `public/index.html` — not here. If Gul moves, that
card's `href="/gul/designbrief"` and `img src="/gul/gul-mark.svg"` need
updating there, or the hub will point at nothing.

**c. Firebase authorized domains.** See §4. This is the one that fails
silently and confusingly.

---

## 3. The data, and how to leave with it

Two halves, and the local half is the source of truth until you sign in.

**Local (works with no account):**

```
localStorage['gul.notes.v2']     → { "2026-07-26": { p: {fajr:true,…}, u: <millis> }, … }
localStorage['gul.settings.v2']  → { place:{name,lat,lon,tz}, method, asrFactor, highLatRule, u }
```

`v1` keys still exist and are migrated on read — do not delete that migration
path until you are sure nobody is running a browser that old.

**Cloud (Firestore, mirrored from local):**

```
gulUsers/{uid}                    → { settings, updatedAt }
gulUsers/{uid}/days/{YYYY-MM-DD}  → { p: {fajr:true,…}, u: <millis> }
```

Conflict rule: **newest `u` wins, per document.** Not per field, not per
account. Keep that if you rewrite the sync layer, or two devices will start
eating each other's days.

To export everything: sign in, then read `gulUsers/{uid}` and its `days`
subcollection. The shape is already plain JSON — no proprietary encoding, no
binary blobs, no server-side transformation. A migration script is a `for`
loop.

---

## 4. Moving to a new host

1. Copy the folder. Serve it. That is genuinely most of it.
2. Fix the two absolute links in `designbrief/index.html` (§2a).
3. Update the hub card in `ft-create/ironcade` if the hub still points here.
4. **Add the new hostname to Firebase → Authentication → Settings →
   Authorized domains.**
5. **If you also change `authDomain`, register the new handler URL in Google
   Cloud Console.** See the trap below — this one has already cost a day.

Step 4 is not optional and its failure mode is nasty. Email/password sign-in
does **not** check that list, so everything will look fine — people can sign
in, notes will sync — and then Google sign-in will send visitors to a generic
**Google Workspace sign-up page**, off your site, with no error and no way
back. That exact thing happened on 26 Jul 2026.

The app defends against it: `Sync.googleAvailable()` in `firebase.js` fetches
the project's authorized-domain list and **hides the Google button** rather
than starting a flow it knows will fail. So on a new domain the button will
quietly vanish until the domain is added — and reappear by itself, no deploy,
once it is. If the button is missing on a new host, this is why.

### The `authDomain` trap

`authDomain` in `FIREBASE_CONFIG` is **`gul.fareedtareen.com`**, not
`pray-now-15f80.firebaseapp.com`. It was changed on 26 Jul 2026, because
Google's account chooser prints the handler's domain — "to continue to …" —
and a project ID nobody recognises reads like a phishing address to the person
being asked for their password. Project IDs can never be renamed, so the fix
was to serve the handler from our own name. `gul.fareedtareen.com` is a
Cloudflare Pages project whose entire contents are one `_worker.js`: it
forwards `/__/*` to `pray-now-15f80.firebaseapp.com` and redirects everything
else to the app. Same handshake, our name on it.

**If you move the app and change `authDomain` again, Firebase will not
finish the job for you.** The new handler URL has to be registered by hand:

- Google Cloud Console → APIs & Services → Credentials → the OAuth 2.0 Client
  ID → **Authorized redirect URIs** → add `https://<authDomain>/__/auth/handler`
- and **Authorized JavaScript origins** → add `https://<authDomain>`

Skip that and Google answers every sign-in with `redirect_uri_mismatch` —
which the visitor sees as a full-page **"Access blocked: this app's request is
invalid."** Off your site, no way back, no clue what went wrong. That is
exactly what happened for the first hours the custom domain was live.

Note what does *not* save you here: `Sync.googleAvailable()` checks Firebase's
authorized-**domain** list, so it hides the button when the *app's* host is
unregistered. It knows nothing about the OAuth client's redirect URIs. In this
failure the button looks perfectly healthy and the flow dies at Google. Two
different lists, two different failure modes, one visible defence.

---

## 5. Moving to a new Firebase project (or off Firebase)

**To a new Firebase project:** replace `FIREBASE_CONFIG` in `firebase.js`, then
re-do three things that live in the console and *not* in the repo:

- **Deploy `firestore.rules`.** The file being committed here means nothing;
  rules are enforced only once deployed. Verify by fetching
  `gulUsers/anything` unauthenticated — a correct setup answers **403
  PERMISSION_DENIED**. A 404 means the rules are open and every account's
  record is readable.
- **Enable the sign-in providers.** Email/Password, and Google if wanted.
  Google also needs a public-facing name and a support email (currently
  `ft@fareedtareen.com`) — both are shown to users on the consent screen.
- **Add the authorized domains,** and **register the OAuth redirect URI and
  JavaScript origin** for whatever `authDomain` you end up with. Per §4 —
  including the part about why the app cannot warn you when you forget.

**Off Firebase entirely:** the seam is narrow on purpose. `firebase.js` is the
only file that knows a cloud exists, and it exposes one object, `Sync`, with a
small surface: `init`, `signIn`, `signUp`, `signInWithGoogle`,
`resendVerification`, `resetPassword`, `signOut`, `pushDay`, `pushSettings`,
and the callbacks `onChange` / `onRemoteNotes` / `onRemoteSettings` /
`onFirstSync`. Reimplement that against anything — Supabase, PocketBase, a
Postgres box — and `app.js` never learns the difference. **The app is fully
functional with `firebase.js` deleted**; it degrades to local-only, which is
the honest fallback and also the migration escape hatch.

---

## 6. Going native

The web app is already a PWA — manifest, service worker, installs to a home
screen, runs offline. What a native build actually buys is **scheduled
notifications**, because a web page cannot reliably wake anyone before Fajr.
That is the only real reason to leave the browser.

A wrapper (Capacitor, or a plain WKWebView/WebView) can carry this code
unchanged; the solar engine and the mark need no porting. Budget the work for
notification scheduling and store paperwork, not for rewriting the app.

---

## 7. The trap that will get you

**Four version markers must move together.** They are:

1. `?v=N` on `styles.css` in `index.html`
2. `?v=N` on `app.js` in `index.html`
3. `?v=N` on the three imports at the top of `app.js`
   (`solar.js`, `cities.js`, `firebase.js`)
4. `CACHE = 'gul-web-vN'` in `sw.js`

`index.html` cannot see inside a module graph. Bump the entry point but not the
imports, and a browser will happily run a **new `app.js` against a cached
`firebase.js`** — which is how `Sync.signInWithGoogle is not a function`
appeared in production. All four, every deploy, or the graph tears.

Also: bump `CACHE` in `sw.js` or returning visitors keep the old shell
regardless of what you deployed.

---

## 8. What must not be lost in any move

Two properties are the product, not implementation details:

- **The times are computed, not fetched.** No API key, no network, no vendor
  who can deprecate you. If a migration introduces a prayer-times API, the app
  has become something else.
- **The sun never lies.** Solar motion is linear, 600ms, and reflects real
  altitude. Dragging the aperture moves *the clock*, never the sun's
  relationship to it. Human motion eases; solar motion does not. Keep the two
  families separate.

And one honest limit worth keeping in the copy: Gul knows where the sun is, not
whether you prayed.
