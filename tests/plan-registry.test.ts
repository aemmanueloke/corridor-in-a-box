import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadCorridor, type Corridor } from "@corridor/manifest";
import type { AnchorAttestation, Protocol } from "@corridor/registry";
import {
  compareWithRegistry,
  fetchRegistryView,
  formatRegistryCheck,
  ledgersToHours,
  runRegistryCheck,
  type ManifestClaim,
  type RegistrySource,
  type RegistryView,
} from "../packages/cli/src/plan-registry";
import { parsePlanArgs } from "../packages/cli/src/plan";

// `corridor plan --registry` (#255). Every case here runs offline: the registry
// is a stub, and the one CLI case uses a network with no registry deployed, so
// it stops before building an RPC client.

const WEEK = 120_960;
const NOT_FOUND = new Error("registry.get_anchor failed: HostError: Error(Contract, #6)");

function corridor(path: string): Corridor {
  const loaded = loadCorridor(path);
  if (!loaded.ok) throw new Error(`fixture ${path} failed to load: ${loaded.error.message}`);
  return loaded.value;
}

function attested(
  over: Partial<Extract<RegistryView, { attested: true }>> = {},
): RegistryView {
  return {
    domain: "anchor.example",
    attested: true,
    seps: [1, 10, 12, 31, 38],
    attestedLedger: 1_000_000,
    staleness: 720,
    servesSep31: true,
    ...over,
  };
}

const VERIFIED_SEP31: ManifestClaim = { verified: true, protocol: "sep31" };

/** A registry that answers from fixed data and records every domain it is asked about. */
function stubRegistry(
  record: AnchorAttestation | Error,
  answers: { sep31?: boolean; sep6?: boolean; staleness?: number } = {},
): RegistrySource & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    async getAnchor(domain: string) {
      asked.push(domain);
      if (record instanceof Error) throw record;
      return record;
    },
    async serves(_domain: string, protocol: Protocol) {
      return protocol === "sep31" ? (answers.sep31 ?? false) : (answers.sep6 ?? false);
    },
    async staleness() {
      return answers.staleness ?? 0;
    },
  };
}

function record(domain: string): AnchorAttestation {
  return {
    domain,
    seps: [1, 10, 31],
    probesRun: ["toml_fetch", "sep31_info"],
    probesPassed: ["toml_fetch", "sep31_info"],
    tomlHash: "ab".repeat(32),
    attestedLedger: 4_242,
    attester: "GATTESTER",
  };
}

describe("compareWithRegistry", () => {
  it("agrees when the manifest is VERIFIED and a fresh attestation serves the protocol", () => {
    expect(compareWithRegistry(VERIFIED_SEP31, attested()).agreement).toBe("agree");
  });

  it("flags a VERIFIED manifest whose anchor the registry says does not serve SEP-31", () => {
    const view = attested({ servesSep31: false });
    expect(compareWithRegistry(VERIFIED_SEP31, view)).toEqual({
      agreement: "manifest-verified-registry-not-serving",
      protocol: "sep31",
      maxStalenessLedgers: WEEK,
    });
  });

  it("reports never attested rather than agreeing or disagreeing", () => {
    const view: RegistryView = { domain: "anchor.example", attested: false };
    expect(compareWithRegistry(VERIFIED_SEP31, view).agreement).toBe("never-attested");
    expect(compareWithRegistry({ ...VERIFIED_SEP31, verified: false }, view).agreement).toBe(
      "never-attested",
    );
  });

  it("reports a stale attestation as stale whatever it says", () => {
    expect(
      compareWithRegistry(VERIFIED_SEP31, attested({ staleness: WEEK + 1 })).agreement,
    ).toBe("stale");
    expect(
      compareWithRegistry(
        VERIFIED_SEP31,
        attested({ staleness: WEEK + 1, servesSep31: false }),
      ).agreement,
    ).toBe("stale");
    // At the threshold exactly it is still fresh, as in RegistryRouteResolver.
    expect(compareWithRegistry(VERIFIED_SEP31, attested({ staleness: WEEK })).agreement).toBe(
      "agree",
    );
    expect(
      compareWithRegistry(VERIFIED_SEP31, attested({ staleness: 100 }), 50).agreement,
    ).toBe("stale");
  });

  it("asks about the protocol the corridor declares, so a SEP-6 lane is not judged on SEP-31", () => {
    const view = attested({ servesSep31: false, servesSep6: true });
    expect(compareWithRegistry({ verified: true, protocol: "sep6" }, view)).toMatchObject({
      agreement: "agree",
      protocol: "sep6",
    });
  });

  it("notes when the registry attests a lane the manifest does not claim", () => {
    const claim = { verified: false, protocol: "sep31" };
    expect(compareWithRegistry(claim, attested()).agreement).toBe(
      "registry-serving-manifest-unverified",
    );
    expect(compareWithRegistry(claim, attested({ servesSep31: false })).agreement).toBe(
      "agree",
    );
  });

  it("does not compare a custom protocol the registry cannot attest", () => {
    const claim = { verified: true, protocol: "custom:bank-wire" };
    expect(compareWithRegistry(claim, attested()).agreement).toBe("not-attestable");
  });
});

describe("fetchRegistryView", () => {
  it("turns a contract NotFound into never attested", async () => {
    const view = await fetchRegistryView(stubRegistry(NOT_FOUND), "nobody.example");
    expect(view).toEqual({ domain: "nobody.example", attested: false });
  });

  it("rethrows any other failure so an outage is never read as never attested", async () => {
    const source = stubRegistry(new Error("fetch failed: ECONNREFUSED"));
    await expect(fetchRegistryView(source, "anchor.example")).rejects.toThrow("ECONNREFUSED");
  });

  it("collects the attestation, the SEP-31 answer and the staleness", async () => {
    const source = stubRegistry(record("anchor.example"), { sep31: true, staleness: 360 });
    expect(await fetchRegistryView(source, "anchor.example")).toEqual({
      domain: "anchor.example",
      attested: true,
      seps: [1, 10, 31],
      attestedLedger: 4_242,
      staleness: 360,
      servesSep31: true,
    });
  });

  it("asks about SEP-6 only for a SEP-6 corridor", async () => {
    const source = stubRegistry(record("anchor.example"), { sep6: true });
    const asked: Protocol[] = [];
    const serves = source.serves.bind(source);
    source.serves = async (domain, protocol) => {
      asked.push(protocol);
      return serves(domain, protocol);
    };
    await fetchRegistryView(source, "anchor.example", "sep31");
    expect(asked).toEqual(["sep31"]);
    asked.length = 0;
    const view = await fetchRegistryView(source, "anchor.example", "sep6");
    expect(asked.sort()).toEqual(["sep31", "sep6"]);
    expect(view).toMatchObject({ servesSep31: false, servesSep6: true });
  });
});

describe("runRegistryCheck", () => {
  afterEach(() => vi.unstubAllEnvs());

  const deployments = {
    testnet: {
      networkPassphrase: "Test SDF Network ; September 2015",
      rpcUrl: "https://rpc.invalid",
      registry: "CREGISTRY",
    },
    public: { registry: null },
  };

  it("queries the manifest's dest home_domain and compares it with the VERIFIED claim", async () => {
    vi.stubEnv("REGISTRY_CONTRACT_ID", "");
    const c = corridor("tests/fixtures/verified.corridor.yaml");
    const source = stubRegistry(record(c.dest.endpoints.home_domain), {
      sep31: false,
      staleness: 10,
    });
    const result = await runRegistryCheck(c, "testnet", { source, deployments });
    expect(source.asked).toEqual([c.dest.endpoints.home_domain]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.check.contractId).toBe("CREGISTRY");
    expect(result.check.manifest).toEqual({ verified: true, protocol: "sep31" });
    expect(result.check.comparison.agreement).toBe("manifest-verified-registry-not-serving");
  });

  it("warns, without reading anything, when no registry is deployed on the network", async () => {
    vi.stubEnv("REGISTRY_CONTRACT_ID", "");
    const source = stubRegistry(record("x"));
    const c = corridor("tests/fixtures/verified.corridor.yaml");
    const result = await runRegistryCheck(c, "public", { source, deployments });
    expect(result).toEqual({
      ok: false,
      warning: "no registry deployed on public (see contracts/deployments.json)",
    });
    expect(source.asked).toEqual([]);
  });

  it("turns a network error into a one-line warning instead of throwing", async () => {
    vi.stubEnv("REGISTRY_CONTRACT_ID", "");
    const c = corridor("tests/fixtures/verified.corridor.yaml");
    const source = stubRegistry(new Error("fetch failed: ETIMEDOUT\n\nEvent log:\n  0: ..."));
    const result = await runRegistryCheck(c, "testnet", { source, deployments });
    expect(result).toEqual({
      ok: false,
      warning: "registry check failed: fetch failed: ETIMEDOUT",
    });
  });
});

describe("formatRegistryCheck", () => {
  const base = {
    network: "testnet" as const,
    contractId: "CREGISTRY",
    manifest: VERIFIED_SEP31,
  };

  it("prints attestation, serves, staleness in ledgers and hours, SEPs and the verdict", () => {
    const view = attested({ servesSep31: false });
    const out = formatRegistryCheck({
      ...base,
      view,
      comparison: compareWithRegistry(VERIFIED_SEP31, view),
    });
    expect(out).toContain("registry: CREGISTRY on testnet");
    expect(out).toContain("anchor:        anchor.example");
    expect(out).toContain("attested:      ledger 1000000 (720 ledgers ago, ~1.0h)");
    expect(out).toContain("serves SEP-31: no");
    expect(out).not.toContain("serves SEP-6");
    expect(out).toContain("advertises:    SEP-1, SEP-10, SEP-12, SEP-31, SEP-38");
    expect(out).toContain("✗ DISAGREE — manifest is VERIFIED but the registry says");
  });

  it("says never attested and prints no registry facts it does not have", () => {
    const view: RegistryView = { domain: "anchor.example", attested: false };
    const out = formatRegistryCheck({
      ...base,
      view,
      comparison: compareWithRegistry(VERIFIED_SEP31, view),
    });
    expect(out).toContain("attested:      never attested");
    expect(out).not.toContain("serves SEP-31");
    expect(out).toContain("the registry has never attested this anchor");
  });

  it("converts ledgers to approximate hours at 5s per ledger", () => {
    expect(ledgersToHours(0)).toBe("0.0");
    expect(ledgersToHours(720)).toBe("1.0");
    expect(ledgersToHours(WEEK)).toBe("168");
  });
});

describe("parsePlanArgs --registry", () => {
  it("is off by default, so plain plan stays offline", () => {
    expect(parsePlanArgs(["a.yaml"])).toEqual({
      ok: true,
      file: "a.yaml",
      json: false,
      registry: false,
      network: "testnet",
    });
  });

  it("accepts --registry with an optional --network", () => {
    expect(parsePlanArgs(["a.yaml", "--registry"])).toMatchObject({
      ok: true,
      registry: true,
      network: "testnet",
    });
    expect(parsePlanArgs(["--registry", "--network", "public", "a.yaml", "--json"])).toEqual({
      ok: true,
      file: "a.yaml",
      json: true,
      registry: true,
      network: "public",
    });
  });

  it("refuses an unknown network, a missing value, and --network without --registry", () => {
    expect(parsePlanArgs(["a.yaml", "--registry", "--network", "futurenet"])).toEqual({
      ok: false,
      error: "error: --network must be testnet or public",
    });
    expect(parsePlanArgs(["a.yaml", "--registry", "--network"]).ok).toBe(false);
    expect(parsePlanArgs(["a.yaml", "--network", "testnet"])).toEqual({
      ok: false,
      error: "error: --network only applies with --registry",
    });
  });
});

describe("corridor plan --registry (CLI)", () => {
  const TSX_CLI = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const CLI = fileURLToPath(new URL("../packages/cli/src/index.ts", import.meta.url));
  const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

  it("prints the plan, warns, and keeps exit 0 when the registry cannot be read", () => {
    // `public` has no registry in contracts/deployments.json, so this never
    // reaches an RPC endpoint.
    const r = spawnSync(
      process.execPath,
      [
        TSX_CLI,
        CLI,
        "plan",
        "tests/fixtures/verified.corridor.yaml",
        "--registry",
        "--network",
        "public",
      ],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: "", REGISTRY_CONTRACT_ID: "" },
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("liveness: ✓ VERIFIED");
    expect(r.stdout).not.toContain("registry:");
    expect(r.stderr).toContain("! no registry deployed on public");
  });
});
