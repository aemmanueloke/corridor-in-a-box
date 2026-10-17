import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryIdempotencyStore } from "@corridor/engine";
import type { BreakerRecord, RunResult, SettlementRequest } from "@corridor/engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liveness, loadCorridor, type Corridor } from "@corridor/manifest";
import { ok } from "@corridor/types";
import type { SettlementFacts } from "@corridor/stellar";
import { finalizeCanary, type PaymentVerifier } from "../packages/cli/src/proof";
import {
  listHeldRuns,
  parseListArgs,
  parseResolveArgs,
  resolveHeldRun,
} from "../packages/cli/src/runs";
import {
  currentUser,
  formatBreakerRecord,
  formatBreakerReset,
  formatBreakerTable,
  parseBreakerArgs,
} from "../packages/cli/src/breaker";

// packages/cli/src/index.ts calls process.exit(main(...)) at module top level
// and has no vitest path alias, so importing it directly would kill the test
// worker. Spawn it as a child process instead — also a more honest way to
// test a CLI's actual argv/exit-code/stdio contract. Everything that does not
// need a process (argument parsing, rendering) lives in packages/cli/src/breaker
// and is imported directly below, because the interesting properties of those
// are types and strings, not exit codes.

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
// Spawn `node node_modules/tsx/dist/cli.mjs` rather than `node_modules/.bin/tsx`.
// The `.bin` entry is a shell script (`tsx` / `tsx.cmd`) that cannot be spawned
// directly on Windows without a shell, which made every case in this file fail
// there with a null exit status. Going through the current interpreter and the
// bin target tsx itself declares is portable and needs no shell.
const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const CLI = fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url));

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [TSX_CLI, CLI, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    // `process.env` minus DATABASE_URL by default: these cases must never
    // depend on whether the developer running them has one exported, and a test
    // that silently talks to a real database is worse than no test.
    env: { ...process.env, DATABASE_URL: "", ...env },
  });
}

// `currentUser` reads the OS account, and the interesting half of that is the
// fallback chain, which only runs when the OS lookup fails — as it does in a
// distroless container with no passwd entry for the running uid. That cannot be
// provoked from this box, where userInfo() always succeeds, so it is stubbed.
// Default state is "the real lookup succeeded", which is the production path.
const osUser = vi.hoisted(() => ({
  mode: "real" as "real" | "throw" | "empty",
  value: "ada",
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    userInfo: () => {
      if (osUser.mode === "throw") {
        throw new Error("uv_os_get_passwd failed: no entry for this uid");
      }
      return { ...actual.userInfo(), username: osUser.mode === "empty" ? "" : osUser.value };
    },
  };
});

afterEach(() => {
  osUser.mode = "real";
  osUser.value = "ada";
});

function completedCanary(corridor: Corridor) {
  const result: RunResult = {
    idempotencyKey: "canary-test",
    state: "completed",
    transactionId: "anchor-tx-1",
    stellarTyHash: "a".repeat(64),
    trail: ["created", "completed"],
  };
  const settlement: SettlementRequest = {
    to: "GDestination",
    memo: "memo-1",
    memoType: "text",
    amount: { asset: corridor.settlement.bridge_asset, amount: "1.00" },
    corridor,
  };
  return { result, settlement };
}

/** Horizon facts that exactly match what `completedCanary` submitted. */
function matchingFacts(hash: string): SettlementFacts {
  return {
    hash,
    successful: true,
    memo: "memo-1",
    memoType: "text",
    operations: [
      {
        type: "payment",
        to: "GDESTINATION",
        amount: "1.0000000",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GBBD47IF6LW77P7MDEVSCWR7DPWUV3NY3DTQEVFL4NAT4AQH3bLFLA5",
      },
    ],
  };
}

const verifier: PaymentVerifier = {
  settlementFacts: async (hash) => ok(matchingFacts(hash)),
};

/** A throwaway copy of the comment-carrying fixture; --write mutates in place. */
function fixtureCopy(): string {
  const directory = mkdtempSync(join(tmpdir(), "corridor-canary-"));
  const manifestPath = join(directory, "verified.corridor.yaml");
  copyFileSync(join(REPO_ROOT, "tests/fixtures/verified.corridor.yaml"), manifestPath);
  return manifestPath;
}

describe("corridor CLI", () => {
  it("requires held state for run listing", () => {
    const r = run(["runs", "list", "--state", "completed"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("corridor runs list --state held");
  });

  it("requires an outcome and note to resolve a run", () => {
    const r = run(["resolve", "some-key"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--outcome");
  });

  it("requires DATABASE_URL for run listing", () => {
    const r = run(["runs", "list", "--state", "held"], { DATABASE_URL: "" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("DATABASE_URL is required");
  });

  it("prints usage and exits 2 with no args", () => {
    const r = run([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: corridor <validate|plan|canary>");
  });

  it("exits 2 on an unknown subcommand", () => {
    const r = run(["frobnicate"]);
    expect(r.status).toBe(2);
  });

  it("prints usage and exits 2 when the file arg is missing", () => {
    const r = run(["validate"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage: corridor validate");
  });

  it("validate: exits 0 for a valid manifest", () => {
    const r = run(["validate", "corridors/reference.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('id="reference-testnet"');
  });

  it("validate: exits 1 for a structurally invalid manifest", () => {
    const r = run(["validate", "tests/fixtures/invalid.corridor.yaml"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MANIFEST_INVALID");
    expect(r.stderr).toContain("source");
  });

  it("validate: exits 1 for a nonexistent path", () => {
    const r = run(["validate", "corridors/does-not-exist.yaml"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read or parse");
  });

  // Liveness has three states. The distinction that matters: a corridor whose
  // endpoints are merely PRESENT must never be reported as runnable — that is
  // how tooling ends up certifying a lane nobody has checked.

  it("plan: reports VERIFIED with proof: none when endpoints_verified_at is set without proof", () => {
    const r = run( ["plan", "tests/fixtures/verified.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    expect(r.stdout).toContain("2026-01-01");
    expect(r.stdout).toContain("proof:    none — amounts capped at default");
  });

  it("plan: reports PROVEN with canary hash and completion age for proven lane", () => {
    const r = run(["plan", "tests/fixtures/proven.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓✓ PROVEN");
    expect(r.stdout).toContain("canary a1b2c3d4 completed 2026-09-20");
    expect(r.stdout).toContain("days ago, expires in");
  });

  it("plan: reports VERIFIED with warning when proof is stale", () => {
    const r = run(["plan", "tests/fixtures/stale-proof.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    // A stale proof exists, so the plan must not claim there is none.
    expect(r.stdout).toContain("proof:    not current — canary a1b2c3d4 completed 2025-01-01");
    expect(r.stdout).not.toContain("proof:    none");
    expect(r.stdout).toContain("liveness warnings:");
    expect(r.stdout).toContain("proof is stale");
  });

  it("plan: reports UNVERIFIED for a fully-specified but unchecked corridor", () => {
    const r = run(["plan", "corridors/reference.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ? UNVERIFIED");
    expect(r.stdout).toContain("NOT runnable");
    // Regression guard for the claim that got the project rejected: a corridor
    // with unconfirmed endpoints must never carry the green marker.
    expect(r.stdout).not.toContain("✓ VERIFIED");
    expect(r.stdout).not.toContain("✓✓ PROVEN");
  });

  it("plan: never reports a placeholder-endpoint corridor as runnable", () => {
    const r = run(["plan", "corridors/mZ-example.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("UNVERIFIED");
    expect(r.stdout).not.toContain("✓ VERIFIED");
    expect(r.stdout).not.toContain("✓✓ PROVEN");
  });

  it("plan: reports all three liveness warnings for a corridor missing dest endpoints", () => {
    const r = run(["plan", "corridors/ng-cn.corridor.yaml"]);
    expect(r.status).toBe(0); // warnings don't fail the command
    expect(r.stdout).toContain("NOT RUNNABLE");
    expect(r.stdout).toContain("quotes will fail");
    expect(r.stdout).toContain("no per-customer KYC");
  });

  it("plan: reports VERIFIED for ng-cowrie", () => {
    const r = run(["plan", "corridors/ng-cowrie.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    expect(r.stdout).toContain("2026-08-11");
  });

  it("plan: ng-cowrie does not claim SEP-38 or all five steps", () => {
    const r = run(["plan", "corridors/ng-cowrie.corridor.yaml"]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("SEP-38");
    expect(r.stdout).not.toContain("all five steps");
    expect(r.stdout).toContain("external");
  });

  it("plan: prints the status_note when present", () => {
    const r = run(["plan", "corridors/ng-cn.corridor.yaml"]);
    expect(r.stdout).toContain("PENDING");
  });

  it("canary: requires an explicit amount", () => {
    const r = run(["canary", "tests/fixtures/verified.corridor.yaml"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--amount");
  });

  it("canary --write preserves comments and records a re-parsable PROVEN proof", async () => {
    const manifestPath = fixtureCopy();
    const loaded = loadCorridor(manifestPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const canary = completedCanary(loaded.value);
    const finalized = await finalizeCanary({
      ...canary,
      corridor: loaded.value,
      verifier,
      manifestPath,
      write: true,
      now: new Date("2026-01-01T12:00:00.000Z"),
    });
    expect(finalized.ok).toBe(true);
    if (!finalized.ok) return;

    const written = readFileSync(manifestPath, "utf8");
    // Every hand-written comment in the fixture survives the rewrite.
    expect(written).toContain("# Fixture: a corridor whose dest endpoints carry");
    expect(written).toContain("# anchor's data or live network reachability.");
    expect(written).toContain("proof:");
    expect(written).toContain("canary_completed_at: \"2026-01-01\"");
    expect(written).toContain(`stellar_tx_hash: ${"a".repeat(64)}`);

    const reparsed = loadCorridor(manifestPath);
    expect(reparsed.ok).toBe(true);
    if (reparsed.ok) {
      expect(liveness(reparsed.value, new Date("2026-01-01T12:00:00.000Z")).state).toBe(
        "proven",
      );
    }
  });

  it("canary --write refreshes the existing proof instead of appending a second block", async () => {
    const manifestPath = fixtureCopy();
    const loaded = loadCorridor(manifestPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const canary = completedCanary(loaded.value);
    const first = await finalizeCanary({
      ...canary,
      corridor: loaded.value,
      verifier,
      manifestPath,
      write: true,
      now: new Date("2026-01-01T12:00:00.000Z"),
    });
    expect(first.ok).toBe(true);

    const second = await finalizeCanary({
      ...canary,
      corridor: loaded.value,
      verifier,
      manifestPath,
      write: true,
      now: new Date("2026-01-02T12:00:00.000Z"),
    });
    expect(second.ok).toBe(true);

    const written = readFileSync(manifestPath, "utf8");
    const proofBlocks = written.match(/^proof:\s*$/gm) ?? [];
    expect(proofBlocks.length).toBe(1);
    expect(written).toContain('canary_completed_at: "2026-01-02"');
  });

  it("canary --write does not write without --write", async () => {
    const manifestPath = fixtureCopy();
    const before = readFileSync(manifestPath, "utf8");
    const loaded = loadCorridor(manifestPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const canary = completedCanary(loaded.value);
    const finalized = await finalizeCanary({
      ...canary,
      corridor: loaded.value,
      verifier,
      manifestPath,
      write: false,
      now: new Date("2026-01-01T12:00:00.000Z"),
    });
    expect(finalized.ok).toBe(true);
    expect(readFileSync(manifestPath, "utf8")).toBe(before);
  });

  it("canary --write rejects a settlement that does not match Horizon", async () => {
    const manifestPath = fixtureCopy();
    const loaded = loadCorridor(manifestPath);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const canary = completedCanary(loaded.value);
    const finalized = await finalizeCanary({
      ...canary,
      corridor: loaded.value,
      verifier: {
        settlementFacts: async (hash) => {
          const facts = matchingFacts(hash);
          return ok({ ...facts, memo: "different-memo" });
        },
      },
      manifestPath,
      write: true,
      now: new Date("2026-01-01T12:00:00.000Z"),
    });
    expect(finalized.ok).toBe(false);
  });
});

describe("runs argument parsing", () => {
  it("parses a held state", () => {
    const parsed = parseListArgs(["runs", "list", "--state", "held"]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.state).toBe("held");
  });

 it("rejects a non-held state", () => {
    const parsed = parseListArgs(["runs", "list", "--state", "completed"]);
    expect(parsed.ok).toBe(false);
  });

  it("parses a resolve key, outcome and note", () => {
    const parsed = parseResolveArgs([
      "resolve",
      "abc",
      "--outcome",
      "rejected",
      "--note",
      "no funds",
    ]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.key).toBe("abc");
      expect(parsed.value.outcome).toBe("rejected");
      expect(parsed.value.note).toBe("no funds");
    }
  });

  it("rejects a resolve without an outcome", () => {
    const parsed = parseResolveArgs(["resolve", "abc"]);
    expect(parsed.ok).toBe(false);
  });
});

describe("runs listing", () => {
  it("returns an empty list when the store has no held records", async () => {
    const store = new InMemoryIdempotencyStore();
    const result = await listHeldRuns(store);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });
});

describe("resolveHeadRun", () => {
  it("reports a missing key as an error", async () => {
    const store = new InMemoryIdempotencyStore();
    const result = await resolveHeldRun(store, {
      key: "missing",
      outcome: "released",
      note: "not found",
    });
    expect(result.ok).toBe(false);
  });
});

describe("breaker rendering", () => {
  const record: BreakerRecord = {
    corridorId: "ng-cowrie",
    state: "open",
    openedAt: new Date("2026-01-01T00:00:00.000Z"),
    reason: "three consecutive failures",
    failures: 3,
  };

  it("formats a single breaker record", () => {
    const text = formatBreakerRecord(record);
    expect(text).toContain("ng-cowrie");
    expect(text).toContain("open");
  });

 it("formats an empty breaker table", () => {
    const text = formatBreakerTable([]);
    expect(text).toContain("no breakers");
  });

  it("formats a breaker table with records", () => {
    const text = formatBreakerTable([record]);
    expect(text).toContain("ng-cowrie");
  });

 it("formats a breaker reset", () => {
    const text = formatBreakerReset("ng-cowrie");
    expect(text).toContain("ng-cowrie");
  });

  it("parses breaker args", () => {
    const parsed = parseBreakerArgs(["breaker", "show", "ng-cowrie"]);
    expect(parsed.ok).toBe(true);
  });

 it("falls back to a placeholder user when the OS lookup throws", () => {
    osUser.mode = "throw";
    expect(currentUser()).toBe("unknown");
  });

  it("falls back to a placeholder user when the OS lookup is empty", () => {
    osUser.mode = "empty";
    expect(currentUser()).toBe("unknown");
  });

  it("returns the real OS user when the lookup succeeds", () => {
    expect(currentUser()).toBe("ada");
  });
});
