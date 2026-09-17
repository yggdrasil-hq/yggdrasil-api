/**
 * Reads one cookie out of a raw HTTP `Cookie` header.
 *
 * Hand-rolled rather than imported from the `cookie` package: that package is
 * present transitively (Express depends on it) but is not a declared
 * dependency of this repo, and importing an undeclared package is precisely
 * how `ws` had to be installed by hand before this lane could typecheck
 * (ADR 019 item 3). The format is narrow enough to own.
 *
 * This exists because a WebSocket upgrade never enters Express's middleware
 * chain, so `cookie-parser` has not populated `req.cookies` by the time the
 * socket is handed to us. The session cookie is the *only* credential the
 * relay accepts — the same one every other authenticated route uses — so
 * reading it correctly at this boundary is the whole of the relay's auth
 * (ADR 019 item 3).
 *
 * Semantics follow RFC 6265 closely enough for a single well-formed header:
 * pairs separated by ";", name and value split on the *first* "=" (so a value
 * may contain "=", e.g. base64 padding), and one layer of surrounding quotes
 * stripped. A malformed pair is skipped rather than failing the whole header —
 * a browser may send other cookies we do not care about.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header || !name) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;

    let value = part.slice(separator + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    // An empty value is "no credential" rather than an empty-string session
    // id: findValid would reject it anyway, and returning null keeps the one
    // "not authenticated" spelling at the call site.
    return value === "" ? null : value;
  }

  return null;
}
