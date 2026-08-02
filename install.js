/* GUL — the install experience.
 *
 * Written as a self-contained module with no Gul-specific values in its
 * logic, so the next app under experiment.fareedtareen.com can call
 * initInstall() with its own config rather than copying this file and
 * editing five strings. Everything that differs between apps is a
 * parameter; everything that differs between *platforms* is in here.
 *
 * The honest constraint this module exists to respect: iOS has no
 * programmatic install. Safari will never fire beforeinstallprompt, and
 * no amount of JavaScript changes that. So on iPhone the button does not
 * install anything — it opens instructions, and it says so. Anything that
 * implies otherwise is a lie the user discovers ten seconds later.
 */

/* ── Platform truths ──────────────────────────────────────────────── */

/* Already installed. Two checks because iOS predates the standard one and
   still reports through navigator.standalone. */
export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

/* iPadOS reports itself as a Mac. maxTouchPoints is what separates an iPad
   from a MacBook, since both claim MacIntel. */
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/* Every iOS browser is Safari underneath, but only real Safari has the
   Share → Add to Home Screen path. Chrome, Firefox and the in-app browsers
   inside Instagram or WhatsApp cannot install, so they need different
   words. Detection is by exclusion because they all carry "Safari" in the
   user-agent string. */
function isIOSSafari() {
  if (!isIOS()) return false;
  const ua = navigator.userAgent;
  return !/CriOS|FxiOS|EdgiOS|OPiOS|Instagram|FBAN|FBAV|Line\//.test(ua);
}

/* ── Dismissal memory ─────────────────────────────────────────────── */

const DISMISS_KEY = 'gul.install.dismissed';

function dismissedUntil(days) {
  try {
    const at = Number(localStorage.getItem(DISMISS_KEY) || 0);
    if (!at) return false;
    return Date.now() < at + days * 86400000;
  } catch { return false; }
}
function rememberDismissal() {
  try { localStorage.setItem(DISMISS_KEY, String(Date.now())); } catch {}
}

/* ── The module ───────────────────────────────────────────────────── */

export function initInstall(cfg) {
  const {
    appName, appIcon, mount,
    dismissalDurationDays = 14,
    onEvent = () => {},
  } = cfg;

  if (!mount) return;

  /* Installed already: the whole apparatus disappears. Not disabled, not
     greyed out — absent. A person who has installed the app should never
     see a word about installing it. */
  if (isStandalone()) {
    mount.hidden = true;
    onEvent('running_standalone');
    /* Still hand back the shape callers expect. A deep link asking to
       install, arriving at an app that is already installed, should do
       nothing quietly — not throw. */
    return { request() {}, openSheet() {}, closeSheet() {}, dismissed: () => false };
  }

  const ios = isIOS();
  const iosSafari = isIOSSafari();

  /* On Android and desktop the button is only honest if the browser has
     actually offered us a prompt. Until then there is nothing to trigger,
     so we show nothing rather than a button that does nothing. */
  const haveNativePrompt = () => !!window.__gulInstallEvent;

  /* ── The card ─────────────────────────────────────────────────────
     Lives in Settings, so it is always reachable and never interrupts.
     That is a deliberate reading of the brief: it asks for the button to
     be available in a menu or settings screen and to stay reachable after
     dismissal, and Gul's own rule is that silence is the default state.
     A banner over someone's prayer times would break both. */
  mount.innerHTML =
    '<div class="inst-card">' +
      `<img class="inst-icon" src="${appIcon}" width="46" height="46" alt="">` +
      '<div class="inst-text">' +
        `<div class="inst-name">Install ${appName}</div>` +
        '<div class="inst-sub">Add to your Home Screen</div>' +
      '</div>' +
      '<button class="inst-btn" type="button">Install</button>' +
    '</div>';

  const card = mount.querySelector('.inst-card');
  const btn  = mount.querySelector('.inst-btn');

  function refresh() {
    /* Three reasons to show the card, and one to hide it:
       iOS can always be instructed; other browsers only once they have
       given us a prompt to fire. */
    const show = ios || haveNativePrompt();
    mount.hidden = !show;
    if (show) onEvent('install_prompt_viewed');
  }

  refresh();
  window.addEventListener('gul:installable', refresh);
  window.addEventListener('gul:installed', () => {
    mount.hidden = true;
    announce(`${appName} has been installed.`);
    onEvent('install_completed');
  });

  /* A display-mode change means the app was installed and opened, or the
     window was moved into an installed context. Either way the card is
     now wrong. */
  const mq = window.matchMedia('(display-mode: standalone)');
  (mq.addEventListener ? mq.addEventListener.bind(mq, 'change') : mq.addListener.bind(mq))(
    () => { if (isStandalone()) mount.hidden = true; });

  /* The install path itself, separate from the button that usually starts
     it, because the welcome email links straight here with #install and
     needs the same behaviour without a click. */
  async function request() {
    onEvent('install_button_clicked');
    if (ios) { openSheet(); return; }

    const evt = window.__gulInstallEvent;
    if (!evt) return;                     /* nothing to fire; stay silent */
    evt.prompt();
    let outcome = 'dismissed';
    try { ({ outcome } = await evt.userChoice); } catch {}
    window.__gulInstallEvent = null;
    if (outcome === 'accepted') {
      onEvent('install_prompt_accepted');
      mount.hidden = true;
    } else {
      /* A cancelled prompt is a decision, not a failure. No error, no
         retry nag — just remember it and leave the card in Settings. */
      onEvent('install_prompt_dismissed');
      rememberDismissal();
    }
  }

  btn.addEventListener('click', request);

  /* ── The iOS sheet ────────────────────────────────────────────────
     A real dialog: focus is trapped, Escape closes, and focus returns to
     the button that opened it. Built once, on first use. */
  let sheet = null, lastFocus = null;

  function buildSheet() {
    const el = document.createElement('div');
    el.className = 'inst-scrim';
    el.hidden = true;
    el.innerHTML =
      '<div class="inst-sheet" role="dialog" aria-modal="true" aria-labelledby="inst-h">' +
        '<button class="inst-x" type="button" aria-label="Close">✕</button>' +
        `<img class="inst-sheet-icon" src="${appIcon}" width="60" height="60" alt="">` +
        `<h2 class="inst-h" id="inst-h">Add ${appName} to your Home Screen</h2>` +
        '<p class="inst-lede">Faster to open, and it runs full screen with no browser bar.</p>' +
        (iosSafari ? '' :
          '<p class="inst-warn">You are not in Safari. Adding to the Home Screen only ' +
          'works from Safari on iPhone and iPad — open this page there first.</p>') +
        '<ol class="inst-steps">' +
          '<li><span class="inst-num">1</span><span>Tap the <b>Share</b> button ' +
            '<span class="inst-share" aria-hidden="true">' +
              '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M12 15V3"></path><path d="M8 7l4-4 4 4"></path>' +
              '<path d="M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"></path></svg>' +
            '</span> at the bottom of Safari.</span></li>' +
          '<li><span class="inst-num">2</span><span>Scroll and choose <b>Add to Home Screen</b>.</span></li>' +
          '<li><span class="inst-num">3</span><span>Tap <b>Add</b>. The flower appears on your Home Screen.</span></li>' +
        '</ol>' +
        '<button class="inst-ok primary" type="button">Got it</button>' +
      '</div>';
    document.body.appendChild(el);

    el.querySelector('.inst-x').addEventListener('click', closeSheet);
    el.querySelector('.inst-ok').addEventListener('click', closeSheet);
    /* Clicking the scrim closes; clicking the sheet must not. */
    el.addEventListener('click', e => { if (e.target === el) closeSheet(); });
    return el;
  }

  function openSheet() {
    if (!sheet) sheet = buildSheet();
    lastFocus = document.activeElement;
    sheet.hidden = false;
    document.body.style.overflow = 'hidden';
    sheet.querySelector('.inst-ok').focus();
    document.addEventListener('keydown', onKey);
    onEvent('ios_instructions_opened');
  }

  function closeSheet() {
    if (!sheet) return;
    sheet.hidden = true;
    document.body.style.overflow = '';
    document.removeEventListener('keydown', onKey);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  function onKey(e) {
    if (e.key === 'Escape') { closeSheet(); return; }
    if (e.key !== 'Tab' || !sheet || sheet.hidden) return;
    const f = sheet.querySelectorAll('button');
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  /* Screen readers get told what happened; the visual UI already shows it. */
  function announce(msg) {
    let live = document.getElementById('inst-live');
    if (!live) {
      live = document.createElement('div');
      live.id = 'inst-live';
      live.setAttribute('role', 'status');
      live.setAttribute('aria-live', 'polite');
      live.className = 'sr-only';
      document.body.appendChild(live);
    }
    live.textContent = msg;
  }

  return { request, openSheet, closeSheet, dismissed: () => dismissedUntil(dismissalDurationDays) };
}
