/**
 * Gul — Firebase auth-handler proxy.
 *
 * Firebase serves its OAuth handler from pray-now-15f80.firebaseapp.com, and
 * that host is what Google prints on the account chooser: "to continue to
 * pray-now-15f80.firebaseapp.com". To anyone who did not create the project
 * that reads like a phishing domain, and a Firebase project ID can never be
 * renamed — so the only way to change what people see is to serve the handler
 * from a domain of our own and forward the traffic.
 *
 * This forwards the whole /__/ namespace, not just /__/auth/, because Firebase
 * also serves /__/firebase/init.json from there during some flows. Nothing
 * outside /__/ touches this function: it sits on a live sign-in path, so the
 * surface is kept deliberately small.
 *
 * The request is passed through whole — method, headers, cookies, body — and
 * the response is returned untouched. Rewriting either would break the OAuth
 * handshake, which depends on state and cookies surviving the round trip.
 */
export async function onRequest(context) {
  const url = new URL(context.request.url);
  url.protocol = 'https:';
  url.hostname = 'pray-now-15f80.firebaseapp.com';
  url.port = '';
  return fetch(new Request(url.toString(), context.request));
}
