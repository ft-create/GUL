/* GUL — the live flower and the aperture, driven by the real sun.
   Times from solar.js (NOAA / Meeus). Offline-first: everything works
   locally; signing in mirrors notes and settings to Firestore. */

import {
  solarDay, altitudeAt, shadowRatioAt, windows, fmtMinutes, METHODS,
} from './solar.js?v=26';
import { QUICK, searchCities } from './cities.js?v=26';
import { Sync } from './firebase.js?v=26';
import { initInstall } from './install.js?v=26';
/* ── Why every internal import carries ?v= ───────────────────────────────
   index.html versions styles.css and app.js, but a module graph is invisible
   to it: app.js pulls solar.js, cities.js and firebase.js by bare path, so a
   deploy that changed only one of those left returning browsers running the
   old copy against new calling code. That is exactly how
   "Sync.signInWithGoogle is not a function" happened — the Google button
   shipped in a fresh app.js while firebase.js came out of cache.

   Bump this number on every deploy that touches any of the three, together
   with the ?v= in index.html and the CACHE name in sw.js. All four move as
   one, or the graph tears again. */

/* ── Geometry: the petal IS the dome — the dome silhouette, stretched.
   Flat base, haunches swelling past the base, a point at the top.
   Construction: base on r=5.6, haunches widest on r=14, apex on r=27.6. ── */
function domePath(L, base, haunch) {
  const r = x => Math.round(x * 100) / 100;
  return `M${r(-base)} 0 C${r(-haunch)} ${r(-0.22 * L)} ${r(-haunch)} ${r(-0.44 * L)} ${r(-haunch * 0.88)} ${r(-0.6 * L)}` +
    ` C${r(-haunch * 0.66)} ${r(-0.76 * L)} ${r(-haunch * 0.3)} ${r(-0.88 * L)} 0 ${r(-L)}` +
    ` C${r(haunch * 0.3)} ${r(-0.88 * L)} ${r(haunch * 0.66)} ${r(-0.76 * L)} ${r(haunch * 0.88)} ${r(-0.6 * L)}` +
    ` C${r(haunch)} ${r(-0.44 * L)} ${r(haunch)} ${r(-0.22 * L)} ${r(base)} 0 Z`;
}
const PETAL = domePath(22, 5.2, 8);
const NIGHT_DISC = '#9AA6AE';   // Isha to first light: a grey disc, never a crescent.

/* ── The sun's colour ramp — eleven stops by altitude ────────────── */
const RAMP = [
  { at: -40, c: [42, 38, 58] }, { at: -30, c: [86, 54, 66] },
  { at: -22, c: [150, 70, 62] }, { at: -14, c: [186, 84, 58] },
  { at: -5, c: [214, 100, 52] }, { at: 1, c: [226, 120, 54] },
  { at: 8, c: [235, 148, 70] }, { at: 20, c: [242, 184, 100] },
  { at: 40, c: [249, 222, 158] }, { at: 58, c: [253, 241, 210] },
  { at: 70, c: [255, 251, 238] },
];
function sunColour(alt, t, day) {
  let lo = RAMP[0], hi = RAMP[RAMP.length - 1];
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (alt >= RAMP[i].at && alt <= RAMP[i + 1].at) { lo = RAMP[i]; hi = RAMP[i + 1]; break; }
  }
  const k = Math.max(0, Math.min(1, (alt - lo.at) / (hi.at - lo.at || 1)));
  const mix = lo.c.map((v, j) => v + (hi.c[j] - v) * k);
  const warm = day && t > day.dhuhr && alt < 30 ? [10, -6, -12] : [0, 0, 0];
  const out = mix.map((v, j) => Math.max(0, Math.min(255, Math.round(v + warm[j]))));
  return `rgb(${out[0]}, ${out[1]}, ${out[2]})`;
}

const METHOD_NOTES = {
  MWL: 'Europe, the Far East and much of the world. Fajr 18°, Isha 17°.',
  ISNA: 'North America, per the Fiqh Council. Fajr 15°, Isha 15°.',
  EGYPT: 'Egypt, Syria, Iraq, Lebanon, Malaysia. Fajr 19.5°, Isha 17.5°.',
  MAKKAH: 'Saudi Arabia. Fajr 18.5°, Isha 90 min after Maghrib (120 in Ramadan).',
  KARACHI: 'Pakistan and the subcontinent. Fajr 18°, Isha 18°.',
  TEHRAN: 'Iran. Fajr 17.7°, Isha 14°.',
  JAFARI: 'Shia Ithna Ashari. Fajr 16°, Isha 14°.',
  TURKEY: 'Diyanet, Turkey. Fajr 18°, Isha 17°.',
  DUBAI: 'Dubai. Fajr 18.2°, Isha 18.2°.',
  SINGAPORE: 'Singapore. Fajr 20°, Isha 18°.',
};

const NAMES = ['Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha'];
const KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
const SUN = '#E9B366';
const KAABA = { lat: 21.4225, lon: 39.8262 };

/* ── Stored state (v2, with migration from v1) ───────────────────── */
const DEFAULT_SETTINGS = {
  place: { name: 'Detroit', lat: 42.3314, lon: -83.0458, tz: 'America/Detroit' },
  method: 'MWL', asrFactor: 1, highLatRule: 'middleOfNight', u: 0,
};

function loadSettings() {
  try {
    const v2 = JSON.parse(localStorage.getItem('gul.settings.v2') || 'null');
    if (v2 && v2.place) return { ...DEFAULT_SETTINGS, ...v2 };
    // migrate v1
    const v1 = JSON.parse(localStorage.getItem('gul.settings.v1') || 'null');
    if (v1) {
      const quick = QUICK.find(c => c.id === v1.cityId);
      const custom = JSON.parse(localStorage.getItem('gul.place.v1') || 'null');
      return {
        ...DEFAULT_SETTINGS,
        method: v1.method || 'MWL', asrFactor: v1.asrFactor ?? 1,
        place: v1.cityId === 'custom' && custom ? custom : (quick || DEFAULT_SETTINGS.place),
        u: 0,
      };
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}
function saveSettings() {
  settings.u = Date.now();
  localStorage.setItem('gul.settings.v2', JSON.stringify(settings));
  Sync.pushSettings(publicSettings(), settings.u).catch(() => {});
}
function publicSettings() {
  const { place, method, asrFactor, highLatRule } = settings;
  return { place, method, asrFactor, highLatRule };
}

function loadNotes() {
  try {
    const v2 = JSON.parse(localStorage.getItem('gul.notes.v2') || 'null');
    if (v2) return v2;
    const v1 = JSON.parse(localStorage.getItem('gul.notes.v1') || '{}');
    const migrated = {};
    Object.entries(v1).forEach(([k, p]) => { migrated[k] = { p, u: 0 }; });
    return migrated;
  } catch { return {}; }
}
function saveNotes() {
  localStorage.setItem('gul.notes.v2', JSON.stringify(notes));
}

let settings = loadSettings();
let notes = loadNotes();

function place() { return settings.place; }

/* ── Timezone helpers ────────────────────────────────────────────── */
function partsInTz(date, tz) {
  if (!tz) {
    return { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate(),
             min: date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60 };
  }
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map(x => [x.type, x.value]));
  const h = (+p.hour) % 24;
  return { y: +p.year, m: +p.month, d: +p.day, min: h * 60 + (+p.minute) + (+p.second) / 60 };
}
function tzOffsetMin(date, tz) {
  if (!tz) return -date.getTimezoneOffset();
  const p = partsInTz(date, tz);
  const asUTC = Date.UTC(p.y, p.m - 1, p.d, Math.floor(p.min / 60), Math.floor(p.min % 60), Math.round((p.min % 1) * 60));
  return Math.round((asUTC - date.getTime()) / 60000);
}
const keyOf = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function parseKey(k) { const [y, m, d] = k.split('-').map(Number); return { y, m, d }; }
function shiftKey(k, days) {
  const { y, m, d } = parseKey(k);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return keyOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

/* ── Solar day cache ─────────────────────────────────────────────── */
let dayCache = {};
function dayFor(key) {
  const loc = place();
  const ck = `${key}|${loc.lat},${loc.lon}|${settings.method}|${settings.asrFactor}|${settings.highLatRule}`;
  if (dayCache.key !== ck) {
    const { y, m, d } = parseKey(key);
    const date = new Date(y, m - 1, d, 12);
    const tz = loc.tz ? tzOffsetMin(date, loc.tz) : null;
    dayCache = {
      key: ck,
      day: solarDay(date, loc.lat, loc.lon, tz, {
        method: settings.method, asrFactor: settings.asrFactor, highLatRule: settings.highLatRule,
      }),
    };
  }
  return dayCache.day;
}

function nowParts() { return partsInTz(new Date(), place().tz); }
function todayKey() { const p = nowParts(); return keyOf(p.y, p.m, p.d); }

/* ── Notes + sync ────────────────────────────────────────────────── */
function isNoted(key, prayer) { return !!(notes[key] && notes[key].p[prayer]); }
function toggleNote(key, prayer) {
  const dayN = notes[key] || { p: {}, u: 0 };
  if (dayN.p[prayer]) delete dayN.p[prayer]; else dayN.p[prayer] = true;
  dayN.u = Date.now();
  if (Object.keys(dayN.p).length) notes[key] = dayN;
  else delete notes[key];
  saveNotes();
  /* Unmarking every prayer used to hard-delete the cloud document, and a
     deleted document is invisible to the next device: its snapshot simply
     never mentions the day, so remoteU has no entry, the stale local copy
     looks newer, and the day comes back. Deletion was the only operation
     in the whole model that did not converge.

     A tombstone — an empty p with a fresh timestamp — travels the same
     newest-wins path as every other edit, and mergeRemoteDay already
     removes a day whose p is empty. Nothing special to remember. */
  const out = notes[key] || { p: {}, u: dayN.u };
  Sync.pushDay(key, out.p, out.u).catch(() => {});
}

/* ── The bloom ──────────────────────────────────────────────────────
   One prayer noted, one petal opened, one flare. Fired only from a real
   tap — never on load, never on a timer, never from a remote sync — so
   the mark celebrates the act rather than the state. Marking a prayer
   *off* is silent: taking a note back is a correction, not an event, and
   an animation there would read as the app objecting.                    */
function bloom(index) {
  /* The class is removed again when the animation ends rather than left on the
     element. Two reasons: a stale marker makes the DOM lie about what is
     currently animating, and re-adding it is what restarts the animation on a
     second tap — the reflow read below only helps if it was cleared first. */
  const fire = (node, cls) => {
    if (!node) return;
    node.classList.remove(cls);
    void node.offsetWidth;
    node.classList.add(cls);
    node.addEventListener('animationend', () => node.classList.remove(cls), { once: true });
  };
  fire(document.getElementById('flare'), 'on');
  fire(petalEls[index], 'opened');
}

/* Note a prayer from the interface: record it, redraw, and — only when the
   tap opened a petal rather than closed one — let the flower answer. */
function notePrayer(key, prayer) {
  const opening = !isNoted(key, prayer);
  toggleNote(key, prayer);
  renderAll();
  /* The bloom belongs to today's flower. Correcting last Tuesday from the
     History grid must not make the flower on Today celebrate — that would
     be the app reacting to a date it is not showing. */
  if (opening && key === todayKey()) bloom(KEYS.indexOf(prayer));
}

/* Merge a remote day doc: newest write wins. */
function mergeRemoteDay(key, remote) {
  const local = notes[key];
  if (!local || (remote.u || 0) >= (local.u || 0)) {
    if (Object.keys(remote.p || {}).length) notes[key] = { p: remote.p, u: remote.u };
    else delete notes[key];
    saveNotes();
    renderAll();
  }
}
function mergeRemoteSettings(remote, updatedAt) {
  if ((updatedAt || 0) > (settings.u || 0) && remote && remote.place) {
    settings = { ...DEFAULT_SETTINGS, ...remote, u: updatedAt };
    localStorage.setItem('gul.settings.v2', JSON.stringify(settings));
    dayCache = {};
    renderAll();
  }
}

/* ── Qibla bearing (great-circle, degrees clockwise from north) ──── */
function qiblaBearing(loc) {
  const R = Math.PI / 180;
  const dLon = (KAABA.lon - loc.lon) * R;
  const y = Math.sin(dLon);
  const x = Math.cos(loc.lat * R) * Math.tan(KAABA.lat * R) - Math.sin(loc.lat * R) * Math.cos(dLon);
  return (Math.atan2(y, x) / R + 360) % 360;
}
function compass16(deg) {
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round(deg / 22.5) % 16];
}

/* ── DOM ─────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const el = {
  petals: $('petals'), disc: $('disc'),
  corona: $('corona'), tips: $('tips'),
  greg: $('greg-date'), hijri: $('hijri-date'), placeBtn: $('place-btn'),
  nowName: $('now-name'), nowTime: $('now-time'), nextLabel: $('next-label'),
  qiblaLine: $('qibla-line'), syncLine: $('sync-line'),
  markNow: $('mark-now'), dayTable: $('day-table'),
  polarNote: $('polar-note'), adjustedNote: $('adjusted-note'),
  ap: { sky: $('ap-sky'), shaft: $('ap-shaft'), sun: $('ap-sun'), ground: $('ap-ground'),
        shadow: $('ap-shadow'), gnomon: $('ap-gnomon'), frame: document.querySelector('.aperture-frame'),
        phase: $('ap-phase'), meta: $('ap-meta'), scrub: $('ap-scrub') },
  ttDate: $('tt-date'), ttRows: $('tt-rows'),
  monthTitle: $('month-title'), monthGrid: $('month-grid'),
  dayScrim: $('day-scrim'), daySheetDate: $('day-sheet-date'),
  daySheetCount: $('day-sheet-count'), daySheetRows: $('day-sheet-rows'),
  daySheetNote: $('day-sheet-note'), daySheetClose: $('day-sheet-close'),
  daySheetPrev: $('day-sheet-prev'), daySheetNext: $('day-sheet-next'),
  csRange: $('cs-range'), csStreak: $('cs-streak'), csBest: $('cs-best'),
  csRate: $('cs-rate'), csBars: $('cs-bars'), csNote: $('cs-note'),
  placeName: $('place-name'), placeMeta: $('place-meta'), placeQibla: $('place-qibla'),
  cityRow: $('city-row'), placeSearch: $('place-search'), searchResults: $('search-results'),
  geoBtn: $('geo-btn'), methodList: $('method-list'), asrToggle: $('asr-toggle'), asrNote: $('asr-note'),
  hlToggle: $('hl-toggle'),
  authBtn: $('auth-btn'), authOverlay: $('auth-overlay'), authEmail: $('auth-email'),
  authPass: $('auth-pass'), authError: $('auth-error'),
  accountName: $('account-name'), accountMeta: $('account-meta'), accountAction: $('account-action'),
};

const SVGNS = 'http://www.w3.org/2000/svg';
const petalEls = KEYS.map((k, i) => {
  const p = document.createElementNS(SVGNS, 'path');
  p.setAttribute('d', PETAL);
  p.setAttribute('class', 'petal');
  p.style.transform = `translate(32px,32px) rotate(${i * 72}deg) translate(0px,-5.6px)`;
  p.style.transformOrigin = '0 0';
  el.petals.appendChild(p);
  return p;
});
const tipEls = KEYS.map(k => {
  const d = document.createElement('div');
  d.className = 'tip';
  d.textContent = NAMES[KEYS.indexOf(k)];
  el.tips.appendChild(d);
  return d;
});
/* ── The day table ───────────────────────────────────────────────────────
   Five rows, and the whole row is the button — the reasoning for that is in
   styles.css next to .dt-row. Built once here, repainted by drawDayTable
   below, because the times and the sun discs change with the day and the
   place while the five rows themselves never do.

   The disc is the same one the timetable draws: radius and colour from the
   sun's real altitude at that prayer's minute. That is deliberate — it makes
   this table the flower's own data in a second form rather than a list with
   dots on it. */
const dayRowEls = KEYS.map((k, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'dt-row';
  b.setAttribute('aria-pressed', 'false');
  b.innerHTML =
    '<span class="dt-disc" aria-hidden="true">' +
      '<svg viewBox="-30 -30 60 60" width="24" height="24">' +
        '<circle cx="0" cy="0" r="5" fill="#2A3630"></circle>' +
      '</svg></span>' +
    `<span class="dt-name">${NAMES[i]}</span>` +
    '<span class="dt-time">—</span>' +
    '<span class="dt-state" aria-hidden="true">' +
      '<span class="dt-ring"></span><span class="dt-word">Noted</span>' +
    '</span>';
  b.addEventListener('click', () => notePrayer(todayKey(), k));
  el.dayTable.appendChild(b);
  return b;
});

function drawDayTable(key, day, last) {
  const ws = windows(day, dayFor(shiftKey(key, 1)).fajr);
  dayRowEls.forEach((row, i) => {
    /* Matched by key, not by index. windows() happens to return the five in
       prayer order today, but the rows are built from KEYS and a silent
       re-order would put Isha's time on the Fajr row — wrong in a way nobody
       would notice until it mattered. */
    const w = ws.find(x => x.key === KEYS[i]);
    if (!w) return;
    const on = isNoted(key, KEYS[i]);
    const a = altitudeAt(w.from, day);
    const lift = Math.max(0, Math.min(1, (a + 8) / Math.max(6, day.peakAlt)));
    const disc = row.querySelector('circle');
    disc.setAttribute('r', (4.5 + lift * 4.5).toFixed(1));
    disc.setAttribute('fill', sunColour(a, w.from, day));
    row.querySelector('.dt-time').textContent = fmtMinutes(w.from);
    row.classList.toggle('on', on);
    row.classList.toggle('now', !!last && last.key === w.key);
    row.setAttribute('aria-pressed', on ? 'true' : 'false');
    /* The visible row is name + time + a ring; spoken aloud that ring means
       nothing, so the state goes in the label. */
    row.setAttribute('aria-label',
      `${NAMES[i]} at ${fmtMinutes(w.from)} — ${on ? 'noted' : 'not noted'}`);
  });
}

/* ── The flower ──────────────────────────────────────────────────── */
function drawFlower() {
  const p = nowParts();
  const t = p.min;
  const key = todayKey();
  const day = dayFor(key);
  const alt = altitudeAt(t, day);
  const lift = Math.max(0, Math.min(1, (alt + 8) / Math.max(6, day.peakAlt)));
  const night = t >= day.isha || t < day.fajr;
  const fill = sunColour(alt, t, day);
  const fillSoft = fill.replace('rgb(', 'rgba(').replace(')', ', 0.20)');
  const noted = KEYS.map(k => isNoted(key, k));
  const count = noted.filter(Boolean).length;

  petalEls.forEach((pe, i) => {
    pe.setAttribute('fill', noted[i] ? '#F2EDE3' : 'none');
    pe.setAttribute('stroke', noted[i] ? 'none' : '#F2EDE3');
    pe.setAttribute('stroke-width', noted[i] ? '0' : '1.1');
    pe.setAttribute('opacity', noted[i] ? '1' : '0.4');
  });

  /* The sun: radius, colour and glow follow its real altitude — LINEAR 600ms.
     From Isha to first light the same circle turns grey. Never a crescent. */
  const discR = night ? 7.4 : 7.4 + lift * 3.4;
  const glowPx = night ? 5 : 3 + lift * 7;
  const discFill = night ? NIGHT_DISC : fill;
  el.disc.setAttribute('r', discR.toFixed(2));
  el.disc.setAttribute('fill', discFill);
  el.disc.style.filter = `drop-shadow(0 0 ${glowPx}px ${discFill})`;

  const coronaSize = Math.round(140 + lift * 150);
  el.corona.style.width = el.corona.style.height = coronaSize + 'px';
  el.corona.style.background = `radial-gradient(circle, ${night ? 'rgba(154,166,174,.14)' : fillSoft} 0%, transparent 66%)`;
  el.corona.style.opacity = 0.3 + lift * 0.6;

  // Petal labels around the mark. Apexes reach r=27.6 from the centre.
  const svg = $('flower');
  const px = svg.clientWidth || 300;
  const U = px / 64;
  const Rside = Math.round(27.6 * U + 16);
  const Rtop = Math.round(27.6 * U + 16);
  el.tips.style.width = el.tips.style.height = px + 'px';
  tipEls.forEach((te, i) => {
    const a = (i * 72 - 90) * Math.PI / 180;
    te.style.left = `calc(50% + ${Math.round(Math.cos(a) * Rside)}px)`;
    te.style.top = `calc(50% + ${Math.round(Math.sin(a) * Rtop)}px)`;
    te.style.color = noted[i] ? '#E2E8E2' : '#8C9A93';
  });

  svg.setAttribute('aria-label',
    `${count} of five petals open. The sun is ${alt.toFixed(0)} degrees ${alt >= 0 ? 'above' : 'below'} the horizon.`);

  el.polarNote.hidden = !day.polar;
  el.adjustedNote.hidden = !(day.adjusted && day.adjusted !== 'nearestLatitude');

  return { t, day, noted };
}

/* ── The aperture — a live window onto the sun ───────────────────── */
function drawAperture(t, day) {
  const SIZE = el.ap.frame.clientWidth || 300;
  const alt = altitudeAt(t, day);
  const rising = t < day.transit;
  const glow = Math.max(0, Math.min(1, (alt + 6) / 26));
  const arc = alt / Math.max(6, day.peakAlt);
  const y = arc >= 0 ? arc * SIZE * 0.4 : Math.max(-0.42, arc) * SIZE * 0.33;
  const xf = 0.5 + (t - day.transit) / (2 * Math.max(1, day.sunset - day.transit));

  let sky;
  if (alt > 26) sky = 'linear-gradient(180deg,#4E82AC,#9FBFD4 52%,#E4D6BE)';
  else if (alt > 8) sky = 'linear-gradient(180deg,#5F82A6,#BCAE96 58%,#E9BE87)';
  else if (alt > 0) sky = rising ? 'linear-gradient(180deg,#2C3856,#AE6741 60%,#E9B366)'
                                 : 'linear-gradient(180deg,#2A2C4C,#9E4E3F 58%,#DE8B52)';
  else if (alt > -11) sky = 'linear-gradient(180deg,#0D1424,#312848 54%,#66313A)';
  else sky = 'linear-gradient(180deg,#04070E,#091120 60%,#0F1A26)';

  const gn = SIZE * 0.18;
  const ratio = shadowRatioAt(t, day);
  const len = Math.min(SIZE * 0.79, gn * (isFinite(ratio) ? ratio : 99));
  const sw = Math.min(SIZE * 0.44, len * 0.55);

  el.ap.sky.style.cssText = `inset:0;background:${sky}`;
  el.ap.shaft.style.cssText = `left:50%;top:8%;width:${SIZE * 0.46}px;height:150%;margin-left:-${SIZE * 0.23}px;
    transform-origin:50% 0;transform:rotate(${(xf - 0.5) * 62}deg);
    background:linear-gradient(180deg,${SUN}${glow > .35 ? '2E' : '0F'},transparent 72%);
    filter:blur(9px);opacity:${glow}`;
  el.ap.sun.style.cssText = `left:${Math.max(-6, Math.min(106, xf * 100))}%;bottom:calc(28% + ${y}px);
    width:44px;height:44px;margin-left:-27px;border-radius:50%;
    background:radial-gradient(circle at 50% 42%,#FFF7E6,${SUN} 58%,${SUN}00 78%);
    box-shadow:0 0 ${40 + glow * 90}px ${18 + glow * 40}px ${SUN}${glow > .5 ? '4D' : '26'}`;
  el.ap.ground.style.cssText = `left:0;right:0;bottom:0;height:28%;
    background:linear-gradient(180deg,rgba(${56 + glow * 90 | 0},${46 + glow * 74 | 0},${36 + glow * 52 | 0},${0.5 + glow * 0.45}),#0A1014 78%),
               linear-gradient(180deg,#141C20,#070C10);
    border-top:1px solid ${SUN}${glow > .4 ? '66' : '1A'}`;
  el.ap.shadow.style.cssText = `left:50%;bottom:calc(28% - 3px);height:6px;width:${sw}px;border-radius:3px;
    background:linear-gradient(${rising ? 90 : 270}deg,rgba(6,9,12,${0.72 + glow * 0.24}),rgba(6,9,12,0));
    ${rising ? '' : `margin-left:-${sw}px;`}opacity:${glow > .1 ? 1 : 0}`;
  el.ap.gnomon.style.cssText = `left:50%;bottom:27%;width:4px;height:${gn}px;margin-left:-2px;
    background:linear-gradient(180deg,#5C7A66,#2C4238);filter:brightness(${0.55 + glow * 0.75})`;

  const ws = windows(day, dayFor(shiftKey(todayKey(), 1)).fajr);
  const act = ws.find(w => t >= w.from && t < w.to) || null;
  const nxt = ws.find(w => w.from > t) || { ...ws[0], from: ws[0].from + 1440 };
  el.ap.phase.textContent = act ? `${act.name} — ${act.note}` : 'Between windows';
  el.ap.meta.textContent = `${fmtMinutes(t)} · ${alt > 0 ? '+' : ''}${alt.toFixed(1)}° · ${nxt.name} at ${fmtMinutes(nxt.from)}`;

  const away = scrubT !== null;
  el.ap.scrub.textContent = away ? 'Return to now' : 'Drag the window to move through the day';
  el.ap.scrub.classList.toggle('away', away);
}

/* ── Scrubbing ───────────────────────────────────────────────────────
   The drag moves the clock; the sun then sits wherever the sun really
   is at that minute. Nothing here invents a position — it is the same
   solar function the live view uses, asked about a different time. The
   flower is deliberately left alone: petals record what a person did,
   and dragging a window is not praying. */
let scrubT = null;

(function scrubbing() {
  const frame = el.ap.frame;
  if (!frame) return;
  let active = false;

  const minuteAt = e => {
    const r = frame.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    return Math.round(f * 1439);
  };

  const paint = () => drawAperture(scrubT === null ? nowParts().min : scrubT, dayFor(todayKey()));

  frame.addEventListener('pointerdown', e => {
    active = true;
    frame.setPointerCapture(e.pointerId);
    frame.classList.add('scrubbing');
    scrubT = minuteAt(e);
    paint();
  });

  frame.addEventListener('pointermove', e => {
    if (!active) return;
    scrubT = minuteAt(e);
    paint();
  });

  const release = () => {
    if (!active) return;
    active = false;
    frame.classList.remove('scrubbing');
    paint();   /* the 600ms linear is back; the sun walks home from here */
  };
  frame.addEventListener('pointerup', release);
  frame.addEventListener('pointercancel', release);

  /* Keyboard gets the same reach: a quarter hour a press. */
  frame.tabIndex = 0;
  frame.setAttribute('role', 'slider');
  frame.setAttribute('aria-label', 'Time of day');
  frame.addEventListener('keydown', e => {
    const step = e.key === 'ArrowLeft' ? -15 : e.key === 'ArrowRight' ? 15 : 0;
    if (!step) return;
    e.preventDefault();
    scrubT = Math.max(0, Math.min(1439, (scrubT === null ? nowParts().min : scrubT) + step));
    paint();
  });

  el.ap.scrub.addEventListener('click', () => { scrubT = null; paint(); });
})();

/* ── Now / next ──────────────────────────────────────────────────── */
/* Returns the prayer now standing, and — this is the part that matters —
   the calendar day that prayer belongs to.

   Between midnight and Fajr no window has started yet today, so the
   prayer still standing is YESTERDAY's Isha. The old code fell back to
   ws[4], which is correct about the name and wrong about everything
   else: it printed tonight's Isha start time (nineteen hours in the
   future, labelled "Now") and, worse, wired the button to today's key.
   Tapping it at 3am banked last night's Isha against tomorrow, left
   yesterday unmarked, and broke the streak — in a prayer tracker, the
   one action that must never be wrong. */
function lastAndNext(t, key) {
  const day = dayFor(key);
  const ws = windows(day, dayFor(shiftKey(key, 1)).fajr);
  const started = ws.filter(w => w.from <= t);

  if (!started.length) {
    /* Before today's Fajr. Resolve against yesterday and hand the caller
       yesterday's key, so the time shown and the day written both belong
       to the prayer actually standing. */
    const yKey = shiftKey(key, -1);
    const yDay = dayFor(yKey);
    const yWs = windows(yDay, day.fajr);
    return { day: yDay, dayKey: yKey, last: yWs[4], next: { ...ws[0] }, crossedMidnight: true };
  }

  const last = started[started.length - 1];
  const next = ws.find(w => w.from > t) || { ...ws[0], from: ws[0].from + 1440 };
  return { day, dayKey: key, last, next, crossedMidnight: false };
}

function drawNow(t, key) {
  const { day, dayKey, last, next, crossedMidnight } = lastAndNext(t, key);
  const until = Math.max(0, Math.round(next.from - t));
  el.nowName.textContent = last.name;
  /* Yesterday's Isha started before midnight, so its clock time is on the
     far side of the date line. Saying so is kinder than showing a time
     that looks like it has not happened yet. */
  el.nowTime.textContent = fmtMinutes(last.from) + (crossedMidnight ? ' yesterday' : '');
  el.nextLabel.textContent = `${next.name} in ${Math.floor(until / 60)}h ${until % 60}m`;

  const q = qiblaBearing(place());
  el.qiblaLine.textContent = `Qibla ${q.toFixed(0)}° ${compass16(q)} from where you are`;

  const ki = last.key;
  /* dayKey, never key. This is the whole of the midnight fix. */
  const noted = isNoted(dayKey, ki);
  el.markNow.textContent = noted ? `${last.name} noted` : `Note ${last.name}`;
  el.markNow.classList.toggle('noted', noted);
  el.markNow.onclick = () => notePrayer(dayKey, ki);

  /* The table below still shows the day on screen, which is today. Only
     the standing prayer reaches back across midnight. */
  drawDayTable(key, dayFor(key), crossedMidnight ? null : last);
}

/* ── Header dates & place ────────────────────────────────────────── */
function drawHeader() {
  const p = nowParts();
  const dt = new Date(p.y, p.m - 1, p.d);
  el.greg.textContent = dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  let hijri = '';
  try {
    hijri = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { day: 'numeric', month: 'long', year: 'numeric' }).format(dt);
  } catch {
    try { hijri = new Intl.DateTimeFormat('en-u-ca-islamic', { day: 'numeric', month: 'long', year: 'numeric' }).format(dt); } catch {}
  }
  el.hijri.textContent = hijri;
  el.hijri.dir = 'auto';
  el.placeBtn.textContent = `${place().name} ›`;
}

/* ── Timetable ───────────────────────────────────────────────────── */
let viewKey = todayKey();

function drawTimetable() {
  const key = viewKey;
  const day = dayFor(key);
  const tKey = todayKey();
  const p = nowParts();
  const { y, m, d } = parseKey(key);
  const dt = new Date(y, m - 1, d);
  const loc = place();

  el.ttDate.textContent = `${dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${loc.name}${loc.tz ? ' · ' + loc.tz.replace('_', ' ') : ''}`;

  const ws = windows(day, dayFor(shiftKey(key, 1)).fajr);
  const rows = [
    ws[0],
    { key: 'sunrise', name: 'Sunrise', from: day.sunrise, note: 'Informational. Sunrise is not a prayer and is not marked.', info: true },
    ...ws.slice(1),
  ];

  /* Before today's Fajr the standing prayer belongs to yesterday, so
     nothing on today's timetable should be highlighted as "now". */
  const ln = key === tKey ? lastAndNext(p.min, key) : null;
  const last = ln && !ln.crossedMidnight ? ln.last : null;
  const canMark = key <= tKey;

  el.ttRows.innerHTML = '';
  rows.forEach(w => {
    const row = document.createElement('div');
    row.className = 'tt-row' + (last && last.key === w.key ? ' now' : '');

    const a = altitudeAt(w.from, day);
    const l = Math.max(0, Math.min(1, (a + 8) / Math.max(6, day.peakAlt)));
    const discR = w.info ? 4 : 5 + l * 5;
    const discFill = w.info ? '#2A3630' : sunColour(a, w.from, day);

    const on = !w.info && isNoted(key, w.key);
    row.innerHTML = `
      <div class="tt-disc"><svg viewBox="-30 -30 60 60" width="26" height="26" role="img" aria-label="Sun position">
        <circle cx="0" cy="0" r="${discR.toFixed(1)}" fill="${discFill}"></circle></svg></div>
      <div class="tt-main">
        <div class="tt-name${w.info ? ' info' : ''}">${w.name}</div>
        <div class="tt-sub">${w.note}</div>
      </div>
      <div class="tt-time${w.info ? ' info' : ''}">${fmtMinutes(w.from)}</div>`;

    if (!w.info) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tt-mark' + (on ? ' open' : '');
      b.innerHTML = `<span class="glyph">${on ? '●' : '○'}</span><span style="font-size:12px;white-space:nowrap">${on ? 'Prayed' : 'Not marked'}</span>`;
      if (canMark) b.addEventListener('click', () => notePrayer(key, w.key));
      else { b.disabled = true; b.style.opacity = .45; b.style.cursor = 'default'; }
      row.appendChild(b);
    }
    el.ttRows.appendChild(row);
  });
}

$('day-prev').addEventListener('click', () => { viewKey = shiftKey(viewKey, -1); drawTimetable(); });
$('day-next').addEventListener('click', () => { viewKey = shiftKey(viewKey, 1); drawTimetable(); });

/* ── History ─────────────────────────────────────────────────────── */
let monthOffset = 0; // 0 = current month

function miniFlower(n, size) {
  const petals = KEYS.map((_, i) =>
    `<g transform="rotate(${i * 72}) translate(0,-5.6)"><path d="${PETAL}" fill="#F2EDE3" opacity="${i < n ? 0.95 : 0.1}"></path></g>`).join('');
  return `<svg class="m-flower" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${n} of five noted" style="overflow:visible">
    <g transform="translate(32 32)">${petals}</g>
    <circle cx="32" cy="32" r="${n > 0 ? 5 : 3.4}" fill="${n > 0 ? SUN : '#1E2A24'}"></circle></svg>`;
}

/* ── Consistency ─────────────────────────────────────────────────────
   Three questions a person actually asks of a record: how long is the run,
   how much of it did I note, and which of the five is the one that slips.

   Two rules make the numbers honest, and both matter more than the maths:

   1. The window never begins before the first day you noted anything.
      Counting the days before you had the app as misses would be inventing
      a failure out of an absence of data.
   2. Today counts only the prayers whose windows have already opened.
      Otherwise every morning would report a 40% day at breakfast.

   A prayer with no elapsed windows in range is shown as "—" rather than 0%,
   because zero out of zero is not zero.                                     */
let csDays = 30;

function consistency(days) {
  const tKey = todayKey();
  const min = nowParts().min;
  const today = dayFor(tKey);

  /* A window has opened if its start time has passed. Prayers the solar
     engine could not place today (polar cases) simply do not count. */
  const openToday = k => today[k] != null && isFinite(today[k]) && today[k] <= min;

  const first = Object.keys(notes).sort()[0];
  let start = shiftKey(tKey, -(days - 1));
  let clipped = false;
  if (first && first > start) { start = first; clipped = true; }
  if (!first) return null;

  const per = Object.fromEntries(KEYS.map(k => [k, { done: 0, of: 0 }]));
  let done = 0, of = 0, dayCount = 0;

  for (let k = start; k <= tKey; k = shiftKey(k, 1)) {
    dayCount++;
    KEYS.forEach(pk => {
      if (k === tKey && !openToday(pk)) return;
      per[pk].of++; of++;
      if (isNoted(k, pk)) { per[pk].done++; done++; }
    });
  }
  return { per, done, of, dayCount, start, clipped };
}

/* Consecutive days with all five noted. Today only breaks a run once it is
   over — an incomplete today is a day still in progress, so the count runs
   from yesterday until today is finished. */
function streaks() {
  const tKey = todayKey();
  const full = k => KEYS.every(pk => isNoted(k, pk));

  let cur = 0;
  let k = full(tKey) ? tKey : shiftKey(tKey, -1);
  while (full(k)) { cur++; k = shiftKey(k, -1); }

  let best = 0, run = 0, prev = null;
  Object.keys(notes).filter(full).sort().forEach(kk => {
    run = (prev && shiftKey(prev, 1) === kk) ? run + 1 : 1;
    prev = kk;
    if (run > best) best = run;
  });
  return { cur, best: Math.max(best, cur) };
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function drawConsistency() {
  [...el.csRange.children].forEach(b =>
    b.setAttribute('aria-pressed', String(+b.dataset.d === csDays)));

  const c = consistency(csDays);
  const s = streaks();

  el.csStreak.textContent = c ? plural(s.cur, 'day') : '—';
  el.csBest.textContent = c ? plural(s.best, 'day') : '—';
  el.csStreak.classList.toggle('on', s.cur > 0);
  el.csBest.classList.toggle('on', !!c && s.best > 0);

  if (!c) {
    el.csRate.textContent = '—';
    el.csRate.classList.remove('on');
    el.csBars.innerHTML = '';
    el.csNote.textContent = 'Note your first prayer and this fills in.';
    return;
  }

  const pct = c.of ? Math.round((c.done / c.of) * 100) : 0;
  el.csRate.textContent = `${pct}%`;
  el.csRate.classList.toggle('on', pct >= 80);

  /* One prayer is lit — the one you keep best. Ties go to the earlier
     prayer in the day, which is the order the rows are already in. */
  let bestKey = null, bestRate = -1;
  KEYS.forEach(k => {
    const r = per_rate(c.per[k]);
    if (r !== null && r > bestRate) { bestRate = r; bestKey = k; }
  });

  el.csBars.innerHTML = '';
  KEYS.forEach((k, i) => {
    const { done, of } = c.per[k];
    const r = per_rate(c.per[k]);
    const row = document.createElement('div');
    row.className = 'cs-row' + (k === bestKey && of ? ' best' : '');
    row.innerHTML =
      `<span class="cs-name">${NAMES[i]}</span>` +
      '<span class="cs-track"><span class="cs-fill" style="width:' +
        (r === null ? 0 : Math.round(r * 100)) + '%"></span></span>' +
      `<span class="cs-val">${of ? done + '/' + of : '—'}</span>`;
    row.setAttribute('aria-label',
      `${NAMES[i]} — ${of ? `${done} of ${of} noted` : 'no windows in range yet'}`);
    el.csBars.appendChild(row);
  });

  const sk = parseKey(c.start);
  const since = new Date(sk.y, sk.m - 1, sk.d)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
  el.csNote.textContent = c.clipped
    ? `${c.done} of ${c.of} prayers noted since you started, on ${since}.`
    : `${c.done} of ${c.of} prayers noted over ${plural(c.dayCount, 'day')}.`;
}
function per_rate(x) { return x.of ? x.done / x.of : null; }

el.csRange.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  csDays = +b.dataset.d;
  drawConsistency();
});

function drawHistory() {
  drawConsistency();
  const p = nowParts();
  const tKey = todayKey();
  const base = new Date(p.y, p.m - 1 + monthOffset, 1);
  const my = base.getFullYear(), mm = base.getMonth() + 1;
  el.monthTitle.textContent = base.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const daysInMonth = new Date(my, mm, 0).getDate();
  const firstDow = (new Date(my, mm - 1, 1).getDay() + 6) % 7; // Monday-first

  el.monthGrid.innerHTML = '';
  ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(dw => {
    const h = document.createElement('div');
    h.className = 'dow';
    h.textContent = dw;
    el.monthGrid.appendChild(h);
  });
  for (let i = 0; i < firstDow; i++) el.monthGrid.appendChild(document.createElement('div'));

  for (let d = 1; d <= daysInMonth; d++) {
    const key = keyOf(my, mm, d);
    const n = notes[key] ? Object.keys(notes[key].p).length : 0;
    const future = key > tKey;

    /* A real button, not a div with a handler: the month grid is now the
       way you correct a day you forgot to mark, so it has to be reachable
       by keyboard and announce itself properly. */
    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'm-cell' + (key === tKey ? ' today' : '') + (future ? ' future' : '');
    /* Marked so focus can be handed back after the sheet closes. The node
       itself is no use: saving a correction redraws this whole grid, so the
       element that was clicked no longer exists by then. */
    cell.dataset.key = key;
    cell.innerHTML = `${miniFlower(n, 30)}<div class="m-num">${d}</div>`;

    if (future) {
      /* A day that has not happened cannot have prayers in it. Leaving it
         tappable would let someone bank tomorrow's five, which would make
         every number in Consistency a fiction. */
      cell.disabled = true;
      cell.setAttribute('aria-label', `${d} — not yet`);
    } else {
      cell.setAttribute('aria-label',
        `${base.toLocaleDateString('en-GB', { month: 'long' })} ${d} — ${n} of five noted. Edit.`);
      cell.addEventListener('click', () => openDaySheet(key));
    }
    el.monthGrid.appendChild(cell);
  }
}

/* ── The day editor ──────────────────────────────────────────────────
   Tapping a day in the month grid opens its five prayers. Everything it
   writes goes through notePrayer, which is the same path Today uses — so
   a correction saves to the device and pushes to the cloud identically,
   and there is no second, subtly different write path to keep in sync.

   The capability was always there: the Timetable could already mark any
   past day. But it made you step to that date one day at a time, which
   nobody does. This is the same power reached from where you actually
   notice the gap. */
let daySheetKey = null;
let daySheetOpenedFrom = null;

function openDaySheet(key) {
  if (key > todayKey()) return;
  daySheetKey = key;
  daySheetOpenedFrom = key;
  el.dayScrim.hidden = false;
  document.body.style.overflow = 'hidden';
  drawDaySheet();
  el.daySheetClose.focus();
  document.addEventListener('keydown', onDaySheetKey);
}

function closeDaySheet() {
  el.dayScrim.hidden = true;
  daySheetKey = null;
  document.body.style.overflow = '';
  document.removeEventListener('keydown', onDaySheetKey);
  /* Re-find the cell rather than reusing the node that opened the sheet:
     any correction made inside redrew the grid, so the original is gone. */
  const back = daySheetOpenedFrom
    && el.monthGrid.querySelector(`.m-cell[data-key="${daySheetOpenedFrom}"]`);
  if (back) back.focus();
  daySheetOpenedFrom = null;
}

function onDaySheetKey(e) {
  if (e.key === 'Escape') { closeDaySheet(); return; }
  if (e.key !== 'Tab' || el.dayScrim.hidden) return;
  const f = [...el.dayScrim.querySelectorAll('button:not([disabled])')];
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

function drawDaySheet() {
  const key = daySheetKey;
  if (!key) return;
  const tKey = todayKey();
  const day = dayFor(key);
  /* windows() needs tomorrow's Fajr to close Isha, exactly as Today does. */
  const ws = windows(day, dayFor(shiftKey(key, 1)).fajr);
  const { y, m, d } = parseKey(key);
  const dt = new Date(y, m - 1, d);

  el.daySheetDate.textContent =
    dt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const n = KEYS.filter(k => isNoted(key, k)).length;
  el.daySheetCount.textContent =
    key === tKey ? 'Today' : (n === 0 ? 'Nothing noted' : `${n} of five noted`);

  el.daySheetRows.innerHTML = '';
  KEYS.forEach((k, i) => {
    const w = ws.find(x => x.key === k);
    const on = isNoted(key, k);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'dt-row' + (on ? ' on' : '');
    b.setAttribute('aria-pressed', on ? 'true' : 'false');

    /* The disc carries the sun's real position at that prayer on that
       date — the same computation Today runs, so a day in March looks
       like March. */
    const a = w ? altitudeAt(w.from, day) : 0;
    const lift = w ? Math.max(0, Math.min(1, (a + 8) / Math.max(6, day.peakAlt))) : 0;
    const r = (4.5 + lift * 4.5).toFixed(1);
    const fill = w ? sunColour(a, w.from, day) : '#2A3630';

    b.innerHTML =
      '<span class="dt-disc" aria-hidden="true">' +
        `<svg viewBox="-30 -30 60 60" width="24" height="24"><circle cx="0" cy="0" r="${r}" fill="${fill}"></circle></svg>` +
      '</span>' +
      `<span class="dt-name">${NAMES[i]}</span>` +
      `<span class="dt-time">${w ? fmtMinutes(w.from) : '—'}</span>` +
      '<span class="dt-state" aria-hidden="true"><span class="dt-ring"></span><span class="dt-word">Noted</span></span>';
    b.setAttribute('aria-label',
      `${NAMES[i]}${w ? ' at ' + fmtMinutes(w.from) : ''} — ${on ? 'noted' : 'not noted'}`);

    b.addEventListener('click', () => {
      notePrayer(key, k);   /* saves locally, pushes to the cloud, redraws */
      drawDaySheet();       /* then refresh the sheet itself */
    });
    el.daySheetRows.appendChild(b);
  });

  el.daySheetNote.textContent = key === tKey
    ? 'Tap a prayer to note it, or tap again to take it back.'
    : 'Corrections save straight away, on this device and in your account.';

  /* Next stops at today. There is nothing to correct in a day that has
     not happened yet. */
  el.daySheetNext.disabled = shiftKey(key, 1) > tKey;
}

el.daySheetClose.addEventListener('click', closeDaySheet);
el.dayScrim.addEventListener('click', e => { if (e.target === el.dayScrim) closeDaySheet(); });
el.daySheetPrev.addEventListener('click', () => { daySheetKey = shiftKey(daySheetKey, -1); drawDaySheet(); });
el.daySheetNext.addEventListener('click', () => {
  const next = shiftKey(daySheetKey, 1);
  if (next > todayKey()) return;
  daySheetKey = next;
  drawDaySheet();
});
$('month-prev').addEventListener('click', () => { monthOffset--; drawHistory(); });
$('month-next').addEventListener('click', () => { if (monthOffset < 0) monthOffset++; drawHistory(); });

/* ── Settings ────────────────────────────────────────────────────── */
function setPlace(pl) {
  settings.place = { name: pl.name, lat: pl.lat, lon: pl.lon, tz: pl.tz ?? null };
  saveSettings();
  dayCache = {};
  renderAll();
}

function drawSettings() {
  const loc = place();
  el.placeName.textContent = `✓ ${loc.name}`;
  el.placeMeta.textContent = `${loc.lat.toFixed(4)}, ${loc.lon.toFixed(4)}${loc.tz ? ' · ' + loc.tz.replace('_', ' ') : ' · your timezone'}`;
  const q = qiblaBearing(loc);
  el.placeQibla.textContent = `Qibla ${q.toFixed(1)}° ${compass16(q)}`;

  el.cityRow.innerHTML = '';
  QUICK.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'city-chip' + (settings.place.name === c.name ? ' on' : '');
    b.textContent = c.name;
    b.addEventListener('click', () => setPlace(c));
    el.cityRow.appendChild(b);
  });

  el.methodList.innerHTML = '';
  Object.entries(METHODS).forEach(([id, m]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'method' + (settings.method === id ? ' on' : '');
    b.innerHTML = `<div class="m-name">${m.name}</div><div class="m-note">${METHOD_NOTES[id] || ''}</div>`;
    b.addEventListener('click', () => { settings.method = id; saveSettings(); dayCache = {}; renderAll(); });
    el.methodList.appendChild(b);
  });

  el.asrToggle.querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', +b.dataset.f === settings.asrFactor);
    b.onclick = () => { settings.asrFactor = +b.dataset.f; saveSettings(); dayCache = {}; renderAll(); };
  });
  el.asrNote.textContent = settings.asrFactor === 2
    ? 'Ḥanafī: Asr begins when a shadow reaches twice its object.'
    : 'Standard: Asr begins when a shadow equals its object — Shāfiʿī, Mālikī, Ḥanbalī.';

  el.hlToggle.querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.r === settings.highLatRule);
    b.onclick = () => { settings.highLatRule = b.dataset.r; saveSettings(); dayCache = {}; renderAll(); };
  });
}

/* Place search */
el.placeSearch.addEventListener('input', () => {
  const hits = searchCities(el.placeSearch.value);
  el.searchResults.innerHTML = '';
  if (!hits.length) { el.searchResults.classList.remove('show'); return; }
  hits.forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'search-hit';
    b.innerHTML = `<span>${c.name}</span><span class="tz">${c.tz.replace('_', ' ')}</span>`;
    b.addEventListener('click', () => {
      el.placeSearch.value = '';
      el.searchResults.classList.remove('show');
      setPlace(c);
    });
    el.searchResults.appendChild(b);
  });
  el.searchResults.classList.add('show');
});
document.addEventListener('click', e => {
  if (!e.target.closest('.search-wrap')) el.searchResults.classList.remove('show');
});

el.geoBtn.addEventListener('click', () => {
  if (!navigator.geolocation) { el.geoBtn.textContent = 'Location not available'; return; }
  el.geoBtn.textContent = 'Locating…';
  navigator.geolocation.getCurrentPosition(pos => {
    setPlace({
      name: 'Your location',
      lat: +pos.coords.latitude.toFixed(4),
      lon: +pos.coords.longitude.toFixed(4),
      tz: null, // device's own timezone — exact coordinates, your clock
    });
    el.geoBtn.textContent = 'Use my precise location';
  }, () => { el.geoBtn.textContent = 'Could not locate — search a city'; }, { timeout: 10000 });
});
el.placeBtn.addEventListener('click', () => {
  location.hash = '#settings';
});

/* ── Account / auth UI ───────────────────────────────────────────── */
function drawAuth() {
  const u = Sync.user;
  el.authBtn.textContent = u ? (u.email ? u.email.split('@')[0] : 'Account') : 'Sign in';
  el.authBtn.classList.toggle('signed', !!u);

  if (u) {
    el.accountName.textContent = `✓ ${u.email}`;
    /* An unverified address is worth saying out loud once, because the day
       it matters is the day they need a password reset and the mail has
       nowhere to go. It never blocks anything — the notes sync either way. */
    el.accountMeta.textContent = Sync.lastError
      ? 'Signed in, but the database refused the sync — the Gul security rules need to be added in the Firebase console (see firestore.rules). Your notes are safe here meanwhile.'
      : u.emailVerified === false
        ? 'Signed in and syncing. We sent a note to this address to confirm it — worth confirming, so you can reset your password later if you ever need to.'
        : 'Signed in — your notes and settings sync to the cloud and across your devices.';
    el.accountAction.textContent = 'Sign out';
    el.accountAction.onclick = () => Sync.signOut();
    $('danger-zone').hidden = false;
    /* Three states, not two. "Synced" is now a claim the app has to earn:
       it means the cloud actually answered, not merely that someone is
       signed in. The old version said it the instant you signed in, so for
       two days it read "safe in the cloud" while every write was being
       refused by rules that had no gulUsers block in them. An app that
       reports its intentions instead of its results is worse than one that
       says nothing. */
    el.syncLine.textContent = Sync.lastError
      ? 'Sync blocked — notes staying on this device'
      : Sync.synced
        ? 'Synced — your notes are safe in the cloud'
        : 'Signed in — waiting for the first sync';
    el.syncLine.classList.toggle('on', !Sync.lastError && !!Sync.synced);
  } else {
    el.accountName.textContent = 'Local only';
    el.accountMeta.textContent = Sync.ready && !Sync._fb
      ? 'The cloud could not be reached from here, so notes are staying on this device.'
      : 'Your notes live on this device. Create an account to keep them safe and see them on any device.';
    el.accountAction.textContent = 'Sign in or create an account';
    el.accountAction.onclick = openAuth;
    /* Nothing to delete while signed out, and the control disappears
       rather than greying out — a disabled destructive button is still an
       invitation to press it. */
    $('danger-zone').hidden = true;
    $('delete-confirm').hidden = true;
    el.syncLine.textContent = 'Local only — sign in to sync';
    el.syncLine.classList.remove('on');
  }
}

/* ── The auth card ───────────────────────────────────────────────────
   Three steps, one decision each. The old card put Sign in and Create an
   account side by side under a single form, which asked the person to
   decide after filling it in — and let an empty form reach Firebase,
   whose reply ("auth/missing-email") was written for developers. */

const AUTH_STEPS = ['door', 'signin', 'signup'];
let authStep = 'door';

function showStep(step) {
  authStep = step;
  AUTH_STEPS.forEach(s => { const n = $('auth-step-' + s); if (n) n.hidden = (s !== step); });
  /* Google belongs on the door only; on a named step it is a third path
     nobody asked for. */
  const g = $('auth-google'), or = document.querySelector('.auth-or');
  const onDoor = step === 'door';
  if (g && !g.dataset.unavailable) g.hidden = !onDoor;
  if (or) or.hidden = !onDoor || (g && g.dataset.unavailable === '1');
  clearAuthErrors();
  const focus = { door: null, signin: 'auth-email', signup: 'auth-email2' }[step];
  if (focus) setTimeout(() => $(focus).focus(), 50);
}

function clearAuthErrors() {
  ['auth-email-err', 'auth-pass-err', 'auth-email2-err', 'auth-pass2-err',
   'auth-error', 'auth-error2'].forEach(id => {
    const n = $(id); if (n) { n.textContent = ''; n.style.color = ''; }
  });
}

function openAuth() {
  el.authOverlay.hidden = false;
  showStep('door');
  /* Hide the Google button outright when the project cannot serve it, rather
     than offering something that can only disappoint. It reappears on its own
     the moment the domain is authorized in the console — no deploy needed. */
  const g = $('auth-google'), or = document.querySelector('.auth-or');
  if (!g) return;
  g.hidden = true; g.dataset.unavailable = '1'; if (or) or.hidden = true;
  if (!Sync._fb) return;
  Sync.googleAvailable().then(ok => {
    g.dataset.unavailable = ok ? '' : '1';
    if (authStep === 'door') { g.hidden = !ok; if (or) or.hidden = !ok; }
  });
}
function closeAuth() { el.authOverlay.hidden = true; }

el.authBtn.addEventListener('click', () => {
  if (Sync.user) location.hash = '#settings';
  else openAuth();
});
$('auth-close').addEventListener('click', closeAuth);
el.authOverlay.addEventListener('click', e => { if (e.target === el.authOverlay) closeAuth(); });

/* Carry a typed address across the step boundary. Somebody who typed their
   email, then realised they meant the other path, should not type it twice. */
$('auth-go-signin').addEventListener('click', () => {
  $('auth-email').value = $('auth-email2').value || $('auth-email').value;
  showStep('signin');
});
$('auth-go-signup').addEventListener('click', () => {
  $('auth-email2').value = $('auth-email').value || $('auth-email2').value;
  showStep('signup');
});
$('auth-back-1').addEventListener('click', () => showStep('door'));
$('auth-back-2').addEventListener('click', () => showStep('door'));

/* ── Errors ──────────────────────────────────────────────────────────
   Nothing a provider wrote ever reaches the interface. An unmapped code
   becomes a plain sentence here and the real one goes to the console for
   us — a person should never have to read the word "auth/". */
function authError(e) {
  const map = {
    'auth/invalid-email': 'That does not look like an email address.',
    /* These three are deliberately identical. Distinguishing "no such
       account" from "wrong password" tells a stranger which addresses are
       registered here — a free enumeration oracle. One sentence closes it. */
    'auth/user-not-found': 'That email and password do not match.',
    'auth/wrong-password': 'That email and password do not match.',
    'auth/invalid-credential': 'That email and password do not match.',
    'auth/email-already-in-use': 'That address already has an account. Sign in instead.',
    'auth/weak-password': 'Use at least 6 characters.',
    'auth/missing-password': 'Enter a password.',
    'auth/missing-email': 'Enter your email address.',
    'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
    'auth/network-request-failed': 'No connection — the app still works on this device.',
    'auth/operation-not-allowed': 'That sign-in method is not enabled yet.',
    'auth/unauthorized-domain': 'Google sign-in is not allowed from this address yet.',
    /* A closed popup is a change of mind, not a failure. Say nothing. */
    'auth/popup-closed-by-user': '',
    'auth/cancelled-popup-request': '',
    'auth/popup-blocked': 'Your browser blocked the sign-in window. Allow popups, or use an email instead.',
    'auth/account-exists-with-different-credential':
      'That address already has a password account here. Sign in with the email and password instead.',
  };
  if (e && e.code && e.code in map) return map[e.code];
  console.error('Gul: unmapped auth error', e);
  return 'Something went wrong. Please try again.';
}

/* ── Validation ──────────────────────────────────────────────────────
   Caught at the field, before any network call. An empty box is not an
   error condition worth a round trip; it is a box that is not filled in. */
function fieldErr(id, msg) { const n = $(id); if (n) n.textContent = msg || ''; return !msg; }

function validate(emailId, passId, emailErrId, passErrId, { min = 0 } = {}) {
  const email = $(emailId).value.trim();
  const pass  = $(passId).value;
  let ok = true;
  if (!email) ok = fieldErr(emailErrId, 'Enter your email address.') && ok;
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    ok = fieldErr(emailErrId, 'That does not look like an email address.') && ok;
  else fieldErr(emailErrId, '');

  if (!pass) ok = fieldErr(passErrId, 'Enter a password.') && ok;
  else if (min && pass.length < min) ok = fieldErr(passErrId, `Use at least ${min} characters.`) && ok;
  else fieldErr(passErrId, '');

  return ok ? { email, pass } : null;
}

/* A submit that sits silent for two seconds reads as broken. */
async function withBusy(btn, label, fn) {
  const was = btn.textContent;
  btn.disabled = true; btn.textContent = label;
  try { return await fn(); }
  finally { btn.disabled = false; btn.textContent = was; }
}

async function doSignIn() {
  clearAuthErrors();
  const v = validate('auth-email', 'auth-pass', 'auth-email-err', 'auth-pass-err');
  if (!v) return;
  if (!Sync._fb) { el.authError.textContent = 'The cloud could not be reached from here.'; return; }
  try {
    await withBusy($('auth-signin'), 'Signing in…', () => Sync.signIn(v.email, v.pass));
    closeAuth();
  } catch (e) { el.authError.textContent = authError(e); }
}

async function doSignUp() {
  clearAuthErrors();
  const err = $('auth-error2');
  const v = validate('auth-email2', 'auth-pass2', 'auth-email2-err', 'auth-pass2-err', { min: 6 });
  if (!v) return;
  if (!Sync._fb) { err.textContent = 'The cloud could not be reached from here.'; return; }
  try {
    await withBusy($('auth-signup'), 'Creating account…', () => Sync.signUp(v.email, v.pass));
    /* The account is live and already syncing. Hold the card open for a
       breath so the person knows an email is on its way, rather than
       wondering later why one arrived. */
    err.style.color = 'var(--pn-noted)';
    err.textContent = 'Account created — check your inbox.';
    setTimeout(() => { err.style.color = ''; closeAuth(); }, 2600);
  } catch (e) {
    err.style.color = '';
    err.textContent = authError(e);
  }
}

$('auth-signin').addEventListener('click', doSignIn);
$('auth-signup').addEventListener('click', doSignUp);
$('auth-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doSignIn(); });
$('auth-pass2').addEventListener('keydown', e => { if (e.key === 'Enter') doSignUp(); });

$('auth-google').addEventListener('click', async () => {
  clearAuthErrors();
  if (!Sync._fb) { el.authError.textContent = 'The cloud could not be reached from here.'; return; }
  try { await Sync.signInWithGoogle(); closeAuth(); }
  catch (e) {
    const m = authError(e);
    if (m) { showStep('signin'); el.authError.textContent = m; }
  }
});

$('auth-reset').addEventListener('click', async () => {
  clearAuthErrors();
  const email = $('auth-email').value.trim();
  if (!email) { fieldErr('auth-email-err', 'Enter your email address first.'); return; }
  try {
    await Sync.resetPassword(email);
    el.authError.style.color = 'var(--pn-noted)';
    el.authError.textContent = 'Reset email sent — check your inbox.';
  }
  catch (e) { el.authError.style.color = ''; el.authError.textContent = authError(e); }
})

/* ── Deleting the account ────────────────────────────────────────────
   Two deliberate steps. The first press only reveals the consequence; the
   second one carries it out. No modal, because a modal over Settings is
   one stray tap from dismissal and this is the one action that must be
   read before it is taken. */
$('delete-open').addEventListener('click', () => {
  $('delete-error').textContent = '';
  $('delete-confirm').hidden = false;
  $('delete-open').hidden = true;
  $('delete-cancel').focus();
});

$('delete-cancel').addEventListener('click', () => {
  $('delete-confirm').hidden = true;
  $('delete-open').hidden = false;
  $('delete-open').focus();
});

$('delete-go').addEventListener('click', async () => {
  const err = $('delete-error');
  const btn = $('delete-go');
  err.style.color = '';
  err.textContent = '';
  if (!Sync.user) { err.textContent = 'You are not signed in.'; return; }
  const was = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    await Sync.deleteAccount();
    /* The cloud copy is gone. What is on this device is the person's own
       and stays until they clear it — saying so is the difference between
       a promise kept and a nasty surprise. */
    $('delete-confirm').hidden = true;
    $('delete-open').hidden = false;
    $('danger-zone').hidden = true;
    el.syncLine.textContent = 'Account deleted — your notes on this device are untouched';
    renderAll();
  } catch (e) {
    if (e?.code === 'gul/reauth-needed') {
      err.textContent = 'Your cloud data is deleted. Sign in once more to finish removing the account itself.';
      renderAll();
    } else if (e?.code === 'auth/popup-closed-by-user' || e?.code === 'auth/cancelled-popup-request') {
      err.textContent = 'Confirmation was cancelled — your account has not been removed.';
    } else {
      console.error('Gul: account deletion failed', e);
      err.textContent = 'That did not go through. Please try again.';
    }
  } finally {
    btn.disabled = false;
    btn.textContent = was;
  }
});

/* ── Render & tick ───────────────────────────────────────────────── */
function renderAll() {
  drawHeader();
  const { t, day } = drawFlower();
  drawNow(t, todayKey());
  /* A held scrub survives the minute tick — the clock moving under you
     should not yank the window back. Releasing is what returns it. */
  drawAperture(scrubT === null ? t : scrubT, day);
  drawTimetable();
  drawHistory();
  drawSettings();
  drawAuth();
}

let lastMinuteKey = '';
function tick() {
  const p = nowParts();
  const mk = `${todayKey()}|${Math.floor(p.min)}`;
  if (mk === lastMinuteKey) return;
  lastMinuteKey = mk;
  renderAll();
}

Sync.onChange = drawAuth;
Sync.onRemoteNotes = mergeRemoteDay;
Sync.onRemoteSettings = mergeRemoteSettings;
/* After the first cloud snapshot, upload anything the cloud doesn't
   have or that's newer locally — first sign-in on a new device pulls
   everything down; first sign-in ever pushes the local record up. */
/* ── Whose notes are these? ───────────────────────────────────────────
   The local store is stamped with the uid that owns it. Without that
   stamp, signing out and signing in as somebody else uploaded the first
   person's prayer record into the second person's account — their days,
   their home town, their coordinates. On a shared laptop or a resold
   phone that is a disclosure of somebody's religious practice, and the
   app did it silently while reporting success.

   Sign-out deliberately does NOT wipe the device. Someone who signs out
   should still find their own notes when they come back, exactly as a
   local-only user would. The stamp is what makes that safe: the data
   stays, but it is never handed to a different account. */
const OWNER_KEY = 'gul.owner.v1';
const storedOwner = () => { try { return localStorage.getItem(OWNER_KEY); } catch { return null; } };
const setOwner = uid => { try { uid ? localStorage.setItem(OWNER_KEY, uid) : localStorage.removeItem(OWNER_KEY); } catch {} };

function resetLocalToDefaults() {
  notes = {};
  settings = { ...DEFAULT_SETTINGS };
  try {
    localStorage.removeItem('gul.notes.v2');
    localStorage.removeItem('gul.settings.v2');
  } catch {}
}

Sync.onFirstSync = () => {
  const uid = Sync.user && Sync.user.uid;
  if (!uid) return;
  const owner = storedOwner();

  /* A different person's device state. Do not push a byte of it upward —
     drop it, take what the cloud has, and let this account start clean. */
  if (owner && owner !== uid) {
    resetLocalToDefaults();
    setOwner(uid);
    saveNotes();
    saveSettings();
    renderAll();
    return;
  }

  /* Unstamped means data written before this rule existed, or by a
     local-only user who has just made their first account. Both are the
     same person, so the upload is right — claim it and proceed. */
  setOwner(uid);

  Object.entries(notes).forEach(([key, dayN]) => {
    if ((dayN.u || 0) > (Sync.remoteU[key] || 0)) {
      Sync.pushDay(key, dayN.p, dayN.u).catch(() => {});
    }
  });
  if ((settings.u || 0) > (Sync.remoteSettingsU || 0)) {
    Sync.pushSettings(publicSettings(), settings.u).catch(() => {});
  }
};
Sync.init();

renderAll();
setInterval(tick, 20000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
window.addEventListener('resize', () => drawFlower());

/* ── The launch splash: nothing but the sun, then the day's noted
   petals open one at a time — 200ms apart, 760ms each, landing on the
   true state. It never marks anything; it only reveals what you marked.
   Reduced motion jumps straight to the end state. ─────────────────── */
(function splash() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const key = todayKey();
  const notedIdx = KEYS.map((k, i) => (isNoted(key, k) ? i : -1)).filter(i => i >= 0);
  if (!notedIdx.length) return;
  petalEls.forEach(pe => {
    pe.style.transition = 'none';
    pe.setAttribute('fill', 'none');
    pe.setAttribute('stroke', '#F2EDE3');
    pe.setAttribute('stroke-width', '1.1');
    pe.setAttribute('opacity', '0.4');
  });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    petalEls.forEach(pe => { pe.style.transition = ''; });
    notedIdx.forEach((pi, k) => setTimeout(() => {
      petalEls[pi].setAttribute('fill', '#F2EDE3');
      petalEls[pi].setAttribute('stroke', 'none');
      petalEls[pi].setAttribute('stroke-width', '0');
      petalEls[pi].setAttribute('opacity', '1');
    }, 240 + k * 200));
  }));
})();

/* ── Views ───────────────────────────────────────────────────────────
   Today, Timetable, History and Settings are tabs, not sections of one
   page. They were previously stacked and the nav links were plain
   anchors, so Settings sat pasted onto the bottom of the landing page —
   the first thing a person saw after their own prayers was a
   preferences screen. One view is visible at a time; the hash is the
   route, so back and forward work and a tab can be linked to directly. */
const VIEWS = ['today', 'timetable', 'history', 'settings'];

function route() {
  const asked = (location.hash || '').replace('#', '');
  const view = VIEWS.includes(asked) ? asked : 'today';

  VIEWS.forEach(v => {
    const sec = document.getElementById(v);
    if (sec) sec.hidden = (v !== view);
  });
  document.querySelectorAll('.links a').forEach(a =>
    a.classList.toggle('on', a.getAttribute('href') === '#' + view));

  /* Timetable and History draw from the same state as Today, so a tab that
     has been hidden for a while would otherwise show a stale day. */
  renderAll();
  window.scrollTo(0, 0);
}

addEventListener('hashchange', route);
route();

/* ── Install ─────────────────────────────────────────────────────────
   Mounted once, after the views exist. The module decides for itself
   whether there is anything to show: it removes itself when Gul is
   already running from the Home Screen, and on Android and desktop it
   stays hidden until the browser has actually offered a prompt, so the
   button is never present without something behind it.

   Analytics are a no-op console line for now. The brief names the events
   it wants tracked; Gul has no analytics pipeline, and inventing one to
   satisfy a checklist would mean shipping a beacon nobody asked for into
   an app whose whole posture is that data stays on the device. The event
   names are here so a real sink can be attached in one place later. */
const install = initInstall({
  appName: 'Gul',
  appIcon: './icons/apple-touch-icon.png',
  mount: $('install-slot'),
  dismissalDurationDays: 14,
  onEvent: name => console.debug('gul_' + name),
});

/* ── #install ────────────────────────────────────────────────────────
   The welcome email links here. It is not a view: it lands on Settings,
   where the install card lives, and opens the install path immediately —
   the browser's own prompt on Android and desktop, the Share-sheet steps
   on iPhone. Replacing the hash rather than setting it keeps #install out
   of history, so Back returns to the mail rather than re-triggering.

   The wait is for the native branch. beforeinstallprompt fires shortly
   after load, and a person arriving from a cold tap would otherwise reach
   request() before the browser had offered anything — the module would
   correctly stay silent, and the tap would look broken. */
function installDeepLink() {
  if ((location.hash || '') !== '#install') return;
  location.replace('#settings');
  const go = () => install && install.request && install.request();
  if (window.__gulInstallEvent) { setTimeout(go, 80); return; }
  let fired = false;
  const once = () => { if (!fired) { fired = true; go(); } };
  window.addEventListener('gul:installable', once, { once: true });
  setTimeout(once, 1200);
}
installDeepLink();
