/* Gul — the launch animation. Runs once, then holds at the real state.
 *
 *   import { splash } from './gul-splash.js';
 *   splash(document.querySelector('gul-mark'), { noted: 3, minute: 1058 });
 *
 * Sequence, 3.0s total:
 *   0ms     nothing but the sun, at its true colour for the moment
 *   240ms   petals open one at a time, 200ms apart, 760ms each
 *   1240ms  the last noted petal lands
 *   +600ms  hold
 * Honours prefers-reduced-motion by jumping straight to the end state.
 */
export function splash(el, { noted = 5, minute } = {}) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (minute != null) el.setAttribute('minute', String(minute));
  if (reduce) { el.setAttribute('noted', String(noted)); return Promise.resolve(); }

  el.setAttribute('noted', '0');
  return new Promise(resolve => {
    let i = 0;
    const step = () => {
      if (i >= noted) { setTimeout(resolve, 600); return; }
      el.setAttribute('noted', String(++i));
      setTimeout(step, 200);
    };
    setTimeout(step, 240);
  });
}

/* The sun, run across a whole day. For onboarding and the marketing page. */
export function runDay(el, { from = 200, to = 1439, seconds = 8 } = {}) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce) { el.setAttribute('minute', String(to)); return () => {}; }
  const t0 = performance.now(), span = to - from;
  let raf = 0;
  const tick = now => {
    const k = Math.min(1, (now - t0) / (seconds * 1000));
    el.setAttribute('minute', String(Math.round(from + span * k)));
    if (k < 1) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}
