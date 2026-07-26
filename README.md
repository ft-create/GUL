# GUL — Pray with the sun

An Islamic prayer tracker. Five prayers, five petals — a full bloom a day.
Real astronomical prayer times computed in the browser, a living flower for
the day, and optional accounts that sync a private garden across devices.

## What's here

| File | Purpose |
| --- | --- |
| `index.html` | The whole app shell — Today, Timetable, History, Settings, auth modal |
| `styles.css` | The design system (night palette, one warm sun colour, motion laws) |
| `solar.js` | Solar engine — NOAA/Meeus solar position + prayer times, no dependencies |
| `cities.js` | Offline world gazetteer (~100 cities, IANA timezones) + search |
| `firebase.js` | Cloud layer — Firebase Auth + Firestore sync, offline-first |
| `app.js` | Application logic — the flower, the Aperture, notes, sync, settings |
| `sw.js` | Service worker — offline shell |
| `manifest.webmanifest` | PWA manifest (installable) |
| `firestore.rules` | Security rules — deploy these to the Firebase project |

## How it works

- **Times are computed locally** by `solar.js` for any coordinates on Earth,
  with all ten common calculation conventions, Standard/Ḥanafī Asr, and
  three high-latitude rules. No API key, works offline.
- **Location**: search the built-in gazetteer, tap a quick city, or use the
  device's precise geolocation (device timezone is used for GPS location).
- **Notes** live in `localStorage` first. The app is complete without an
  account. Signing in mirrors notes and settings to Firestore under
  `gulUsers/{uid}` and merges across devices — newest write wins per day.
- **Qibla** bearing is computed great-circle from the chosen place.

## Firebase setup (one-time, ~2 minutes)

The app is wired to project `pray-now-15f80`.

1. **Auth**: Firebase console → Authentication → Sign-in method → enable
   **Email/Password**. (Already working in production.)
2. **Rules**: Firestore → Rules → replace/merge with `firestore.rules`
   from this repo, then Publish. This makes every user's data private to
   themselves and closes everything else.
3. That's it — no Functions, no server. The web config in `firebase.js` is
   the public client config and is safe to ship; access is governed by the
   rules.

## Deploy to Cloudflare Pages (pray-now.pages.dev/gul/)

The site is plain static files with **relative paths**, so it works from any
sub-path. Either:

- connect this repo to Pages and set the output directory to the repo root,
  then serve this folder as `/gul/` (e.g. copy into `public/gul/` of the
  existing Pages project), or
- drag-and-drop this folder into a Pages direct-upload deploy.

No build step. `.nvmrc` is only there to keep Pages' auto-detection calm.

## The one rule

Nothing in the interface may be decorative. If a pixel moves, it moves
because the sun moved.
