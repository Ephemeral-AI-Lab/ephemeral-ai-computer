import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  openComputerEfsCarrierClient,
  type ComputerEfsWebSocketConstructor,
} from "@cloudflare/computer-rpc";
import { EphemeralRuntime } from "@ephemeralai/fs/integrations/runtime";
import { createReplicationEndpoint, replicate } from "@ephemeralai/fs-replication";
import { openNodeSqlite } from "@ephemeralai/fs-sqlite-node";
import { expect, onTestFinished, test } from "vitest";
import { WebSocket } from "ws";

const packageRoot = path.resolve(import.meta.dirname, "../..");
const cliPath = path.join(packageRoot, "dist", "cli", "computerd.cjs");

function authorization(filesystemId: string) {
  return {
    principalId: "m8-carrier-test",
    hostScopeId: "m8-workspace",
    expectedFilesystemId: filesystemId,
    expectedAuthorityId: "m8-authority",
    policyVersion: "m8-policy-1",
    hostProfile: "computer-efs-carrier-v1",
    limitPolicy: {
      ceilings: {
        maxBatchEntries: 256,
        maxBatchBytes: 3 * 1024 * 1024 - 64 * 1024,
        maxRequestBytes: 3 * 1024 * 1024,
        maxResponseBytes: 3 * 1024 * 1024,
        maxBufferedBytes: 10 * 1024 * 1024,
        maxInFlightBatches: 1,
        maxConcurrentSessions: 16,
        maxStagingBytesPerSession: 128 * 1024 * 1024,
        maxReplicationSessionRows: 10_000,
        maxReplicationMetadataBytes: 64 * 1024 * 1024,
        maxReceiptsPerSession: 100_000,
        maxReceiptBytesPerSession: 16 * 1024 * 1024,
        maxCursorBytes: 256,
        maxTerminalResultBytes: 1024 * 1024,
        maxCursorAgeMs: 24 * 60 * 60 * 1000,
        stagingLeaseMs: 15 * 60 * 1000,
        resultRetentionMs: 30 * 24 * 60 * 60 * 1000,
        maxRetryAttempts: 8,
        maxRetryElapsedMs: 5 * 60 * 1000,
        minRetryDelayMs: 100,
        maxRetryDelayMs: 10_000,
      },
      minRetryDelayMsFloor: 100,
    },
    allowedPlans: [
      { flow: "authority-main-to-replica" },
      { flow: "authority-branch-to-replica", branchId: "m8-branch" },
    ],
  } as const;
}

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate a TCP port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function request(url: string): Promise<{ readonly statusCode?: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => resolve({ statusCode: response.statusCode, body }));
    });
    req.once("error", reject);
    req.setTimeout(1000, () => req.destroy(new Error("request timed out")));
  });
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(`computerd exited before health: ${child.exitCode}`);
    try {
      if ((await request(`http://127.0.0.1:${port}/health`)).statusCode === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("computerd did not become healthy");
}

async function startComputerd(
  port: number,
  mountPoint: string,
  env: Record<string, string>
): Promise<ChildProcess> {
  const child = spawn(cliPath, [], {
    cwd: packageRoot,
    env: { ...process.env, MOUNT_POINT: mountPoint, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await waitForHealth(port, child);
  } catch (error) {
    child.kill("SIGKILL");
    throw new Error(`${(error as Error).message}: ${stderr}`);
  }
  return child;
}

async function stopComputerd(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

test("M8 uses the real authenticated Cap'n Web carrier with persistent SQLite and restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "computerd-m8-carrier-"));
  const mountPoint = path.join(directory, "mount");
  const authorityDb = await openNodeSqlite({ filename: path.join(directory, "authority.db") });
  const authority = await EphemeralRuntime.open({
    database: authorityDb,
    replicationIdentity: { authorityId: "m8-authority", role: "main-authority" },
  });
  const filesystemId = authority.identity.filesystemId;
  const peerAuthorization = authorization(filesystemId);
  const token = "m8-real-carrier-token";
  const replicaDbPath = path.join(directory, "replica.db");
  const transferMetrics: Array<Record<string, unknown>> = [];
  let computerd: ChildProcess | undefined;
  onTestFinished(async () => {
    if (computerd) await stopComputerd(computerd);
    await authority.close();
    await authorityDb.close();
    await rm(directory, { recursive: true, force: true });
  });

  await authority.filesystem.writeFile("/carrier.txt", "persistent carrier data");
  const sourceBranch = await authority.filesystem.branches.create("m8-branch");
  await sourceBranch.writeFile("/private.txt", "private branch data");
  const sourceBranchInfo = await sourceBranch.info();
  await sourceBranch.close();
  const port = await availablePort();
  computerd = await startComputerd(port, mountPoint, {
    FUSE_MOUNT: "none",
    EFS_DATABASE_PATH: replicaDbPath,
    EFS_AUTHORITY_ID: "m8-authority",
    EFS_ROLE: "replica",
    EFS_AUTH_TOKEN: token,
    EFS_AUTHORIZATION_JSON: JSON.stringify(peerAuthorization),
  });

  const admitted = await openComputerEfsCarrierClient({
    url: `ws://127.0.0.1:${port}/efs`,
    credential: token,
    WebSocketImpl: WebSocket as unknown as ComputerEfsWebSocketConstructor,
  });
  try {
    const result = await replicate({
      bridge: authority.replication,
      transport: admitted.target,
      authorization: peerAuthorization,
      plan: { flow: "authority-main-to-replica" },
      operationId: "m8-real-carrier-provision",
    });
    expect(result.status).toBe("complete");
    expect(result.result.activation.kind).toBe("main");
    expect(result.result.activation.revision).toBe("0");
    transferMetrics.push({ phase: "provisioning", ...result.result });
  } finally {
    await admitted.close();
  }

  await stopComputerd(computerd);
  computerd = await startComputerd(port, mountPoint, {
    FUSE_MOUNT: "none",
    EFS_DATABASE_PATH: replicaDbPath,
    EFS_AUTHORITY_ID: "m8-authority",
    EFS_ROLE: "replica",
    EFS_AUTH_TOKEN: token,
    EFS_AUTHORIZATION_JSON: JSON.stringify(peerAuthorization),
  });

  const mainAdmitted = await openComputerEfsCarrierClient({
    url: `ws://127.0.0.1:${port}/efs`,
    credential: token,
    WebSocketImpl: WebSocket as unknown as ComputerEfsWebSocketConstructor,
  });
  try {
    const result = await replicate({
      bridge: authority.replication,
      transport: mainAdmitted.target,
      authorization: peerAuthorization,
      plan: { flow: "authority-main-to-replica" },
      operationId: "m8-real-carrier-main",
    });
    expect(result.status).toBe("complete");
    expect(result.result.activation.revision).toBe("1");
    transferMetrics.push({ phase: "main", ...result.result });
  } finally {
    await mainAdmitted.close();
  }

  const branchAdmitted = await openComputerEfsCarrierClient({
    url: `ws://127.0.0.1:${port}/efs`,
    credential: token,
    WebSocketImpl: WebSocket as unknown as ComputerEfsWebSocketConstructor,
  });
  try {
    const result = await replicate({
      bridge: authority.replication,
      transport: branchAdmitted.target,
      authorization: peerAuthorization,
      plan: { flow: "authority-branch-to-replica", branchId: "m8-branch" },
      operationId: "m8-real-carrier-branch",
    });
    expect(result.status).toBe("complete");
    expect(result.result.activation.kind).toBe("branch");
    expect(result.result.activation.generation).toBe(sourceBranchInfo.generation);
    transferMetrics.push({ phase: "active-branch", ...result.result });
  } finally {
    await branchAdmitted.close();
  }

  await stopComputerd(computerd);
  computerd = await startComputerd(port, mountPoint, {
    FUSE_MOUNT: "fuse",
    EFS_DATABASE_PATH: replicaDbPath,
    EFS_AUTHORITY_ID: "m8-authority",
    EFS_ROLE: "replica",
    EFS_BRANCH_ID: "m8-branch",
    EFS_AUTH_TOKEN: token,
    EFS_AUTHORIZATION_JSON: JSON.stringify(peerAuthorization),
  });
  const info = await request(`http://127.0.0.1:${port}/__computerd/info`);
  expect(JSON.parse(info.body).backend.kind).toBe("fuse");
  expect(await readFile(path.join(mountPoint, "carrier.txt"), "utf8")).toBe(
    "persistent carrier data"
  );
  expect(await readFile(path.join(mountPoint, "private.txt"), "utf8")).toBe("private branch data");
  const stats = await request(`http://127.0.0.1:${port}/__computerd/stats`);
  const replicaStats = JSON.parse(stats.body) as Record<string, unknown>;
  const [authorityFile, replicaFile, replicaWal] = await Promise.all([
    stat(path.join(directory, "authority.db")),
    stat(replicaDbPath),
    stat(`${replicaDbPath}-wal`).catch(() => null),
  ]);
  console.log(
    JSON.stringify({
      schema: "efs-m8-carrier-metrics-v1",
      filesystemId,
      authorityId: "m8-authority",
      branchId: "m8-branch",
      branchGeneration: sourceBranchInfo.generation,
      branchGenerationDigest: sourceBranchInfo.generationDigest,
      restarts: 2,
      fuseBackend: JSON.parse(info.body).backend,
      carrier: {
        path: "/efs",
        protocol: "computer-efs-carrier-v1",
        perMessageDeflate: false,
        rawFrameBytes: 4 * 1024 * 1024 + 64 * 1024,
        decodedEnvelopeBytes: 3 * 1024 * 1024,
        acknowledgementBytes: 64 * 1024,
        scratchBytes: 2 * 1024 * 1024,
        maxReservationBytes: 17.25 * 1024 * 1024,
      },
      transfers: transferMetrics,
      process: {
        daemonRssBytes: replicaStats.rss,
        daemonHeapUsedBytes: replicaStats.heap_used,
        daemonCarrierReservedBytes: replicaStats.carrier_reserved_bytes,
      },
      databases: {
        authorityBytes: authorityFile.size,
        replicaBytes: replicaFile.size,
        replicaWalBytes: replicaWal?.size ?? 0,
      },
    })
  );
});
