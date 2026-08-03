/* POST /api/gul/welcome — Gul's welcome letter.
 *
 * Namespaced under /api/gul/ deliberately. IRONCADE lives in this same repo,
 * shares this Pages project and is being built in parallel by someone else;
 * leaving /api/welcome free means neither of us has to think about the other.
 * The two apps are separate Firebase projects with separate users, so there
 * is nothing to share here beyond the Resend key.
 *
 * Safe to sit beside the existing Firebase functions directory — I checked
 * the build log rather than assuming:
 *
 *   Found Functions directory at /functions. Uploading.
 *   ✘ [ERROR] No routes found when building Functions directory
 *   Warning: Wrangler did not find routes when building functions. Skipping.
 *
 * Wrangler compiles only files exporting onRequest*. Firebase's index.js,
 * lib/ and welcome-email.js export nothing of the kind, so they are ignored
 * rather than bundled — their node dependencies never reach the Workers
 * runtime. This file simply becomes the first real route.
 *
 * The abuse model, because this endpoint is public and anything public that
 * sends mail is a spam cannon unless you take it seriously:
 *
 *   1. The recipient is never read from the request. It comes out of a
 *      Firebase ID token that Google verified for us, so a caller cannot ask
 *      this endpoint to mail somebody else.
 *   2. The account must be minutes old, so a stolen token is not a reusable
 *      send button.
 *   3. The body is fetched from our own origin, never accepted from the
 *      caller.
 *
 * Worst case for a determined attacker: they mail themselves twice in their
 * first quarter hour. Small enough to run without a KV binding or a database
 * write — and every piece of infrastructure not added is a piece that cannot
 * break at 3am.
 */

/* Public by design. Firebase Web API keys identify a project, they authorise
 * nothing, and this one already ships in the client bundle. The only real
 * secret is RESEND_API_KEY, which lives in the environment. */
const FIREBASE_API_KEY = 'AIzaSyD6jN5hO3PD6opQkzl3FBLB2K52lJtfR-Y';

const TEMPLATE_MARKER = 'Pray your five';
const WELCOME_URL = 'https://gul.fareedtareen.com/email/welcome.html';
const FROM = 'Gul <hello@fareedtareen.com>';
const SUBJECT = 'Welcome to Gul';

/* Long enough to survive a slow first paint, a redirect sign-in that leaves
   the page and comes back, and a phone that lost signal mid-signup. Short
   enough that the token stops being useful quickly. */
const MAX_ACCOUNT_AGE_MS = 15 * 60 * 1000;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export async function onRequestPost({ request, env }) {
  if (!env.RESEND_API_KEY) {
    /* Not the caller's fault, and not something to leak detail about. */
    console.error('gul/welcome: RESEND_API_KEY is not set');
    return json(503, { error: 'mail_not_configured' });
  }

  const auth = request.headers.get('authorization') || '';
  const idToken = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!idToken) return json(401, { error: 'no_token' });

  /* accounts:lookup validates the signature, the expiry and the audience for
     us, and hands back the account record — which is also where we learn how
     old the account is. One call answers both questions. */
  let account;
  try {
    const r = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken }),
      },
    );
    if (!r.ok) return json(401, { error: 'bad_token' });
    account = ((await r.json()).users || [])[0];
  } catch (e) {
    console.error('gul/welcome: token lookup failed', e);
    return json(502, { error: 'verify_failed' });
  }

  if (!account) return json(401, { error: 'bad_token' });

  const email = account.email;
  if (!email) return json(400, { error: 'no_email' });

  /* createdAt is milliseconds since epoch, as a string. */
  const createdAt = Number(account.createdAt || 0);
  if (!createdAt) return json(400, { error: 'no_created_at' });
  /* A negative age is clock skew between us and Google, not an attack; a few
     seconds either way should not cost somebody their welcome. */
  if (Date.now() - createdAt > MAX_ACCOUNT_AGE_MS) return json(409, { error: 'not_new' });

  /* Fetched from our own origin so the letter and the hosted copy can never
     drift apart: editing welcome.html is the only way to change what gets
     sent, and there is no second copy to forget about. */
  let html;
  try {
    const r = await fetch(WELCOME_URL, { cf: { cacheTtl: 300 } });
    if (!r.ok) throw new Error(`welcome.html responded ${r.status}`);
    html = await r.text();
    /* A 200 is not proof we got the letter. When Gul moved origins, every
       /gul/* path on the old host began answering 200 with a move-notice
       page, so this fetch succeeded and the notice went out under the
       subject "Welcome to Gul". Check for a phrase only the real template
       carries and refuse to send anything else. */
    if (!html.includes(TEMPLATE_MARKER))
      throw new Error('fetched page is not the welcome letter');
  } catch (e) {
    console.error('gul/welcome: could not fetch the email body', e);
    return json(502, { error: 'body_unavailable' });
  }

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        /* Deterministic per-account key. Resend holds it for 24 hours, so a
           replay, a second tab, or a popup-and-redirect overlap cannot mail
           twice; after 24 hours the not_new check above rejects the request
           anyway. The two windows overlap completely. */
        'Idempotency-Key': `gul-welcome/${account.localId}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM,
        reply_to: 'ft@fareedtareen.com',
        to: [email],
        subject: SUBJECT,
        html,
        /* Every HTML mail needs this twin. Some clients prefer it, some
           people force it, and a spam filter that sees only HTML thinks
           less of you. */
        text:
          'Gul means flower. Your five daily prayers are its five petals - '
        + 'each prayer you note opens one, and a day fully prayed is a '
        + 'flower in full bloom. A simple way to keep track of your five. '
          + 'One tap to note each one.\n\n'
          + 'Open Gul: https://gul.fareedtareen.com/\n'
          + 'Add it to your Home Screen: https://gul.fareedtareen.com/#install\n\n'
          + 'Pray your five each day - Gul is simply the place to keep '
        + 'track of them. One tap for each prayer, and a petal opens.\n\n'
        + 'Note them as they come, day after day, and the record builds '
        + 'itself - steady, simple, yours.\n\n\u2014 Gul',
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error('gul/welcome: resend rejected the send', r.status, detail);
      return json(502, { error: 'send_failed' });
    }

    const sent = await r.json();

    /* Delivery metadata only - event, uid, provider message id. Never

       bodies, links, or tokens. */

    console.log('gul/welcome: sent', account.localId, sent.id || '');

    return json(200, { ok: true, id: sent.id });
  } catch (e) {
    console.error('gul/welcome: send threw', e);
    return json(502, { error: 'send_failed' });
  }
}

/* A 405 rather than a 404 on GET, so anyone poking at the URL can tell the
   route exists and they are simply using it wrong. */
export async function onRequest() {
  return json(405, { error: 'method_not_allowed' });
}
