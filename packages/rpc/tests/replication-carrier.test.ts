import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { ComputerEfsCarrierV1RpcTarget } from "@ephemeralai/fs-replication";
import { newWebSocketRpcSession, type RpcStub } from "capnweb";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";

import {
  acceptComputerEfsCarrierSession,
  COMPUTER_EFS_CARRIER_V1_RESOURCES,
  computerEfsCarrierV1Stats,
  openAuthenticatedComputerEfsCarrier,
} from "../src/replication-carrier.js";

const MiB = 1024 * 1024;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("computer-efs-carrier-v1", () => {
  afterEach(() => {
    expect(computerEfsCarrierV1Stats()).toEqual({ reservedBytes: 0, queued: 0 });
  });

  it("authenticates before constructing an opaque endpoint", async () => {
    const order: string[] = [];
    const carrier = await openAuthenticatedComputerEfsCarrier({
      credential: "peer-token",
      async authenticate(credential) {
        order.push(`authenticate:${credential}`);
        return { principal: "peer-a" };
      },
      async openEndpoint(peer) {
        order.push(`endpoint:${peer.principal}`);
        return {
          async exchange(request) {
            return request;
          },
          async close() {},
        };
      },
    });

    expect(order).toEqual(["authenticate:peer-token", "endpoint:peer-a"]);
    await carrier.close();
  });

  it("does not construct an endpoint when peer authentication fails", async () => {
    let opened = false;
    await expect(
      openAuthenticatedComputerEfsCarrier({
        credential: "wrong",
        async authenticate() {
          throw new Error("EAUTH");
        },
        async openEndpoint() {
          opened = true;
          return {
            async exchange(request) {
              return request;
            },
            async close() {},
          };
        },
      }),
    ).rejects.toThrow("EAUTH");
    expect(opened).toBe(false);
  });

  it("rejects an incompatible profile before authentication or endpoint creation", async () => {
    let touched = false;
    await expect(
      openAuthenticatedComputerEfsCarrier({
        credential: "ok",
        limits: { hostProfile: "wrong-profile" as never },
        async authenticate() {
          touched = true;
          return true;
        },
        async openEndpoint() {
          touched = true;
          throw new Error("must not open");
        },
      }),
    ).rejects.toMatchObject({ code: "CapabilityMismatch" });
    expect(touched).toBe(false);
  });

  it("enforces decoded request and response boundaries", async () => {
    let calls = 0;
    let response = new Uint8Array();
    const carrier = await openAuthenticatedComputerEfsCarrier({
      credential: "ok",
      async authenticate() {
        return true;
      },
      async openEndpoint() {
        return {
          async exchange() {
            calls++;
            return response;
          },
          async close() {},
        };
      },
    });

    await expect(carrier.target.exchange(new Uint8Array(3 * MiB))).resolves.toHaveLength(0);
    await expect(carrier.target.exchange(new Uint8Array(3 * MiB + 1))).rejects.toMatchObject({
      code: "ResourceLimit",
    });
    expect(calls).toBe(1);

    response = new Uint8Array(3 * MiB + 1);
    await expect(carrier.target.exchange(new Uint8Array())).rejects.toMatchObject({
      code: "ResourceLimit",
    });
    await carrier.close();
  });

  it("admits at most one maximum 17.25 MiB carrier session process-wide", async () => {
    expect(COMPUTER_EFS_CARRIER_V1_RESOURCES.maxReservationBytes).toBe(17.25 * MiB);
    const opened: string[] = [];
    const makeCarrier = (name: string) =>
      openAuthenticatedComputerEfsCarrier({
        credential: "ok",
        async authenticate() {
          return true;
        },
        async openEndpoint() {
          opened.push(name);
          return {
            async exchange(request) {
              return request;
            },
            async close() {},
          };
        },
      });
    const first = await makeCarrier("first");
    const secondPromise = makeCarrier("second");

    await Promise.resolve();
    expect(opened).toEqual(["first"]);
    expect(computerEfsCarrierV1Stats()).toEqual({
      reservedBytes: 17.25 * MiB,
      queued: 1,
    });

    await first.close();
    const second = await secondPromise;
    expect(opened).toEqual(["first", "second"]);
    await second.close();
  });

  it("rejects concurrent exchanges on one operation and closes once", async () => {
    const started = deferred<void>();
    const done = deferred<Uint8Array>();
    let closes = 0;
    const carrier = await openAuthenticatedComputerEfsCarrier({
      credential: "ok",
      async authenticate() {
        return true;
      },
      async openEndpoint() {
        return {
          async exchange() {
            started.resolve();
            return done.promise;
          },
          async close() {
            closes++;
          },
        };
      },
    });

    const active = carrier.target.exchange(new Uint8Array());
    await started.promise;
    await expect(carrier.target.exchange(new Uint8Array())).rejects.toMatchObject({
      code: "Busy",
    });
    done.resolve(new Uint8Array());
    await active;
    await carrier.close();
    await carrier.close();
    expect(closes).toBe(1);
    await expect(carrier.target.exchange(new Uint8Array())).rejects.toMatchObject({
      code: "Closed",
    });
  });

  it("forwards only opaque bytes through a real uncompressed Cap'n Web socket", async () => {
    const endpointClosed = deferred<void>();
    const local = await openAuthenticatedComputerEfsCarrier({
      credential: "ok",
      async authenticate() {
        return true;
      },
      async openEndpoint() {
        return {
          async exchange(request) {
            return Uint8Array.from(request, (byte) => byte ^ 0xff);
          },
          async close() {
            endpointClosed.resolve();
          },
        };
      },
    });
    const http: Server = createServer();
    const wss = new WebSocketServer({
      server: http,
      path: "/replication",
      maxPayload: COMPUTER_EFS_CARRIER_V1_RESOURCES.maxRawFrameBytes,
      perMessageDeflate: false,
    });
    wss.on("connection", (ws) => acceptComputerEfsCarrierSession(ws, local));
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    const port = (http.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/replication`, {
      maxPayload: COMPUTER_EFS_CARRIER_V1_RESOURCES.maxRawFrameBytes,
      perMessageDeflate: false,
    });
    const remote = newWebSocketRpcSession(ws as never) as RpcStub<ComputerEfsCarrierV1RpcTarget>;

    try {
      expect(Array.from(await remote.exchange(Uint8Array.of(0x00, 0x55, 0xff)))).toEqual([
        0xff, 0xaa, 0x00,
      ]);
      expect(ws.extensions).toBe("");
    } finally {
      (remote as unknown as Disposable)[Symbol.dispose]();
      ws.close();
      await endpointClosed.promise;
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
      await local.close();
    }
  });
});
