# GUL — Pray your five

A prayer tracker. Five prayers, five petals, one sun — a full bloom a day.
At night the centre disc turns grey.
Real astronomical prayer times computed in the browser, a living flower for
the day, and optional accounts that sync your record privately across devices.

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
| `brand/` | The full identity kit — lockups, states, mono/ink/brass/night marks, icons |
| `designbrief/` | The GUL design brief, served at `/gul/designbrief` |
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

## Deploy

Production home: **experiment.fareedtareen.com/gul/** — served from the
`public/gul/` folder of the `ft-create/ironcade` (Experiments) repo, which
Cloudflare Pages auto-deploys on every push to `main`. This repo is the
clean, standalone copy of the same app: pull it, and everything here runs
with no build step.

The site is plain static files with **relative paths**, so it also works
from any other sub-path — drag the folder into any static host and it runs.

## The one rule

Nothing in the interface may be decorative. If a pixel moves, it moves
because the sun moved.

Slogan: **Pray your five.** · Store line: *Gul: Salah Tracker & Athan*
