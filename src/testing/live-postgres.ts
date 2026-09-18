import pg from "pg";

/**
 * Whether a **real** Postgres is reachable, and — when it is not — an honest
 * account of why, for the handful of test files that verify against one.
 *
 * **Why these files exist at all.** Several bugs in this codebase were invisible
 * to a green suite because every other test uses a fake pool that records SQL and
 * returns canned rows. A fake pool has no opinion on whether Postgres *accepts* a
 * statement, which is how #43 (a repository method that threw on every call),
 * #61 (an audit query that 500'd on every request) and #56 (four endpoints
 * registered at unreachable paths) each shipped behind a suite that passed. So
 * the cases in those files execute the real thing, and are **never mocked** — a
 * mock would agree with the code by construction, which is the exact mistake
 * being guarded against.
 *
 * **Why a shared probe rather than five copies.** These files are individual, but
 * the *diagnosis* should not be: it was copy-pasted five times and each copy
 * explained an unreachable database the same wrong way. Two agents went on to
 * report that "the sandbox cannot route to Postgres", which was not true and cost
 * real time — so the explanation now lives in one place and describes the failure
 * that actually happens.
 *
 * **The failure that actually happens.** Docker allocates bridge subnets from
 * `172.17.0.0/16` upwards. A host running a VPN mesh (Netbird, Tailscale, and
 * similar) often claims overlapping private ranges or installs routing rules for
 * them, and a compose test network that lands in one of those ranges accepts a
 * connection from *within* its own container and silently drops it from any
 * sibling. The symptom is a connection **timeout**, not a refusal, which reads
 * like a misconfigured database rather than a routing collision.
 *
 * Verified on this project's development host: `172.20–172.23` were unreachable
 * between sibling containers while `172.18`, `172.24` and `10.99` worked, with
 * `wt0` (Netbird) up and `/etc/resolv.conf` carrying `search netbird.selfhosted`.
 * `pg_isready` is not enough to detect this: without `-h` it only proves the unix
 * socket inside the container, so a container can report "accepting connections"
 * while no sibling can reach it.
 */

export interface LiveProbe {
  ok: boolean;
  /** The raw driver message, shown as-is when nothing more specific applies. */
  detail: string;
  /**
   * A likely cause and what to do about it, or null when the message speaks for
   * itself. Deliberately a *hypothesis* and worded as one — the probe knows the
   * shape of the failure and the address, not the host's routing table.
   */
  hint: string | null;
}

/** Hosts Docker itself owns, whose unreachability is almost always a collision. */
const DOCKER_RANGE = /^172\.(1[6-9]|2\d|3[01])\./;

function hostOf(connectionString: string): string | null {
  try {
    return new URL(connectionString).hostname;
  } catch {
    return null;
  }
}

/** Timed out, as opposed to refused or rejected — the collision's signature. */
function isTimeout(detail: string): boolean {
  return /timeout|ETIMEDOUT|Connection terminated due to connection timeout/i.test(detail);
}

function hintFor(detail: string, connectionString: string): string | null {
  if (!isTimeout(detail)) return null;

  const host = hostOf(connectionString);
  const looksLikeDockerRange = host !== null && DOCKER_RANGE.test(host);

  return (
    "A connection *timeout* to a Docker-allocated address usually means the " +
    "subnet is shadowed on the host rather than the database being misconfigured. " +
    "Docker allocates from 172.17.0.0/16 upwards, and a VPN mesh (Netbird, " +
    "Tailscale, ...) commonly claims overlapping private ranges or installs " +
    "routing rules for them — in which case a compose network that lands in one " +
    "of those ranges is reachable from inside its own container and not from any " +
    "sibling." +
    (looksLikeDockerRange
      ? `\n  The address in DATABASE_URL (${host}) is in Docker's own range, which fits that.`
      : "") +
    "\n  To check: compare `ip route | grep 172.` in use against `docker network ls`. " +
    "Note that `pg_isready` with no -h only proves the unix socket inside the " +
    "container, so it can report 'accepting connections' while nothing can reach it." +
    "\n  To verify anyway without changing the compose files, run the suite " +
    "against a database outside the colliding range — e.g. this project's dev " +
    "Postgres (`localhost:5432`) via `--network host`."
  );
}

export async function probeLivePostgres(
  connectionString: string = process.env.DATABASE_URL ?? "",
): Promise<LiveProbe> {
  if (!connectionString) {
    return { ok: false, detail: "DATABASE_URL is unset", hint: null };
  }

  const probe = new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000 });
  try {
    await probe.query("SELECT 1");
    return { ok: true, detail: "reachable", hint: null };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, detail, hint: hintFor(detail, connectionString) };
  } finally {
    await probe.end().catch(() => undefined);
  }
}

/**
 * The skip banner. A shared shape so every file's warning is equally loud and
 * equally specific about *what* went unverified — the per-file part, and the
 * reason the message is not shared whole.
 *
 * Skipping loudly is deliberate rather than incidental: a silent skip would make
 * "the suite is green" mean less than it appears to, which is the failure mode
 * this whole family of files exists to avoid.
 */
export function livePostgresSkipWarning(input: {
  /** Short tag for the warning, e.g. "audit". */
  label: string;
  probe: LiveProbe;
  /** The specific behaviour that is therefore unverified, in one sentence. */
  unverified: string;
  /** The standalone script that verifies the same thing, if there is one. */
  standalone?: string;
}): string {
  const lines = [
    `\n[${input.label}] SKIPPING the live Postgres cases: ${input.probe.detail}.`,
    `  Unverified in this run: ${input.unverified}`,
    "  They are not mocked on purpose — a fake pool agrees with the code by",
    "  construction, which is the mistake these cases exist to catch.",
  ];

  if (input.probe.hint) {
    lines.push("", `  Likely cause: ${input.probe.hint}`);
  } else {
    lines.push(
      "  To verify for real, provide a reachable DATABASE_URL and run",
      "  `docker compose -f docker-compose.test.yml up --build",
      "   --abort-on-container-exit --exit-code-from test`.",
    );
  }

  if (input.standalone) {
    lines.push("", `  Standalone check: ${input.standalone}`);
  }

  return `${lines.join("\n")}\n`;
}
