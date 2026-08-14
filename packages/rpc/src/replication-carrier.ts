import {
  type AdmittedComputerEfsCarrierV1,
  admitComputerEfsCarrierV1,
  COMPUTER_EFS_CARRIER_V1_RESOURCES,
  type ComputerEfsCarrierV1Endpoint,
  type ComputerEfsCarrierV1Limits,
  type ComputerEfsCarrierV1RpcTarget,
  computerEfsCarrierV1Stats,
  validateComputerEfsCarrierV1,
} from "@ephemeralai/fs-replication";
import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import type { ClientOptions as WsClientOptions } from "ws";

import { trackStub, untrackStub } from "./debug.js";

interface CarrierSocket {
  readonly readyState: number;
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions | boolean): void;
  removeEventListener(type: string, listener: EventListener, options?: EventListenerOptions | boolean): void;
  close(): void;
}

export interface ComputerEfsWebSocketConstructor {
  new (url: string | URL, options?: WsClientOptions): CarrierSocket;
}

export { COMPUTER_EFS_CARRIER_V1_RESOURCES, computerEfsCarrierV1Stats };

class ComputerEfsCarrierTarget extends RpcTarget {
  readonly #target: ComputerEfsCarrierV1RpcTarget;

  constructor(target: ComputerEfsCarrierV1RpcTarget) {
    super();
    this.#target = target;
    trackStub(this);
  }

  exchange(request: Uint8Array): Promise<Uint8Array> {
    return this.#target.exchange(request);
  }

  [Symbol.dispose](): void {
    untrackStub(this);
  }
}

export async function openAuthenticatedComputerEfsCarrier<Peer>(options: {
  credential: string;
  authenticate(credential: string): Promise<Peer>;
  openEndpoint(peer: Peer): Promise<ComputerEfsCarrierV1Endpoint>;
  limits?: Partial<ComputerEfsCarrierV1Limits>;
  signal?: AbortSignal;
}): Promise<AdmittedComputerEfsCarrierV1> {
  const limits = {
    ...options.limits,
    maxRequestBytes:
      options.limits?.maxRequestBytes ?? COMPUTER_EFS_CARRIER_V1_RESOURCES.maxDecodedEnvelopeBytes,
    maxResponseBytes:
      options.limits?.maxResponseBytes ?? COMPUTER_EFS_CARRIER_V1_RESOURCES.maxDecodedEnvelopeBytes,
  } satisfies ComputerEfsCarrierV1Limits;
  validateComputerEfsCarrierV1(limits);
  const peer = await options.authenticate(options.credential);
  return admitComputerEfsCarrierV1({
    limits,
    signal: options.signal,
    openEndpoint: () => options.openEndpoint(peer),
  });
}

export function acceptComputerEfsCarrierSession(
  ws: WebSocket | { addEventListener: WebSocket["addEventListener"] },
  admitted: AdmittedComputerEfsCarrierV1,
): void {
  const target = new ComputerEfsCarrierTarget(admitted.target);
  newWebSocketRpcSession(ws as WebSocket, target);
  const close = () => {
    target[Symbol.dispose]();
    void admitted.close().catch(() => {});
  };
  ws.addEventListener("close", close, { once: true });
  ws.addEventListener("error", close, { once: true });
}

/** Open the real Cap'n Web carrier used when computerd returns its active
 * branch to an authority. The returned admission owns the socket, the RPC
 * root stub, and the process-wide carrier reservation. */
export async function openComputerEfsCarrierClient(options: {
  readonly url: string;
  readonly credential: string;
  readonly WebSocketImpl: ComputerEfsWebSocketConstructor;
  readonly limits?: Partial<ComputerEfsCarrierV1Limits>;
  readonly signal?: AbortSignal;
}): Promise<AdmittedComputerEfsCarrierV1> {
  const ws = new options.WebSocketImpl(options.url, {
    headers: { "x-efs-auth": options.credential },
    maxPayload: COMPUTER_EFS_CARRIER_V1_RESOURCES.maxRawFrameBytes,
    perMessageDeflate: false,
  });
  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      ws.removeEventListener("open", onOpen);
      reject(new Error("replication authority carrier connection failed"));
    };
    ws.addEventListener("open", onOpen, { once: true });
    ws.addEventListener("error", onError, { once: true });
  });
  const remote = newWebSocketRpcSession(ws as unknown as WebSocket) as RpcStub<ComputerEfsCarrierV1RpcTarget>;
  try {
    return await admitComputerEfsCarrierV1({
      limits: {
        ...options.limits,
        maxRequestBytes:
          options.limits?.maxRequestBytes ?? COMPUTER_EFS_CARRIER_V1_RESOURCES.maxDecodedEnvelopeBytes,
        maxResponseBytes:
          options.limits?.maxResponseBytes ?? COMPUTER_EFS_CARRIER_V1_RESOURCES.maxDecodedEnvelopeBytes,
      },
      signal: options.signal,
      openEndpoint: () => ({
        exchange: (request) => remote.exchange(request),
        close: async () => {
          try { (remote as unknown as Disposable)[Symbol.dispose]?.(); } catch {}
          if (ws.readyState < 2) ws.close();
          await new Promise<void>((resolve) => {
            if (ws.readyState >= 3) return resolve();
            ws.addEventListener("close", () => resolve(), { once: true });
            setTimeout(resolve, 200);
          });
        },
      }),
    });
  } catch (error) {
    try { (remote as unknown as Disposable)[Symbol.dispose]?.(); } catch {}
    if (ws.readyState < 2) ws.close();
    throw error;
  }
}
