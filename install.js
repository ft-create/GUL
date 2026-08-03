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

/* Safari on a Mac. It can install — File → Add to Dock, since Sonoma — but
   like every other Safari it never fires beforeinstallprompt, so JavaScript
   cannot start the flow. Without this branch the card hid itself on macOS
   and the app looked as though it simply could not be installed, which is
   not true. Detection is by exclusion: every Chromium browser on macOS also
   carries "Safari" in the user-agent string. */
function isMacSafari() {
  if (isIOS()) return false;
  if (navigator.platform !== 'MacIntel' && !/Mac OS X/.test(navigator.userAgent)) return false;
  const ua = navigator.userAgent;
  return /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR|Brave/.test(ua);
}

/* Android. Chromium browsers there usually offer beforeinstallprompt, but
   not always — Firefox never, WebViews never, and Chrome itself withholds
   it until its own heuristics are satisfied. The card must not vanish in
   those gaps: Android can always install from the browser menu, so the
   honest fallback is instructions, not silence. */
function isAndroid() {
  return /Android/i.test(navigator.userAgent);
}

/* Samsung Internet calls the action "Add page to" / "Add to Home screen",
   not "Install app". Naming the wrong menu item costs the person a minute
   of hunting, so it gets its own words. */
function isSamsungInternet() {
  return /SamsungBrowser/i.test(navigator.userAgent);
}

/* In-app browsers — the WebViews inside Gmail, Instagram, Facebook,
   WhatsApp, Messages, Google Search and friends. None of them can install
   anything, and a button that pretends otherwise is a lie. The `; wv`
   token is Android's own WebView marker; the rest are the apps that ship
   their own. Detection cannot be exhaustive, so anything it misses simply
   gets the ordinary menu instructions instead. */
function isInAppBrowser() {
  const ua = navigator.userAgent;
  return /(; wv\)|\bwv\b)/.test(ua)
    || /Instagram|FBAN|FBAV|FB_IAB|Line\/|Twitter|TikTok|Snapchat|GSA\/|Gmail|WhatsApp|Messenger/i.test(ua);
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
  const macSafari = isMacSafari();
  const android = !ios && isAndroid();
  const inApp = android && isInAppBrowser();
  /* Platforms that can install but cannot always be asked programmatically.
     iOS and macOS Safari never fire the prompt; Android sometimes does, and
     when it does the native path below is preferred — the sheet is only the
     fallback for the gaps. */
  const manualOnly = ios || macSafari || android;

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
        `<div class="inst-sub">${macSafari ? 'Add to your Dock' : 'Add to your Home Screen'}</div>` +
      '</div>' +
      '<button class="inst-btn" type="button">Install</button>' +
    '</div>';

  const card = mount.querySelector('.inst-card');
  const btn  = mount.querySelector('.inst-btn');

  function refresh() {
    /* Show the card wherever installing is actually possible. iOS and macOS
       Safari can always be instructed; every other browser only once it has
       handed us a prompt to fire. */
    const show = manualOnly || haveNativePrompt();
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
    /* Native prompt when the browser has offered one — that is the real
       install and always preferred. Instructions only when it hasn't. */
    if (!haveNativePrompt() && manualOnly) { openSheet(); return; }

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
        `<h2 class="inst-h" id="inst-h">Add ${appName} to your ${macSafari ? 'Dock' : 'Home Screen'}</h2>` +
        '<p class="inst-lede">Faster to open, and it runs full screen with no browser bar.</p>' +
        (ios && !iosSafari ?
          '<p class="inst-warn">You are not in Safari. Adding to the Home Screen only ' +
          'works from Safari on iPhone and iPad — open this page there first.</p>' : '') +
        (inApp ?
          /* An app's built-in browser. It cannot install anything, and no
             set of steps changes that — the only honest instruction is the
             way out. No numbered steps, no dead install button. */
          '<p class="inst-warn">You are in an app&rsquo;s built-in browser, which ' +
          'cannot install apps. Open this link in Chrome or your usual browser, ' +
          'then install from there.</p>' +
          '<button class="inst-copy" type="button">Copy link</button>'
        : '') +
        (inApp ? '' :
        '<ol class="inst-steps">' +
          (android ?
            /* Android outside a native prompt. The menu item's name varies
               by browser, so say so rather than guessing wrong. */
            '<li><span class="inst-num">1</span><span>Open your browser&rsquo;s menu ' +
              '<b>&#8942;</b> at the top of the screen.</span></li>' +
            (isSamsungInternet() ?
              '<li><span class="inst-num">2</span><span>Choose <b>Add page to</b>, then <b>Home screen</b>.</span></li>'
            :
              '<li><span class="inst-num">2</span><span>Choose <b>Install app</b> or <b>Add to Home screen</b> &mdash; the wording varies by browser.</span></li>'
            ) +
            '<li><span class="inst-num">3</span><span>Confirm. The flower appears on your Home Screen.</span></li>'
          : macSafari ?
            /* macOS Safari. Add to Dock lives in the File menu and in the
               Share menu; the File menu is the one that is always visible,
               so that is the one we name. */
            '<li><span class="inst-num">1</span><span>Open the <b>File</b> menu in the ' +
              'menu bar at the top of the screen.</span></li>' +
            '<li><span class="inst-num">2</span><span>Choose <b>Add to Dock</b>.</span></li>' +
            '<li><span class="inst-num">3</span><span>Click <b>Add</b>. The flower appears ' +
              'in your Dock.</span></li>'
          :
            '<li><span class="inst-num">1</span><span>Tap the <b>Share</b> button ' +
              '<span class="inst-share" aria-hidden="true">' +
                '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
                '<path d="M12 15V3"></path><path d="M8 7l4-4 4 4"></path>' +
                '<path d="M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"></path></svg>' +
              '</span> at the bottom of Safari.</span></li>' +
            '<li><span class="inst-num">2</span><span>Scroll and choose <b>Add to Home Screen</b>.</span></li>' +
            '<li><span class="inst-num">3</span><span>Tap <b>Add</b>. The flower appears on your Home Screen.</span></li>'
          ) +
        '</ol>') +
        '<button class="inst-ok primary" type="button">Got it</button>' +
      '</div>';
    document.body.appendChild(el);

    el.querySelector('.inst-x').addEventListener('click', closeSheet);
    el.querySelector('.inst-ok').addEventListener('click', closeSheet);
    const copyBtn = el.querySelector('.inst-copy');
    if (copyBtn) copyBtn.addEventListener('click', async () => {
      /* Async clipboard first; execCommand as the fallback, because several
         in-app browsers still gate the modern API. If both fail, say so —
         a button that claims success it did not have is worse than none. */
      const link = 'https://gul.fareedtareen.com/';
      let ok = false;
      try { await navigator.clipboard.writeText(link); ok = true; } catch {}
      if (!ok) {
        try {
          const t = document.createElement('textarea');
          t.value = link; document.body.appendChild(t); t.select();
          ok = document.execCommand('copy'); t.remove();
        } catch {}
      }
      copyBtn.textContent = ok ? 'Link copied' : 'Could not copy — long-press the address bar';
      announce(ok ? 'Link copied.' : 'Copy failed.');
    });
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
