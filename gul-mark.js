/* Gul — the animated mark. One file, no dependencies, no build step.
 *
 *   <gul-mark noted="2" minute="1058" live></gul-mark>
 *
 * Attributes
 *   noted    0–5, how many prayers are noted (clockwise from Fajr at the top)
 *   minute   0–1439, local minute of day. Omit + set live to follow the clock.
 *   live     tick once a minute from the device clock
 *   fajr / isha / sunrise / sunset / peak   override the solar day (minutes, degrees)
 *   ink      petal colour            default #F2EDE3
 *   size     css length              default 100%
 *   flat     draw with no motion (widget / print)
 *
 * Methods:  el.note(i)   el.unnote(i)   el.setMinute(m)
 * Events:   'gul-petal'  detail { index, noted }
 *
 * Motion law — two families, never mixed:
 *   the sun is LINEAR 600ms (it does not accelerate for anybody)
 *   a petal is EASED 760ms (it answers a person)
 */
const EASE = 'cubic-bezier(.22,1,.36,1)';
const RAMP = [
  [-40, [42, 38, 58]], [-30, [86, 54, 66]], [-22, [150, 70, 62]], [-14, [186, 84, 58]],
  [-5, [214, 100, 52]], [1, [226, 120, 54]], [8, [235, 148, 70]], [20, [242, 184, 100]],
  [40, [249, 222, 158]], [58, [253, 241, 210]], [70, [255, 251, 238]],
];
const NIGHT = '#9AA6AE';   // Isha to first light. A grey disc, never a crescent.

function domePath(L, base, haunch) {
  const r = x => Math.round(x * 100) / 100;
  return `M${r(-base)} 0 C${r(-haunch)} ${r(-0.22 * L)} ${r(-haunch)} ${r(-0.44 * L)} ${r(-haunch * 0.88)} ${r(-0.6 * L)}` +
    ` C${r(-haunch * 0.66)} ${r(-0.76 * L)} ${r(-haunch * 0.3)} ${r(-0.88 * L)} 0 ${r(-L)}` +
    ` C${r(haunch * 0.3)} ${r(-0.88 * L)} ${r(haunch * 0.66)} ${r(-0.76 * L)} ${r(haunch * 0.88)} ${r(-0.6 * L)}` +
    ` C${r(haunch)} ${r(-0.44 * L)} ${r(haunch)} ${r(-0.22 * L)} ${r(base)} 0 Z`;
}
const PETAL = domePath(22, 5.2, 8);

export function sunColour(alt, setting) {
  let lo = RAMP[0], hi = RAMP[RAMP.length - 1];
  for (let i = 0; i < RAMP.length - 1; i++) {
    if (alt >= RAMP[i][0] && alt <= RAMP[i + 1][0]) { lo = RAMP[i]; hi = RAMP[i + 1]; break; }
  }
  const k = Math.max(0, Math.min(1, (alt - lo[0]) / ((hi[0] - lo[0]) || 1)));
  const warm = setting && alt < 30 ? [10, -6, -12] : [0, 0, 0];
  const c = lo[1].map((v, j) => Math.max(0, Math.min(255, Math.round(v + (hi[1][j] - v) * k + warm[j]))));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

class GulMark extends HTMLElement {
  static observedAttributes = ['noted', 'minute', 'ink', 'size', 'flat', 'live'];

  connectedCallback() {
    if (this.__built) return;
    this.__built = true;
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>
      :host { display: inline-block; line-height: 0; }
      svg { width: 100%; height: 100%; display: block; overflow: visible; }
      path { cursor: pointer; }
      @media (prefers-reduced-motion: reduce) { path, circle { transition-duration: 1ms !important; } }
    </style>
    <svg viewBox="0 0 64 64" role="img"><g id="p"></g><circle id="s" cx="32" cy="32" r="7.4"></circle></svg>`;
    this.$svg = root.querySelector('svg');
    this.$g = root.getElementById('p');
    this.$sun = root.getElementById('s');

    for (let i = 0; i < 5; i++) {
      const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      el.setAttribute('d', PETAL);
      el.setAttribute('transform', `translate(32,32) rotate(${i * 72}) translate(0,-5.6)`);
      el.addEventListener('click', () => {
        const noted = this.noted;
        this.setAttribute('noted', i < noted ? i : i + 1);
        this.dispatchEvent(new CustomEvent('gul-petal', { detail: { index: i, noted: i >= noted }, bubbles: true }));
      });
      this.$g.appendChild(el);
    }
    if (this.hasAttribute('live')) {
      this.__t = setInterval(() => this.render(), 60000);
      this.setMinute(nowMinute());
    }
    this.render();
  }

  disconnectedCallback() { clearInterval(this.__t); }
  attributeChangedCallback() { if (this.__built) this.render(); }

  get noted() { return Math.max(0, Math.min(5, Number(this.getAttribute('noted') || 0))); }
  get minute() {
    const m = this.getAttribute('minute');
    return m == null ? nowMinute() : Number(m);
  }
  note(i) { if (i + 1 > this.noted) this.setAttribute('noted', i + 1); }
  unnote(i) { if (i < this.noted) this.setAttribute('noted', i); }
  setMinute(m) { this.setAttribute('minute', String(m)); }

  render() {
    const ink = this.getAttribute('ink') || '#F2EDE3';
    const flat = this.hasAttribute('flat');
    const size = this.getAttribute('size');
    if (size) { this.style.width = size; this.style.height = size; }

    const day = {
      fajr: num(this, 'fajr', 281), sunrise: num(this, 'sunrise', 377),
      sunset: num(this, 'sunset', 1262), isha: num(this, 'isha', 1356), peak: num(this, 'peak', 68),
    };
    const t = this.minute;
    const f = (t - day.sunrise) / (day.sunset - day.sunrise);
    const alt = day.peak * Math.sin(Math.PI * Math.max(-0.4, Math.min(1.4, f)));
    const night = t >= day.isha || t < day.fajr;
    const lift = Math.max(0, Math.min(1, (alt + 8) / day.peak));
    const fill = night ? NIGHT : sunColour(alt, t > (day.sunrise + day.sunset) / 2);
    const noted = this.noted;

    this.$svg.setAttribute('aria-label',
      `${noted} of five prayers noted. ${night ? 'Night.' : 'The sun is ' + alt.toFixed(0) + ' degrees above the horizon.'}`);

    [...this.$g.children].forEach((el, i) => {
      const on = i < noted;
      el.setAttribute('fill', on ? ink : 'none');
      el.setAttribute('stroke', ink);
      el.setAttribute('stroke-width', on ? 0 : 1.1);
      el.setAttribute('opacity', on ? 1 : 0.4);
      el.style.transition = flat ? 'none' : `fill 760ms ${EASE}, opacity 760ms ${EASE}, stroke-width 760ms ${EASE}`;
    });

    this.$sun.setAttribute('r', night ? 7.4 : 7.4 + lift * 3.4);
    this.$sun.setAttribute('fill', fill);
    this.$sun.style.filter = `drop-shadow(0 0 ${night ? 5 : 3 + lift * 7}px ${fill})`;
    this.$sun.style.transition = flat ? 'none' : 'r 600ms linear, fill 600ms linear, filter 600ms linear';

    let m = this.$svg.querySelector('mask');
    if (night && !m) {
      const id = 'gm' + Math.random().toString(36).slice(2, 7);
      m = document.createElementNS('http://www.w3.org/2000/svg', 'mask');
      m.setAttribute('id', id);
      m.innerHTML = '<circle cx="32" cy="32" r="8" fill="#fff"/><circle cx="36.8" cy="28.6" r="7.6" fill="#000"/>';
      this.$svg.insertBefore(m, this.$svg.firstChild);
      this.$sun.setAttribute('mask', `url(#${id})`);
    } else if (!night && m) {
      m.remove();
      this.$sun.removeAttribute('mask');
    }
  }
}

const num = (el, name, dflt) => (el.hasAttribute(name) ? Number(el.getAttribute(name)) : dflt);
const nowMinute = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };

customElements.define('gul-mark', GulMark);
export default GulMark;
