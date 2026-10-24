// corridor plan --registry — what does the on-chain registry say about the dest anchor?
//
// `plan` reports liveness from the YAML alone: `endpoints_verified_at` set means
// VERIFIED. The AnchorRegistry holds an independent, dated observation of the
// same anchor, so the two can disagree silently. `--registry` reads that
// observation and prints it next to the manifest's claim.
//
// INFORMATIONAL ONLY. This is not the pre-settle gate — that is
// RegistryRouteResolver, wired in by `corridor canary`. A failed read here
// prints a warning and never changes the exit code.
//
// The read and the comparison are split on purpose: `fetchRegistryView` talks
// to a `RegistrySource` (the real AnchorRegistry, or a stub in tests) and
// `compareWithRegistry` is pure, so every verdict is testable offline.

import { Networks } from "@stellar/stellar-sdk";
import { liveness, protocolOf, type Corridor } from "@corridor/manifest";
import {
  AnchorRegistry,
  RegistryContractError,
  WEEK_OF_LEDGERS,
  contractErrorCode,
  type AnchorAttestation,
  type Protocol,
} from "@corridor/registry";
import deploymentsData from "../../../contracts/deployments.json";

/** Networks `--network` accepts, matching the keys of contracts/deployments.json. */
export type RegistryNetwork = "testnet" | "public";

/** Approximate ledger close time, used only to turn staleness into hours. */
const SECONDS_PER_LEDGER = 5;

/**
 * The subset of @corridor/registry this check needs. Declared structurally,
 * like `AttestationSource` in @corridor/router, so tests can pass a stub and
 * never touch the network. `AnchorRegistry` satisfies it as-is.
 */
export interface RegistrySource {
  /** Throws a contract `NotFound` when the domain has never been attested. */
  getAnchor(domain: string): Promise<AnchorAttestation>;
  serves(domain: string, protocol: Protocol): Promise<boolean>;
  staleness(domain: string): Promise<number>;
}

/** What the registry says about one anchor, as plain data. */
export type RegistryView =
  | { readonly domain: string; readonly attested: false }
  | {
      readonly domain: string;
      readonly attested: true;
      /** SEP numbers the anchor's stellar.toml advertised at attestation. */
      readonly seps: readonly number[];
      readonly attestedLedger: number;
      /** Ledgers since the attestation. */
      readonly staleness: number;
      readonly servesSep31: boolean;
      /**
       * Only asked for a SEP-6 corridor: the registry deployed on testnet
       * predates `serves_sep6`, so asking every lane would fail SEP-31 ones.
       */
      readonly servesSep6?: boolean;
    };

/** The manifest's side of the comparison. */
export interface ManifestClaim {
  /** True when liveness() calls the lane VERIFIED (or PROVEN). */
  readonly verified: boolean;
  /** The dest protocol the corridor declares. */
  readonly protocol: string;
}

/** Outcome of comparing the manifest's VERIFIED claim with the registry's view. */
export type RegistryAgreement =
  /** Both say the lane works, or both say it does not. */
  | "agree"
  /** The manifest says VERIFIED; a fresh attestation says it does not serve the protocol. */
  | "manifest-verified-registry-not-serving"
  /** A fresh attestation says it serves the protocol; the manifest does not claim VERIFIED. */
  | "registry-serving-manifest-unverified"
  /** The registry holds no observation of this domain. */
  | "never-attested"
  /** The newest observation is too old to say anything about today. */
  | "stale"
  /** The corridor's protocol is not one the registry attests (a custom adapter). */
  | "not-attestable";

export interface RegistryComparison {
  readonly agreement: RegistryAgreement;
  /** The protocol the comparison was made against, when the registry attests it. */
  readonly protocol?: Protocol;
  readonly maxStalenessLedgers: number;
}

/**
 * Read the registry's view of `domain`. SEP-31 is always asked; SEP-6 only
 * when `protocol` is `sep6`.
 *
 * A contract `NotFound` from `getAnchor` is the normal answer for a domain
 * nobody has attested and becomes `attested: false`. Every other failure is
 * rethrown: an RPC outage must surface as a warning, not as "never attested".
 */
export async function fetchRegistryView(
  source: RegistrySource,
  domain: string,
  protocol: string = "sep31",
): Promise<RegistryView> {
  let anchor: AnchorAttestation;
  try {
    anchor = await source.getAnchor(domain);
  } catch (e) {
    if (contractErrorCode(e) === RegistryContractError.NotFound) {
      return { domain, attested: false };
    }
    throw e;
  }
  const [servesSep31, servesSep6, staleness] = await Promise.all([
    source.serves(domain, "sep31"),
    protocol === "sep6" ? source.serves(domain, "sep6") : undefined,
    source.staleness(domain),
  ]);
  return {
    domain,
    attested: true,
    seps: anchor.seps,
    attestedLedger: anchor.attestedLedger,
    staleness,
    servesSep31,
    ...(servesSep6 === undefined ? {} : { servesSep6 }),
  };
}

/**
 * Compare the manifest's claim with the registry's view. Pure.
 *
 * The question asked is the one RegistryRouteResolver asks: does the anchor
 * serve THE PROTOCOL THE CORRIDOR DECLARES, attested no longer ago than
 * `maxStalenessLedgers` (the resolver's one-week default)? A stale observation
 * is reported as stale whatever it says, because it is not evidence about today.
 */
export function compareWithRegistry(
  manifest: ManifestClaim,
  view: RegistryView,
  maxStalenessLedgers: number = WEEK_OF_LEDGERS,
): RegistryComparison {
  const base = { maxStalenessLedgers };
  if (manifest.protocol !== "sep31" && manifest.protocol !== "sep6") {
    return { ...base, agreement: "not-attestable" };
  }
  const protocol: Protocol = manifest.protocol;
  if (!view.attested) return { ...base, protocol, agreement: "never-attested" };
  if (view.staleness > maxStalenessLedgers) return { ...base, protocol, agreement: "stale" };
  const serves = protocol === "sep31" ? view.servesSep31 : view.servesSep6 === true;
  if (manifest.verified && !serves) {
    return { ...base, protocol, agreement: "manifest-verified-registry-not-serving" };
  }
  if (!manifest.verified && serves) {
    return { ...base, protocol, agreement: "registry-serving-manifest-unverified" };
  }
  return { ...base, protocol, agreement: "agree" };
}

/** Ledgers as approximate hours, at ~5s per ledger. */
export function ledgersToHours(ledgers: number): string {
  const hours = (ledgers * SECONDS_PER_LEDGER) / 3600;
  return hours < 10 ? hours.toFixed(1) : String(Math.round(hours));
}

function protocolLabel(protocol: Protocol): string {
  return protocol === "sep31" ? "SEP-31" : "SEP-6";
}

function agreementLine(manifest: ManifestClaim, comparison: RegistryComparison): string {
  const p = comparison.protocol ? protocolLabel(comparison.protocol) : manifest.protocol;
  const claim = manifest.verified ? "VERIFIED" : "not VERIFIED";
  switch (comparison.agreement) {
    case "agree":
      return manifest.verified
        ? `✓ agree — manifest is VERIFIED and the registry attests ${p}`
        : `✓ agree — manifest is not VERIFIED and the registry does not attest ${p}`;
    case "manifest-verified-registry-not-serving":
      return `✗ DISAGREE — manifest is VERIFIED but the registry says the anchor does not serve ${p}`;
    case "registry-serving-manifest-unverified":
      return `? differ — the registry attests ${p} but the manifest is not VERIFIED`;
    case "never-attested":
      return `? cannot confirm — manifest is ${claim}; the registry has never attested this anchor`;
    case "stale":
      return `? cannot confirm — manifest is ${claim}; the attestation is older than ${comparison.maxStalenessLedgers} ledgers (~${ledgersToHours(comparison.maxStalenessLedgers)}h)`;
    case "not-attestable":
      return `- not comparable — the registry attests SEP-31 and SEP-6 only, this corridor is ${manifest.protocol}`;
  }
}

/** Render the registry section printed under the plan. */
export function formatRegistryCheck(check: RegistryCheck): string {
  const { view, manifest, comparison } = check;
  const lines: string[] = [];
  const line = (s: string) => lines.push(s);
  line(
    `registry: ${check.contractId} on ${check.network} (informational, not the settle gate)`,
  );
  line(`  anchor:        ${view.domain}`);
  if (!view.attested) {
    line("  attested:      never attested");
  } else {
    line(
      `  attested:      ledger ${view.attestedLedger} (${view.staleness} ledgers ago, ~${ledgersToHours(view.staleness)}h)`,
    );
    line(`  serves SEP-31: ${view.servesSep31 ? "yes" : "no"}`);
    if (view.servesSep6 !== undefined) {
      line(`  serves SEP-6:  ${view.servesSep6 ? "yes" : "no"}`);
    }
    line(`  advertises:    ${view.seps.map((n) => `SEP-${n}`).join(", ") || "none"}`);
  }
  line(`  manifest:      ${agreementLine(manifest, comparison)}`);
  return lines.join("\n");
}

/** A completed registry check, ready to print or emit as JSON. */
export interface RegistryCheck {
  readonly network: RegistryNetwork;
  readonly contractId: string;
  readonly view: RegistryView;
  readonly manifest: ManifestClaim;
  readonly comparison: RegistryComparison;
}

export type RegistryCheckResult =
  | { readonly ok: true; readonly check: RegistryCheck }
  | { readonly ok: false; readonly warning: string };

interface DeploymentConfig {
  networkPassphrase?: string;
  rpcUrl?: string;
  registry?: string | null;
}

export interface RegistryCheckOptions {
  /** Supply the source directly (tests); otherwise an AnchorRegistry is built. */
  readonly source?: RegistrySource;
  /** Override contracts/deployments.json (tests). */
  readonly deployments?: Readonly<Record<string, DeploymentConfig>>;
}

/**
 * Run the whole check for a corridor's dest anchor. Never throws: anything that
 * goes wrong — no registry on that network, an RPC failure — comes back as a
 * warning, so the caller can print it and keep the plan's exit code.
 *
 * Addresses come from contracts/deployments.json, like examples/read-registry.ts,
 * with the same SOROBAN_RPC_URL / REGISTRY_CONTRACT_ID overrides `canary` honours.
 */
export async function runRegistryCheck(
  c: Corridor,
  network: RegistryNetwork,
  opts: RegistryCheckOptions = {},
): Promise<RegistryCheckResult> {
  const deployments =
    opts.deployments ?? (deploymentsData as Record<string, DeploymentConfig>);
  const cfg = deployments[network];
  const contractId = process.env.REGISTRY_CONTRACT_ID || cfg?.registry;
  if (!contractId) {
    return {
      ok: false,
      warning: `no registry deployed on ${network} (see contracts/deployments.json)`,
    };
  }
  const live = liveness(c);
  const manifest: ManifestClaim = { verified: live.runnable, protocol: protocolOf(c.dest) };
  try {
    const source =
      opts.source ??
      new AnchorRegistry({
        rpcUrl:
          process.env.SOROBAN_RPC_URL || cfg?.rpcUrl || "https://soroban-testnet.stellar.org",
        contractId,
        networkPassphrase:
          cfg?.networkPassphrase ??
          (network === "public" ? Networks.PUBLIC : Networks.TESTNET),
      });
    const view = await fetchRegistryView(
      source,
      c.dest.endpoints.home_domain,
      manifest.protocol,
    );
    return {
      ok: true,
      check: {
        network,
        contractId,
        view,
        manifest,
        comparison: compareWithRegistry(manifest, view),
      },
    };
  } catch (e) {
    return {
      ok: false,
      // First line only: a simulation failure carries the whole diagnostic
      // event log after it, which buries the warning under the plan.
      warning: `registry check failed: ${(e instanceof Error ? e.message : String(e)).split("\n")[0]}`,
    };
  }
}
