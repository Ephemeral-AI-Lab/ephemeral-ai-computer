import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { createNodeVirtualFileSystem } from "./index.js";

async function removeTree(target: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

test("createNodeVirtualFileSystem returns a @platformatic/vfs filesystem", async () => {
  const { vfs } = await createNodeVirtualFileSystem();

  vfs.mkdirSync("/project", { recursive: true });
  vfs.writeFileSync("/project/hello.txt", Buffer.from("hello"));

  expect(vfs.readdirSync("/")).toEqual(["project"]);
  expect(vfs.readdirSync("/project")).toEqual(["hello.txt"]);
  expect(vfs.readFileSync("/project/hello.txt").toString()).toBe("hello");

  vfs.renameSync("/project/hello.txt", "/project/greeting.txt");
  expect(vfs.existsSync("/project/hello.txt")).toBe(false);
  expect(vfs.readFileSync("/project/greeting.txt").toString()).toBe("hello");

  vfs.unlinkSync("/project/greeting.txt");
  expect(vfs.readdirSync("/project")).toEqual([]);
});

test("createNodeVirtualFileSystem pulls initial state from an upstream SyncRPC", async () => {
  const bytes = Buffer.from("hi");
  const hash = new Uint8Array(createHash("sha256").update(bytes).digest());

  let fetchChangesCalls = 0;
  const upstream = {
    async fetchChanges() {
      fetchChangesCalls++;
      return {
        currentCursor: { rev: 1, path: null },
        appliedPushCursor: { rev: 0, path: null },
        stream: new ReadableStream({
          start(c) {
            c.enqueue({
              kind: "file",
              rev: 1,
              path: "/hi.txt",
              mode: 0o644,
              mtime: 100,
              size: 2,
              chunks: [{ hash, size: 2 }],
            });
            c.close();
          },
        }),
      };
    },
    async hasObjects(hashes) {
      // The fake upstream is the source of truth for this file's
      // chunk. Reply that we have every hash the client probes.
      return hashes;
    },
    async fetchObjects(hashes) {
      return new ReadableStream({
        start(c) {
          for (const h of hashes) c.enqueue({ hash: h, bytes });
          c.close();
        },
      });
    },
    async push() {
      return { rev: 0, appliedPushCursor: { rev: 0, path: null } };
    },
    async pushObjects() {},
  };

  const { vfs } = await createNodeVirtualFileSystem({ upstream });
  expect(fetchChangesCalls).toBe(1);
  expect(vfs.readFileSync("/hi.txt").toString()).toBe("hi");
});

test("fresh replica opens only the unbound replication view", async () => {
  const directory = await mkdtemp(join(tmpdir(), "computerd-efs-unbound-"));
  const filename = join(directory, "replica.db");
  try {
    const handle = await createNodeVirtualFileSystem({
      databasePath: filename,
      replicationIdentity: { authorityId: "authority-01", role: "replica" },
    });
    expect(handle.provisioningState).toBe("unbound-replica");
    expect(handle.vfs).toBeUndefined();
    expect(handle.openReplicationEndpoint).toBeTypeOf("function");
    try {
      await handle.close?.();
    } catch (error) {
      console.error("EFS handle close failed", error);
      throw error;
    }

    const reopened = await createNodeVirtualFileSystem({
      databasePath: filename,
      replicationIdentity: { authorityId: "authority-01", role: "replica" },
    });
    expect(reopened.provisioningState).toBe("unbound-replica");
    expect(reopened.vfs).toBeUndefined();
    await reopened.close?.();
  } finally {
    await removeTree(directory);
  }
});

test("a replica database without prebound identity cannot create a local filesystem", async () => {
  const directory = await mkdtemp(join(tmpdir(), "computerd-efs-unbound-anonymous-"));
  const filename = join(directory, "replica.db");
  try {
    const handle = await createNodeVirtualFileSystem({ databasePath: filename });
    expect(handle.provisioningState).toBe("unbound-replica");
    expect(handle.vfs).toBeUndefined();
    await handle.close?.();
  } finally {
    await removeTree(directory);
  }
});

test("a wrong-engine replica database is rejected without fallback mutation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "computerd-efs-wrong-engine-"));
  const filename = join(directory, "replica.db");
  const original = Buffer.from("not an SQLite database\n");
  try {
    await writeFile(filename, original);
    await expect(
      createNodeVirtualFileSystem({
        databasePath: filename,
        replicationIdentity: { authorityId: "authority-01", role: "replica" },
      }),
    ).rejects.toThrow();
    expect(await readFile(filename)).toEqual(original);
  } finally {
    await removeTree(directory);
  }
});
