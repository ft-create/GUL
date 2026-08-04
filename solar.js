/* Miqāt — solar engine.
 *
 * Real astronomical solar position and prayer times for any coordinates,
 * any date, any timezone. No dependencies.
 *
 * Algorithms: NOAA Solar Calculator (Jean Meeus, "Astronomical Algorithms"),
 * accurate to well under a minute for the years 1900–2100 at latitudes
 * below ~72°.
 *
 * Prayer times follow the standard definitions:
 *   Fajr     — sun reaches a chosen depression angle below the horizon before sunrise
 *   Sunrise  — upper limb appears, refraction-corrected (-0.833°)
 *   Dhuhr    — solar transit (true noon) plus a small safety margin
 *   Asr      — shadow of a gnomon reaches N× its height (N=1 standard, 2 Ḥanafī)
 *   Maghrib  — sunset, refraction-corrected
 *   Isha     — sun reaches a chosen depression angle after sunset
 *
 * All times are returned as minutes from local midnight (float), in the
 * timezone offset you pass in. Pass null-safe values: any window that does
 * not occur (polar summer/winter) comes back as null, and the chosen
 * high-latitude rule fills it.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/* ── Calculation conventions ─────────────────────────────────────────── */

export const METHODS = {
  MWL:        { name: 'Muslim World League',        fajr: 18,   isha: 17 },
  ISNA:       { name: 'Islamic Society of N. America', fajr: 15, isha: 15 },
  EGYPT:      { name: 'Egyptian General Authority', fajr: 19.5, isha: 17.5 },
  MAKKAH:     { name: 'Umm al-Qura, Makkah',        fajr: 18.5, ishaInterval: 90 },
  KARACHI:    { name: 'University of Karachi',      fajr: 18,   isha: 18 },
  TEHRAN:     { name: 'Univ. of Tehran',            fajr: 17.7, isha: 14 },
  JAFARI:     { name: 'Shia Ithna Ashari',          fajr: 16,   isha: 14 },
  TURKEY:     { name: 'Diyanet, Turkey',            fajr: 18,   isha: 17 },
  DUBAI:      { name: 'Dubai',                      fajr: 18.2, isha: 18.2 },
  SINGAPORE:  { name: 'Singapore',                  fajr: 20,   isha: 18 },
};

/* Ramadan adds 30 minutes to Umm al-Qura's Isha interval. */
export const HIGH_LAT_RULES = ['none', 'middleOfNight', 'seventhOfNight', 'twilightAngle'];

/* ── Julian day ──────────────────────────────────────────────────────── */

function toJulian(y, m, d) {
  if (m <= 2) { y -= 1; m += 12; }
  const A = Math.floor(y / 100);
  const B = 2 - A + Math.floor(A / 4);
  return Math.floor(365.25 * (y + 4716)) + Math.floor(30.6001 * (m + 1)) + d + B - 1524.5;
}

/* ── Solar position for a Julian day ─────────────────────────────────── */

function sunPosition(jd) {
  const T = (jd - 2451545.0) / 36525;                       // centuries since J2000
  const L0 = 280.46646 + T * (36000.76983 + T * 0.0003032); // geometric mean longitude
  const M  = 357.52911 + T * (35999.05029 - 0.0001537 * T); // mean anomaly
  const e  = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

  const Mr = M * RAD;
  const C = Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T))
          + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T)
          + Math.sin(3 * Mr) * 0.000289;

  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD);

  // Obliquity of the ecliptic, with nutation
  const seconds = 21.448 - T * (46.8150 + T * (0.00059 - T * 0.001813));
  const eps0 = 23 + (26 + seconds / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD);

  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;

  // Equation of time, in minutes
  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTime = 4 * DEG * (
      y * Math.sin(2 * L0 * RAD)
    - 2 * e * Math.sin(Mr)
    + 4 * e * y * Math.sin(Mr) * Math.cos(2 * L0 * RAD)
    - 0.5 * y * y * Math.sin(4 * L0 * RAD)
    - 1.25 * e * e * Math.sin(2 * Mr)
  );

  return { decl, eqTime };
}

/* Hour angle (degrees) at which the sun sits at `altitude` degrees.
   Returns null when the sun never reaches that altitude on this day. */
function hourAngle(altitude, latitude, decl) {
  const cosH = (Math.sin(altitude * RAD) - Math.sin(latitude * RAD) * Math.sin(decl * RAD))
             / (Math.cos(latitude * RAD) * Math.cos(decl * RAD));
  if (cosH > 1 || cosH < -1) return null;
  return Math.acos(cosH) * DEG;
}

/* ── The day ─────────────────────────────────────────────────────────── */

/**
 * Compute a full solar day.
 *
 * @param {Date}   date        any instant on the local day of interest
 * @param {number} latitude    degrees, north positive
 * @param {number} longitude   degrees, east positive
 * @param {number} tzOffsetMin minutes east of UTC (e.g. Karachi = 300).
 *                             Defaults to the device's offset for `date`.
 * @param {object} opts        { method, asrFactor, highLatRule, ishaInterval, dhuhrOffset }
 *
 * @returns {object} times in minutes from local midnight, plus the geometry
 *                   the Aperture needs to draw.
 */
export function solarDay(date, latitude, longitude, tzOffsetMin, opts = {}) {
  const method = typeof opts.method === 'string' ? METHODS[opts.method] : (opts.method || METHODS.MWL);
  const asrFactor = opts.asrFactor ?? 1;              // 1 standard, 2 Ḥanafī
  const highLatRule = opts.highLatRule ?? 'middleOfNight';
  const dhuhrOffset = opts.dhuhrOffset ?? 1;          // minutes past transit

  const tz = tzOffsetMin ?? -date.getTimezoneOffset();

  const jd = toJulian(date.getFullYear(), date.getMonth() + 1, date.getDate());
  const { decl, eqTime } = sunPosition(jd + 0.5 - tz / 1440);

  // Solar transit, in minutes from local midnight
  const transit = 720 - 4 * longitude - eqTime + tz;

  const at = (altitude, before) => {
    const H = hourAngle(altitude, latitude, decl);
    if (H === null) return null;
    return transit + (before ? -1 : 1) * 4 * H;
  };

  const HORIZON = -0.833;                             // refraction + solar radius
  const sunrise = at(HORIZON, true);
  const sunset  = at(HORIZON, false);

  // Asr: altitude where a gnomon's shadow is asrFactor × its height
  const asrAlt = Math.atan(1 / (asrFactor + Math.tan(Math.abs(latitude - decl) * RAD))) * DEG;
  let asr = at(asrAlt, false);

  let fajr = at(-method.fajr, true);
  let isha = method.ishaInterval != null
    ? (sunset != null ? sunset + method.ishaInterval + (opts.ramadan ? 30 : 0) : null)
    : at(-method.isha, false);

  // Peak altitude, for the arc's amplitude
  const peakAlt = 90 - Math.abs(latitude - decl);

  /* ── High-latitude fallbacks ──────────────────────────────────────── */
  let adjusted = null;
  /* Applied as a BOUND, not only a fallback. Standard semantics (adhan and
     the widely used timetables) cap Fajr at a portion of night before
     sunrise and Isha after sunset, whether or not an astronomical solution
     exists. Verified against adhan, London 4 Aug 2026: seventhOfNight
     clamps 02:44 to 04:13, twilightAngle to 02:51, middleOfNight leaves
     it. At normal latitudes the limits sit far outside the raw times and
     this block changes nothing. */
  if (sunrise != null && sunset != null) {
    const night = 1440 - (sunset - sunrise);
    let fajrPortion, ishaPortion;
    if (highLatRule === 'middleOfNight') { fajrPortion = ishaPortion = night / 2; }
    else if (highLatRule === 'seventhOfNight') { fajrPortion = night / 7; ishaPortion = night / 7; }
    else if (highLatRule === 'twilightAngle') { fajrPortion = night / (60 / method.fajr); ishaPortion = night / (60 / (method.isha ?? 17)); }
    else { fajrPortion = ishaPortion = night / 2; }

    const fajrLimit = sunrise - fajrPortion;
    const ishaLimit = sunset + ishaPortion;
    if (fajr === null || fajr < fajrLimit) { fajr = fajrLimit; adjusted = highLatRule; }
    /* Interval-based Isha (e.g. Umm al-Qura's 90 minutes) is already a
       bounded convention; only angle-based Isha needs the cap. */
    if (isha === null || (method.ishaInterval == null && isha > ishaLimit)) { isha = ishaLimit; adjusted = highLatRule; }
  }

  const polar = sunrise === null || sunset === null;
  if (polar) {
    // Midnight sun or polar night: no sunrise/sunset today. Nearest-latitude
    // is the honest fallback; the caller should surface `polar` in the UI.
    const ref = solarDay(date, Math.sign(latitude) * 48, longitude, tz, opts);
    return { ...ref, polar: true, peakAlt, decl, latitude, longitude, tz, adjusted: 'nearestLatitude' };
  }

  return {
    fajr, sunrise, dhuhr: transit + dhuhrOffset, asr, maghrib: sunset, isha,
    sunset, transit, decl, peakAlt, latitude, longitude, tz,
    asrFactor, method: method.name, adjusted, polar: false,
  };
}

/* ── Instantaneous geometry, for drawing ─────────────────────────────── */

/** True solar altitude in degrees at `minute` of the local day. */
export function altitudeAt(minute, day) {
  const H = (minute - day.transit) / 4;               // degrees of hour angle
  const { latitude, decl } = day;
  const sinAlt = Math.sin(latitude * RAD) * Math.sin(decl * RAD)
               + Math.cos(latitude * RAD) * Math.cos(decl * RAD) * Math.cos(H * RAD);
  return Math.asin(Math.max(-1, Math.min(1, sinAlt))) * DEG;
}

/** Solar azimuth in degrees, measured clockwise from true north. */
export function azimuthAt(minute, day) {
  const H = (minute - day.transit) / 4;
  const { latitude, decl } = day;
  const alt = altitudeAt(minute, day) * RAD;
  const cosAz = (Math.sin(decl * RAD) - Math.sin(alt) * Math.sin(latitude * RAD))
              / (Math.cos(alt) * Math.cos(latitude * RAD));
  const az = Math.acos(Math.max(-1, Math.min(1, cosAz))) * DEG;
  return H > 0 ? 360 - az : az;
}

/** Shadow length ÷ object height. Infinity when the sun is at or below the horizon.
 *  ≥ 1 → Asr has begun (Shāfiʿī, Mālikī, Ḥanbalī). ≥ 2 → Asr has begun (Ḥanafī). */
export function shadowRatioAt(minute, day) {
  const alt = altitudeAt(minute, day);
  if (alt <= 0.05) return Infinity;
  return 1 / Math.tan(alt * RAD);
}

/** Which sky ramp to paint. Feeds the .pn-sky-* tokens. */
export function skyKeyAt(minute, day) {
  const alt = altitudeAt(minute, day);
  const rising = minute < day.transit;
  if (alt > 26) return 'day';
  if (alt > 8) return 'afternoon';
  if (alt > 0) return rising ? 'rise' : 'set';
  if (alt > -11) return 'twilight';
  return 'night';
}

/* ── Prayer windows ──────────────────────────────────────────────────── */

/** The five windows as [from, to) pairs in local minutes. Isha runs to next Fajr. */
export function windows(day, nextFajr) {
  return [
    { key: 'fajr',    name: 'Fajr',    from: day.fajr,    to: day.sunrise, note: 'first light to sunrise' },
    { key: 'dhuhr',   name: 'Dhuhr',   from: day.dhuhr,   to: day.asr,     note: 'the sun has passed its meridian' },
    { key: 'asr',     name: 'Asr',     from: day.asr,     to: day.maghrib, note: day.asrFactor === 2 ? 'shadow is twice the object' : 'shadow equals the object' },
    { key: 'maghrib', name: 'Maghrib', from: day.maghrib, to: day.isha,    note: 'the disc is gone' },
    { key: 'isha',    name: 'Isha',    from: day.isha,    to: (nextFajr ?? day.fajr) + 1440, note: 'the last red has left the sky' },
  ];
}

export function activeWindow(minute, day, nextFajr) {
  return windows(day, nextFajr).find(w => {
    const to = w.to > 1440 ? w.to : w.to;
    return minute >= w.from && minute < to;
  }) || null;
}

export function nextWindow(minute, day, nextFajr) {
  const ws = windows(day, nextFajr);
  return ws.find(w => w.from > minute) || { ...ws[0], from: ws[0].from + 1440 };
}

/* ── Convenience ─────────────────────────────────────────────────────── */

/**
 * Format minutes-from-midnight as a clock reading.
 *
 * @param {number} m
 * @param {object} opts
 *   hour12   — 12-hour clock with a meridiem suffix (default true)
 *   seconds  — include seconds
 *   meridiem — 'lower' | 'upper' | 'none' (default 'lower' → "5:12 am")
 */
export function fmtMinutes(m, { hour12 = true, seconds = false, meridiem = 'lower' } = {}) {
  const x = ((m % 1440) + 1440) % 1440;
  const h24 = Math.floor(x / 60);
  const min = Math.floor(x % 60);
  const s = Math.round((x - Math.floor(x)) * 60);

  const h = hour12 ? (h24 % 12 === 0 ? 12 : h24 % 12) : h24;
  const hh = hour12 ? String(h) : String(h).padStart(2, '0');
  const core = seconds
    ? `${hh}:${String(min).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${hh}:${String(min).padStart(2, '0')}`;

  if (!hour12 || meridiem === 'none') return core;
  const suffix = h24 < 12 ? 'am' : 'pm';
  return `${core} ${meridiem === 'upper' ? suffix.toUpperCase() : suffix}`;
}

/** Minutes from local midnight for a Date, in its own timezone. */
export function minuteOf(date) {
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

/** Today's solar day for the device's own location and timezone. */
export function localDay(latitude, longitude, opts = {}) {
  const now = new Date();
  return solarDay(now, latitude, longitude, -now.getTimezoneOffset(), opts);
}
