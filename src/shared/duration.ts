/**
 * Parses a Go-style duration string (`"24h"`, `"1h30m"`, `"90s"`) into
 * milliseconds, or null when the input is not a duration.
 *
 * **Why this exists rather than `Number(process.env.X)`.** The API is one half of
 * a value the Orchestrator owns (see `config.grills.replyTimeoutMs`), and on a
 * self-hosted install the operator sets it in the Orchestrator's `.env` in Go's
 * syntax — `GRILL_REPLY_TIMEOUT=24h`, because that is what
 * `orchestrator/cmd/server/main.go`'s `resolveDuration` accepts. If this side
 * accepted only milliseconds, the same bound would have to be written as
 * `86400000` in one file and `24h` in the other, which is two spellings of one
 * number and therefore something that can disagree without looking wrong. So the
 * API accepts the same syntax it will be copied from.
 *
 * **It is deliberately a copy of Go's grammar, not a superset.** A value that
 * parses here must parse there and vice versa, or the copy-paste this exists to
 * make safe becomes a trap. That rules out the conveniences an operator might
 * reach for and Go rejects — `"1d"` (Go has no day unit) and a bare number
 * (`"3600"`) are both **null**, not "3600 of something". Both failures are
 * reported through the caller's default-and-warn path rather than silently
 * reinterpreted; see `resolveGrillReplyTimeout`.
 *
 * The subset of Go's grammar that is supported is the whole of it in practice:
 * a sign, then one or more `<number><unit>` segments summed, where the unit is
 * `ns`, `us`/`µs`, `ms`, `s`, `m` or `h`. `"1h30m"` is 5400000 ms, as in Go.
 */

/** Milliseconds per unit, keyed by the unit strings Go accepts. */
const UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  "µs": 1e-3,
  // `ms` must precede `m` in the alternation below, or `"1ms"` reads as one
  // minute followed by a stray `s`.
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

const SEGMENT = /(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g;

export function parseGoDurationMs(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  let sign = 1;
  let rest = trimmed;
  if (rest.startsWith("-")) {
    sign = -1;
    rest = rest.slice(1);
  } else if (rest.startsWith("+")) {
    rest = rest.slice(1);
  }
  // A sign with nothing after it, or a bare number: Go rejects both, so this
  // must too (`"0"` is a valid Go duration only as `"0s"`).
  if (rest === "") return null;

  let totalMs = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  SEGMENT.lastIndex = 0;

  while ((match = SEGMENT.exec(rest)) !== null) {
    // Any gap between the previous segment and this one is an unrecognised
    // character, so the whole string is malformed rather than partially usable.
    // Without this check `"1h30"` would parse as an hour and ignore the `30`,
    // which is exactly the kind of silent misreading this module exists to stop.
    if (match.index !== consumed) return null;

    totalMs += Number(match[1]) * UNIT_MS[match[2]];
    consumed = match.index + match[0].length;
  }

  if (consumed === 0 || consumed !== rest.length) return null;

  // Rounded because the result crosses the wire as an integer millisecond count.
  // Sub-millisecond durations are meaningless for a human-gated wait anyway.
  return Math.round(sign * totalMs);
}
