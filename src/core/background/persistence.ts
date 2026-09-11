/**
 * Phase 76A.10 — Background Job Persistence
 *
 * Jobs are persisted as one snapshot file so a restarted process never reports
 * a stale `running` job: on load, anything that was pending, queued or running
 * in a previous process is marked interrupted. We deliberately do NOT fake a
 * resume — a child agent turn cannot be replayed from a lifecycle record, and
 * claiming otherwise would be exactly the "fake success" the agent core forbids.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getSessionsDir } from "../../lib/sessionPersistence";
import type { BackgroundJob, BackgroundJobStatus } from "./types";

/** Sibling of the sessions directory — never inside it (that dir is scanned). */
export function getBackgroundJobsPath(): string {
  if (process.env.TOOLNETCLI_BACKGROUND_JOBS_FILE) {
    return process.env.TOOLNETCLI_BACKGROUND_JOBS_FILE;
  }
  // A test run must never write to the user's real state directory. Same policy
  // as sandbox-mode persistence, which also short-circuits under NODE_ENV=test.
  if (process.env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), `toolnet-background-jobs-${process.pid}.json`);
  }
  return path.join(path.resolve(getSessionsDir(), ".."), "background-jobs.json");
}

export interface PersistedJobsFile {
  version: number;
  savedAt: number;
  jobs: BackgroundJob[];
}

const FILE_VERSION = 1;

/** Statuses that cannot be trusted after a process restart. */
const INTERRUPTED_STATUSES: BackgroundJobStatus[] = ["pending", "queued", "running"];

/**
 * Mark jobs that did not survive a restart. Pure so it can be unit-tested
 * without touching the filesystem.
 */
export function recoverInterruptedJobs(jobs: BackgroundJob[], now = Date.now()): BackgroundJob[] {
  return jobs.map((job) => {
    if (!INTERRUPTED_STATUSES.includes(job.status)) return job;
    return {
      ...job,
      status: "error" as BackgroundJobStatus,
      completedAt: job.completedAt ?? now,
      error: `Interrupted: the ToolNet process exited while this job was ${job.status}.`,
      errorKind: "runtime" as const,
      metadata: { ...(job.metadata ?? {}), interrupted: true },
    };
  });
}

/**
 * Read persisted jobs. Returns `[]` for a missing/corrupt file — persistence
 * must never be the reason a run fails.
 */
export function loadPersistedJobs(filePath = getBackgroundJobsPath()): {
  jobs: BackgroundJob[];
  recovered: number;
} {
  try {
    if (!fs.existsSync(filePath)) return { jobs: [], recovered: 0 };

    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as PersistedJobsFile;
    if (!parsed || !Array.isArray(parsed.jobs)) return { jobs: [], recovered: 0 };

    const jobs = recoverInterruptedJobs(parsed.jobs);
    const recovered = jobs.filter((job) => job.metadata?.interrupted === true).length;
    return { jobs, recovered };
  } catch {
    return { jobs: [], recovered: 0 };
  }
}

/** Best-effort write; a persistence failure is logged by the caller and ignored. */
export function savePersistedJobs(
  jobs: BackgroundJob[],
  filePath = getBackgroundJobsPath()
): boolean {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload: PersistedJobsFile = {
      version: FILE_VERSION,
      savedAt: Date.now(),
      jobs: jobs.map(toPersistable),
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Reduce a job to what is safe and useful to persist: lifecycle facts plus
 * small metadata. Large results are truncated so the snapshot stays bounded.
 */
function toPersistable(job: BackgroundJob): BackgroundJob {
  return {
    ...job,
    result: boundValue(job.result),
    metadata: job.metadata ? boundMetadata(job.metadata) : undefined,
  };
}

const MAX_PERSISTED_STRING = 4_000;

function boundValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > MAX_PERSISTED_STRING
      ? `${value.slice(0, MAX_PERSISTED_STRING)}… [truncated]`
      : value;
  }
  return value;
}

function boundMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    // Never persist functions or abort controllers.
    if (typeof value === "function") continue;
    out[key] = boundValue(value);
  }
  return out;
}
