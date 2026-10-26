import { PeerError, type PeerChannel } from "@t3tools/contracts/minesPeer";
import { gzipSync, gunzipSync } from "fflate";

export interface PeerSession {
  readonly remoteDeviceId: string;
  readonly send: (channel: PeerChannel, data: Uint8Array) => Promise<void>;
  readonly subscribe: (channel: PeerChannel, listener: (data: Uint8Array) => void) => () => void;
  readonly close: () => void;
  readonly closed: Promise<void>;
}
export interface PeerDataChannel {
  readonly send: (data: Uint8Array) => void;
  readonly bufferedAmount: () => number;
  readonly onMessage: (listener: (data: Uint8Array) => void) => void;
  readonly onBufferedLow: (listener: () => void) => void;
  readonly onClose: (listener: () => void) => void;
  readonly close: () => void;
}
const channelIds = { rpc: 0, resource: 1, catalog: 2, "shared-group": 3 } as const;
const channels = ["rpc", "resource", "catalog", "shared-group"] as const;
const isControlChannel = (channel: PeerChannel) => channel === "rpc" || channel === "shared-group";
const MAX_FRAME_BYTES = 16 * 1024;
const HEADER_BYTES = 10;
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
const START = 1;
const END = 2;
const GZIP = 4;
interface PartialMessage {
  readonly decodedLength: number;
  readonly encodedLength: number;
  readonly gzip: boolean;
  readonly chunks: Uint8Array[];
  length: number;
}

export function createPeerSession(
  remoteDeviceId: string,
  control: PeerDataChannel,
  bulk: PeerDataChannel,
  closePeer: () => void,
  allowedChannels: ReadonlyArray<PeerChannel> = ["rpc", "resource", "catalog"],
): PeerSession {
  const listeners = new Map<PeerChannel, Set<(data: Uint8Array) => void>>();
  const unread = new Map<PeerChannel, Uint8Array[]>();
  const partial = new Map<PeerChannel, PartialMessage>();
  const waiters = new Set<{ resolve: () => void; reject: (reason: PeerError) => void }>();
  const queues = { control: Promise.resolve(), bulk: Promise.resolve() };
  let outgoingBytes = 0;
  let incomingBytes = 0;
  let queuedControl = 0;
  let ended = false;
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const wake = () => {
    for (const waiter of waiters) waiter.resolve();
    waiters.clear();
  };
  const close = () => {
    if (ended) return;
    ended = true;
    for (const waiter of waiters) waiter.reject(new PeerError({ code: "closed" }));
    waiters.clear();
    listeners.clear();
    unread.clear();
    partial.clear();
    control.close();
    bulk.close();
    closePeer();
    finish();
  };
  const receive = (data: Uint8Array, wire: "control" | "bulk") => {
    if (ended) return;
    try {
      const channel = channels[data[0] ?? -1];
      const flags = data[1] ?? 0;
      if (
        !channel ||
        !allowedChannels.includes(channel) ||
        data.byteLength < HEADER_BYTES ||
        data.byteLength > MAX_FRAME_BYTES ||
        flags > 7 ||
        isControlChannel(channel) !== (wire === "control")
      )
        throw new Error("invalid frame");
      const header = new DataView(data.buffer, data.byteOffset, HEADER_BYTES);
      const decodedLength = header.getUint32(2);
      const encodedLength = header.getUint32(6);
      if (
        decodedLength > MAX_MESSAGE_BYTES ||
        encodedLength > MAX_MESSAGE_BYTES ||
        ((flags & GZIP) === 0 && decodedLength !== encodedLength)
      )
        throw new Error("invalid length");
      let message = partial.get(channel);
      if (flags & START) {
        if (message || incomingBytes + decodedLength > MAX_PENDING_BYTES)
          throw new Error("message overflow");
        message = {
          decodedLength,
          encodedLength,
          gzip: (flags & GZIP) !== 0,
          chunks: [],
          length: 0,
        };
        partial.set(channel, message);
        incomingBytes += decodedLength;
      }
      if (
        !message ||
        message.decodedLength !== decodedLength ||
        message.encodedLength !== encodedLength ||
        message.gzip !== ((flags & GZIP) !== 0)
      )
        throw new Error("invalid continuation");
      const chunk = data.slice(HEADER_BYTES);
      if (chunk.length === 0 && !(flags & END)) throw new Error("empty fragment");
      message.length += chunk.byteLength;
      if (message.length > message.encodedLength) throw new Error("message overflow");
      message.chunks.push(chunk);
      if (!(flags & END)) return;
      if (message.length !== encodedLength) throw new Error("truncated message");
      partial.delete(channel);
      const encoded = new Uint8Array(encodedLength);
      let offset = 0;
      for (const piece of message.chunks) {
        encoded.set(piece, offset);
        offset += piece.length;
      }
      // A caller-supplied output buffer bounds decompression despite hostile gzip headers.
      const value = message.gzip
        ? gunzipSync(encoded, { out: new Uint8Array(decodedLength) })
        : encoded;
      if (value.length !== decodedLength) throw new Error("invalid decoded length");
      const current = listeners.get(channel);
      if (current?.size) {
        incomingBytes -= decodedLength;
        for (const listener of current) listener(value);
      } else {
        const backlog = unread.get(channel) ?? [];
        if (backlog.length >= 128) throw new Error("unread message overflow");
        backlog.push(value);
        unread.set(channel, backlog);
      }
    } catch {
      close();
    }
  };
  for (const [name, wire] of [
    ["control", control],
    ["bulk", bulk],
  ] as const) {
    wire.onMessage((data) => receive(data, name));
    wire.onClose(close);
    wire.onBufferedLow(wake);
  }
  const waitForCapacity = async (wire: PeerDataChannel) => {
    const blocked = () =>
      !ended &&
      (wire.bufferedAmount() > 128 * 1024 ||
        (wire === bulk && (queuedControl > 0 || control.bufferedAmount() > 32 * 1024)));
    while (blocked()) {
      await new Promise<void>((resolve, reject) => waiters.add({ resolve, reject }));
    }
    if (ended) throw new PeerError({ code: "closed" });
  };
  const send = (channel: PeerChannel, source: Uint8Array): Promise<void> => {
    if (ended) return Promise.reject(new PeerError({ code: "closed" }));
    if (!allowedChannels.includes(channel))
      return Promise.reject(new PeerError({ code: "unapproved-device" }));
    if (
      source.byteLength > MAX_MESSAGE_BYTES ||
      outgoingBytes + source.byteLength > MAX_PENDING_BYTES
    )
      return Promise.reject(new PeerError({ code: "frame-too-large" }));
    outgoingBytes += source.byteLength;
    if (isControlChannel(channel)) queuedControl++;
    const data = source.slice();
    const lane = isControlChannel(channel) ? "control" : "bulk";
    const wire = isControlChannel(channel) ? control : bulk;
    const operation = queues[lane]
      .then(async () => {
        let encoded = data;
        let gzip = false;
        if (data.length >= 4096) {
          const candidate = gzipSync(data, { level: 1 });
          if (candidate.length <= data.length * 0.9) {
            encoded = candidate;
            gzip = true;
          }
        }
        let offset = 0;
        do {
          await waitForCapacity(wire);
          const length = Math.min(MAX_FRAME_BYTES - HEADER_BYTES, encoded.length - offset);
          const frame = new Uint8Array(HEADER_BYTES + length);
          const end = offset + length === encoded.length;
          frame[0] = channelIds[channel];
          frame[1] = (offset === 0 ? START : 0) | (end ? END : 0) | (gzip ? GZIP : 0);
          const header = new DataView(frame.buffer);
          header.setUint32(2, data.length);
          header.setUint32(6, encoded.length);
          frame.set(encoded.subarray(offset, offset + length), HEADER_BYTES);
          wire.send(frame);
          offset += length;
        } while (offset < encoded.length);
      })
      .finally(() => {
        outgoingBytes -= data.length;
        if (isControlChannel(channel)) queuedControl--;
        wake();
      });
    queues[lane] = operation.catch(() => {
      close();
    });
    return operation;
  };
  return {
    remoteDeviceId,
    send,
    close,
    closed,
    subscribe(channel, listener) {
      const set = listeners.get(channel) ?? new Set();
      set.add(listener);
      listeners.set(channel, set);
      const backlog = unread.get(channel);
      unread.delete(channel);
      for (const value of backlog ?? []) {
        incomingBytes -= value.length;
        listener(value);
      }
      return () => {
        set.delete(listener);
      };
    },
  };
}
