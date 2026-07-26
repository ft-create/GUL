/* GUL — the live flower and the aperture, driven by the real sun.
   Times from solar.js (NOAA / Meeus). Offline-first: everything works
   locally; signing in mirrors notes and settings to Firestore. */

import {
  solarDay, altitudeAt, shadowRatioAt, windows, fmtMinutes, METHODS,
} from './solar.js';
import { QUICK, searchCities } from './cities.js';
import { Sync } from './firebase.js';

/* ── Geometry: the petal, exactly as drawn in the Gul design ─────── */
function petalPath(L, wr, notch, shoulder, inset) {
  const w = L * wr, m = -L * shoulder, r = x => Math.round(x * 100) / 100;
  const y = v => r(v - inset);
  return [
    `M0 ${y(0)}`,
    `C${r(-0.6 * w)} ${y(-0.145 * L)} ${r(-w)} ${y(m + 0.22 * L)} ${r(-w)} ${y(m)}`,
    `C${r(-w)} ${y(-L + 0.22 * L)} ${r(-0.66 * w)} ${y(-L + 0.084 * L)} ${r(-0.2 * w)} ${y(-L + 0.032 * L)}`,
    `C${r(-0.11 * w)} ${y(-L + 0.022 * L)} ${r(-0.04 * w)} ${y(-L + 0.04 * L)} 0 ${y(-L + notch * L)}`,
    `C${r(0.04 * w)} ${y(-L + 0.04 * L)} ${r(0.11 * w)} ${y(-L + 0.022 * L)} ${r(0.2 * w)} ${y(-L + 0.032 * L)}`,
    `C${r(0.66 * w)} ${y(-L + 0.084 * L)} ${r(w)} ${y(-L + 0.22 * L)} ${r(w)} ${y(m)}`,
    `C${r(w)} ${y(m + 0.22 * L)} ${r(0.6 * w)} ${y(-0.145 * L)} 0 ${y(0)} Z`,
  ].join(' ');
}
const PETAL = petalPath(21, 0.36, 0, 0.58, 3.5);

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
  else {
    delete notes[key];
    Sync.deleteDay(key).catch(() => {});
  }
  saveNotes();
  if (notes[key]) Sync.pushDay(key, notes[key].p, notes[key].u).catch(() => {});
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
  petals: $('petals'), dome: $('dome'), discDay: $('disc-day'), discNight: $('disc-night'),
  corona: $('corona'), tips: $('tips'),
  greg: $('greg-date'), hijri: $('hijri-date'), placeBtn: $('place-btn'),
  nowName: $('now-name'), nowTime: $('now-time'), nextLabel: $('next-label'),
  qiblaLine: $('qibla-line'), syncLine: $('sync-line'),
  markNow: $('mark-now'), pills: $('pills'),
  polarNote: $('polar-note'), adjustedNote: $('adjusted-note'),
  ap: { sky: $('ap-sky'), shaft: $('ap-shaft'), sun: $('ap-sun'), ground: $('ap-ground'),
        shadow: $('ap-shadow'), gnomon: $('ap-gnomon'), frame: document.querySelector('.aperture-frame'),
        phase: $('ap-phase'), meta: $('ap-meta') },
  ttDate: $('tt-date'), ttRows: $('tt-rows'),
  monthTitle: $('month-title'), monthGrid: $('month-grid'),
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
  p.style.transform = `translate(32px,32px) rotate(${i * 72}deg) scale(0.84)`;
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
const pillEls = KEYS.map((k, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'pill';
  b.innerHTML = `<span class="glyph">○</span><span style="white-space:nowrap">${NAMES[i]}</span>`;
  b.addEventListener('click', () => { toggleNote(todayKey(), k); renderAll(); });
  el.pills.appendChild(b);
  return b;
});

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
    pe.setAttribute('opacity', noted[i] ? '1' : '0.42');
  });
  el.dome.style.opacity = 0.34 + count * 0.09;

  const discR = night ? 8.6 : 7.4 + lift * 4.2;
  const glowPx = night ? 14 : 8 + lift * 22;
  const glowCol = night ? 'rgba(214,226,240,.55)' : fill;
  el.discDay.style.display = night ? 'none' : '';
  el.discNight.style.display = night ? '' : 'none';
  const disc = night ? el.discNight : el.discDay;
  disc.setAttribute('r', discR.toFixed(2));
  disc.setAttribute('fill', night ? '#E6ECF2' : fill);
  disc.style.filter = `drop-shadow(0 0 ${glowPx}px ${glowCol})`;

  const coronaSize = Math.round(140 + lift * 150);
  el.corona.style.width = el.corona.style.height = coronaSize + 'px';
  el.corona.style.background = `radial-gradient(circle, ${night ? 'rgba(198,214,236,.16)' : fillSoft} 0%, transparent 66%)`;
  el.corona.style.opacity = 0.3 + lift * 0.6;

  // Petal labels around the mark. ViewBox is -6 -6 76 76 → 38 px-units
  // across half the box; centre stays at 50%.
  const svg = $('flower');
  const px = svg.clientWidth || 300;
  const U = px / 76;
  const Rside = Math.round(Math.max((21 + 3.5) * 0.84, 27) * U + 18);
  const Rtop = Math.round(Math.max((21 + 3.5) * 0.84, 24.75) * U + 18);
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
}

/* ── Now / next ──────────────────────────────────────────────────── */
function lastAndNext(t, key) {
  const day = dayFor(key);
  const ws = windows(day, dayFor(shiftKey(key, 1)).fajr);
  const last = ws.filter(w => w.from <= t).slice(-1)[0] || ws[4];
  const next = ws.find(w => w.from > t) || { ...ws[0], from: ws[0].from + 1440 };
  return { day, last, next };
}

function drawNow(t, key) {
  const { last, next } = lastAndNext(t, key);
  const until = Math.max(0, Math.round(next.from - t));
  el.nowName.textContent = last.name;
  el.nowTime.textContent = fmtMinutes(last.from);
  el.nextLabel.textContent = `${next.name} in ${Math.floor(until / 60)}h ${until % 60}m`;

  const q = qiblaBearing(place());
  el.qiblaLine.textContent = `Qibla ${q.toFixed(0)}° ${compass16(q)} from where you are`;

  const ki = last.key;
  const noted = isNoted(key, ki);
  el.markNow.textContent = noted ? `${last.name} noted` : `Note ${last.name}`;
  el.markNow.classList.toggle('noted', noted);
  el.markNow.onclick = () => { toggleNote(key, ki); renderAll(); };

  pillEls.forEach((pe, i) => {
    const on = isNoted(key, KEYS[i]);
    pe.classList.toggle('open', on);
    pe.querySelector('.glyph').textContent = on ? '●' : '○';
  });
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

  const { last } = key === tKey ? lastAndNext(p.min, key) : { last: null };
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
      if (canMark) b.addEventListener('click', () => { toggleNote(key, w.key); renderAll(); });
      else { b.disabled = true; b.style.opacity = .45; b.style.cursor = 'default'; }
      row.appendChild(b);
    }
    el.ttRows.appendChild(row);
  });
}

$('day-prev').addEventListener('click', () => { viewKey = shiftKey(viewKey, -1); drawTimetable(); });
$('day-next').addEventListener('click', () => { viewKey = shiftKey(viewKey, 1); drawTimetable(); });

/* ── History: the garden ─────────────────────────────────────────── */
let monthOffset = 0; // 0 = current month

function miniFlower(n, size) {
  const petals = KEYS.map((_, i) =>
    `<g transform="rotate(${i * 72})"><path d="${PETAL}" fill="#F2EDE3" opacity="${i < n ? 0.95 : 0.1}"></path></g>`).join('');
  return `<svg class="m-flower" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${n} of five noted" style="overflow:visible">
    <g transform="translate(32 32) scale(.84)">${petals}</g>
    <circle cx="32" cy="32" r="${n > 0 ? 5 : 3.4}" fill="${n > 0 ? SUN : '#1E2A24'}"></circle></svg>`;
}

function drawHistory() {
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
    const cell = document.createElement('div');
    cell.className = 'm-cell' + (key === tKey ? ' today' : '') + (key > tKey ? ' future' : '');
    cell.innerHTML = `${miniFlower(n, 30)}<div class="m-num">${d}</div>`;
    el.monthGrid.appendChild(cell);
  }
}
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
  document.getElementById('settings').scrollIntoView({ behavior: 'smooth' });
});

/* ── Account / auth UI ───────────────────────────────────────────── */
function drawAuth() {
  const u = Sync.user;
  el.authBtn.textContent = u ? (u.email ? u.email.split('@')[0] : 'Account') : 'Sign in';
  el.authBtn.classList.toggle('signed', !!u);

  if (u) {
    el.accountName.textContent = `✓ ${u.email}`;
    el.accountMeta.textContent = Sync.lastError
      ? 'Signed in, but the database refused the sync — the Gul security rules need to be added in the Firebase console (see firestore.rules). Your notes are safe here meanwhile.'
      : 'Signed in — your notes and settings sync to the cloud and across your devices.';
    el.accountAction.textContent = 'Sign out';
    el.accountAction.onclick = () => Sync.signOut();
    el.syncLine.textContent = Sync.lastError ? 'Sync blocked — notes staying local' : 'Synced — your notes are safe in the cloud';
    el.syncLine.classList.toggle('on', !Sync.lastError);
  } else {
    el.accountName.textContent = 'Local only';
    el.accountMeta.textContent = Sync.ready && !Sync._fb
      ? 'The cloud could not be reached from here, so notes are staying on this device.'
      : 'Your notes live on this device. Create an account to keep them safe and see them on any device.';
    el.accountAction.textContent = 'Sign in or create an account';
    el.accountAction.onclick = openAuth;
    el.syncLine.textContent = 'Local only — sign in to sync';
    el.syncLine.classList.remove('on');
  }
}

function openAuth() {
  el.authOverlay.hidden = false;
  el.authError.textContent = '';
  setTimeout(() => el.authEmail.focus(), 50);
}
function closeAuth() { el.authOverlay.hidden = true; }

el.authBtn.addEventListener('click', () => {
  if (Sync.user) document.getElementById('settings').scrollIntoView({ behavior: 'smooth' });
  else openAuth();
});
$('auth-close').addEventListener('click', closeAuth);
el.authOverlay.addEventListener('click', e => { if (e.target === el.authOverlay) closeAuth(); });

function authError(e) {
  const map = {
    'auth/invalid-email': 'That email does not look right.',
    'auth/user-not-found': 'No account with that email — create one below.',
    'auth/wrong-password': 'That password does not match.',
    'auth/invalid-credential': 'Email or password does not match.',
    'auth/email-already-in-use': 'That email already has an account — sign in instead.',
    'auth/weak-password': 'Password needs at least 6 characters.',
    'auth/network-request-failed': 'No connection — the app still works locally.',
    'auth/operation-not-allowed': 'Email sign-in is not enabled yet in the Firebase console.',
  };
  return map[e?.code] || e?.message || 'Something went wrong.';
}

async function doAuth(mode) {
  const email = el.authEmail.value.trim();
  const pass = el.authPass.value;
  el.authError.textContent = '';
  if (!Sync._fb) { el.authError.textContent = 'The cloud could not be reached from here.'; return; }
  try {
    if (mode === 'in') await Sync.signIn(email, pass);
    else await Sync.signUp(email, pass);
    closeAuth();
  } catch (e) {
    el.authError.textContent = authError(e);
  }
}
$('auth-signin').addEventListener('click', () => doAuth('in'));
$('auth-signup').addEventListener('click', () => doAuth('up'));
el.authPass.addEventListener('keydown', e => { if (e.key === 'Enter') doAuth('in'); });
$('auth-reset').addEventListener('click', async () => {
  const email = el.authEmail.value.trim();
  if (!email) { el.authError.textContent = 'Enter your email first.'; return; }
  try { await Sync.resetPassword(email); el.authError.textContent = 'Reset email sent — check your inbox.'; }
  catch (e) { el.authError.textContent = authError(e); }
});

/* ── Render & tick ───────────────────────────────────────────────── */
function renderAll() {
  drawHeader();
  const { t, day } = drawFlower();
  drawNow(t, todayKey());
  drawAperture(t, day);
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
   everything down; first sign-in ever pushes the local garden up. */
Sync.onFirstSync = () => {
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
