import { prisma } from "../../lib/prisma.js";

// WHAT THE HOST KNOWS ABOUT ITSELF, collected by the deploy agent.
//
// None of this is reachable from inside the API container, and that is the
// whole reason it lives here rather than in systemSampler.ts:
//
//   * per-container CPU and memory need the Docker socket, which is root on the
//     host and must never be mounted into an internet-facing Express app
//   * kernel OOM kills live in dmesg, which a container cannot read
//   * the nightly backup runs on the host and writes to a bucket the API has no
//     credentials for
//   * egress is a counter on the host's own NIC
//
// The agent already runs as root, already polls, and already has a heartbeat, so
// it collects all of it and posts it on that same beat. See deploy-agent.py.
//
// EVERY FIELD IS OPTIONAL. A fact the agent could not gather is absent, never
// zero — "no OOM kills recorded" and "could not read dmesg" are different
// states, and a panel that renders the second as the first is the exact failure
// this console exists to avoid.

export interface ContainerFact {
  name: string;
  cpuPercent: number | null;
  memUsedBytes: number | null;
  memLimitBytes: number | null;
  memPercent: number | null;
  restartCount: number | null;
  /** Docker's flag. Only true for the CURRENT container — see oom below. */
  oomKilled: boolean | null;
  status: string | null;
}

export interface OomFact {
  /** Kernel timestamp, ISO. */
  at: string;
  /** The killed process's name, e.g. "node". */
  process: string;
  rssBytes: number | null;
  /**
   * Docker's own OOM flag is per-CONTAINER and resets when the container is
   * recreated, so three kills followed by a deploy leave no trace anywhere
   * except dmesg. That is precisely how 2026-08-17's kills went unnoticed.
   */
  cgroup: string | null;
}

export interface BackupFact {
  lastAt: string | null;
  lastBytes: number | null;
  /** The run before it, so a truncated dump is visible as a collapse in size. */
  previousBytes: number | null;
  count: number | null;
  bucket: string | null;
  /** Read from the cron line, so the panel can say when the next one is due. */
  scheduleUtc: string | null;
  error?: string;
}

export interface DiskFact {
  totalBytes: number | null;
  freeBytes: number | null;
  usedPercent: number | null;
  /**
   * Linear projection over the samples the agent holds. Null when the trend is
   * flat or falling — "never, at this rate" is honest and Infinity is not.
   */
  daysUntilFull: number | null;
}

export interface NetworkFact {
  interfaceName: string | null;
  rxBytes: number | null;
  txBytes: number | null;
  /** Since the previous beat, so a spike is visible without storing a series. */
  txBytesPerHour: number | null;
}

export interface TlsFact {
  host: string;
  notAfter: string | null;
  daysRemaining: number | null;
  error?: string;
}

export interface HostFacts {
  collectedAt?: string;
  containers?: ContainerFact[];
  oom?: OomFact[];
  backup?: BackupFact;
  disk?: DiskFact;
  network?: NetworkFact;
  tls?: TlsFact[];
  bootedAt?: string;
  swapUsedBytes?: number | null;
}

export interface HostReport {
  facts: HostFacts | null;
  host: string | null;
  seenAt: string | null;
  secondsAgo: number | null;
  stale: boolean;
}

/** The agent polls every 60s; three missed beats is gone, not slow. */
export const AGENT_STALE_AFTER_MS = 180_000;

export async function readHostReport(): Promise<HostReport> {
  const row = await prisma.deploymentState.findUnique({ where: { id: "singleton" } });
  const seenAt = row?.seenAt ?? null;
  const secondsAgo = seenAt === null ? null : Math.round((Date.now() - seenAt.getTime()) / 1000);
  return {
    facts: (row?.facts as HostFacts | null) ?? null,
    host: row?.host ?? null,
    seenAt: seenAt?.toISOString() ?? null,
    secondsAgo,
    stale: seenAt === null || Date.now() - seenAt.getTime() > AGENT_STALE_AFTER_MS,
  };
}
