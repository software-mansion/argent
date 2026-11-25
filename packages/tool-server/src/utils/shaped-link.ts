import type * as net from "node:net";
import { Duplex } from "node:stream";
import type { NetworkConditions } from "./network-conditions";

const SLICE_BYTES = 16 * 1024;
const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
const SEND_CREDIT_MS = 20;
const MAX_REQUEST_LINE = 8192;

/** One direction of the link, shared by every connection so a speed limit caps their sum. */
export class LinkDirection {
  private freeAt = 0;
  private bytesPerMs: number | null = null;
  private delayMs = 0;

  configure(kbps: number | undefined, latencyMs: number | undefined): boolean {
    const bytesPerMs = kbps === undefined ? null : kbps / 8;
    const delayMs = (latencyMs ?? 0) / 2;
    if (bytesPerMs === this.bytesPerMs && delayMs === this.delayMs) return false;
    this.bytesPerMs = bytesPerMs;
    this.delayMs = delayMs;
    this.freeAt = 0;
    return true;
  }

  get shaping(): boolean {
    return this.bytesPerMs !== null || this.delayMs > 0;
  }

  send(bytes: number, now: number): { sentAt: number; arrivesAt: number } {
    if (this.bytesPerMs === null) return { sentAt: now, arrivesAt: now + this.delayMs };
    const start = Math.max(now - SEND_CREDIT_MS, this.freeAt);
    this.freeAt = start + bytes / this.bytesPerMs;
    return { sentAt: this.freeAt, arrivesAt: Math.max(this.freeAt, now) + this.delayMs };
  }

  startOf(bytes: number, sentAt: number): number {
    return this.bytesPerMs === null ? sentAt : sentAt - bytes / this.bytesPerMs;
  }

  release(bytes: number, sentAt: number, now: number): void {
    if (this.bytesPerMs === null) return;
    const unsentMs = Math.min(sentAt - now, bytes / this.bytesPerMs);
    if (unsentMs > 0) this.freeAt -= unsentMs;
  }
}

const UNSHAPED = new LinkDirection();

interface QueuedSlice {
  sentAt: number;
  arrivesAt: number;
  chunk: Buffer;
}

function slicesOf(chunk: Buffer): Buffer[] {
  const slices: Buffer[] = [];
  for (let offset = 0; offset < chunk.length; offset += SLICE_BYTES) {
    slices.push(chunk.subarray(offset, offset + SLICE_BYTES));
  }
  return slices;
}

/** Delivers chunks in order when the link says they arrive; `done` runs once a chunk is sent. */
class DelayedQueue {
  private slices: QueuedSlice[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly sendTimers = new Map<NodeJS.Timeout, () => void>();
  private lastArrival = 0;
  queuedBytes = 0;

  constructor(
    private readonly link: () => LinkDirection,
    private readonly deliver: (chunk: Buffer) => void,
    private readonly onDrain: () => void
  ) {}

  get empty(): boolean {
    return this.slices.length === 0;
  }

  push(chunk: Buffer, done?: () => void): void {
    const link = this.link();
    if (!link.shaping && this.empty) {
      this.deliver(Buffer.from(chunk));
      done?.();
      return;
    }
    let sentAt = 0;
    for (const slice of slicesOf(Buffer.from(chunk))) {
      const queued = { sentAt: 0, arrivesAt: 0, chunk: slice };
      sentAt = this.pace(queued, link);
      this.slices.push(queued);
      this.queuedBytes += slice.length;
    }
    this.schedule();
    if (done) this.whenSent(sentAt, done);
  }

  repace(): void {
    this.lastArrival = 0;
    this.repaceSlices(this.slices);
  }

  releaseWaiting(now: number): void {
    this.release(this.waitingToSend(now), now);
  }

  repaceWaiting(now: number): void {
    const waiting = this.waitingToSend(now);
    if (waiting.length === 0) return;
    this.lastArrival = this.slices[this.slices.length - waiting.length - 1]?.arrivesAt ?? 0;
    this.repaceSlices(waiting);
  }

  clear(): void {
    this.stopTimers();
    this.release(this.slices, performance.now());
    this.slices = [];
    this.queuedBytes = 0;
  }

  private stopTimers(): void {
    if (this.timer) clearTimeout(this.timer);
    for (const timer of this.sendTimers.keys()) clearTimeout(timer);
    this.sendTimers.clear();
    this.timer = null;
  }

  private pace(slice: QueuedSlice, link: LinkDirection): number {
    const timing = link.send(slice.chunk.length, performance.now());
    this.lastArrival = Math.max(this.lastArrival, timing.arrivesAt);
    slice.sentAt = timing.sentAt;
    slice.arrivesAt = this.lastArrival;
    return timing.sentAt;
  }

  private waitingToSend(now: number): QueuedSlice[] {
    const link = this.link();
    const first = this.slices.findIndex(
      (slice) => link.startOf(slice.chunk.length, slice.sentAt) > now
    );
    return first === -1 ? [] : this.slices.slice(first);
  }

  private release(slices: QueuedSlice[], now: number): void {
    const link = this.link();
    for (const slice of slices) link.release(slice.chunk.length, slice.sentAt, now);
  }

  private repaceSlices(slices: QueuedSlice[]): void {
    const link = this.link();
    const waiting = [...this.sendTimers.values()];
    this.stopTimers();
    let sentAt = 0;
    for (const slice of slices) sentAt = this.pace(slice, link);
    this.schedule();
    for (const done of waiting) this.whenSent(sentAt, done);
  }

  private whenSent(sentAt: number, done: () => void): void {
    const wait = sentAt - performance.now();
    if (wait <= 0) {
      done();
      return;
    }
    const timer = setTimeout(() => {
      this.sendTimers.delete(timer);
      done();
    }, wait);
    this.sendTimers.set(timer, done);
  }

  private schedule(): void {
    const next = this.slices[0];
    if (this.timer || !next) return;
    const wait = Math.max(0, next.arrivesAt - performance.now());
    this.timer = setTimeout(() => this.deliverDue(), wait);
  }

  private deliverDue(): void {
    this.timer = null;
    const now = performance.now();
    while (this.slices[0] && this.slices[0].arrivesAt <= now) {
      const slice = this.slices.shift()!;
      this.queuedBytes -= slice.chunk.length;
      this.deliver(slice.chunk);
    }
    if (this.empty) this.onDrain();
    this.schedule();
  }
}

/** The device's connection to the proxy, as the shaped link delivers it in both directions. */
class ShapedSocket extends Duplex {
  private requestHead = "";
  private heldRequest: Buffer[] = [];
  private requestLine: string | null = null;
  private readonly upload: DelayedQueue;
  private readonly download: DelayedQueue;
  private deviceEnded = false;
  private pendingFinal: (() => void) | null = null;
  private writerWaiting: (() => void) | null = null;
  private uploadsSending = 0;
  private proxyFull = false;

  constructor(
    readonly socket: net.Socket,
    private readonly links: { upload: LinkDirection; download: LinkDirection },
    private readonly isBypassed: (requestLine: string) => boolean
  ) {
    super();
    this.upload = new DelayedQueue(
      () => this.linkFor("upload"),
      (chunk) => this.deliverToProxy(chunk),
      () => this.onUploadDrain()
    );
    this.download = new DelayedQueue(
      () => this.linkFor("download"),
      (chunk) => this.deliverToDevice(chunk),
      () => this.onDownloadDrain()
    );
    socket.on("data", (chunk: Buffer) => this.onDeviceData(chunk));
    socket.on("end", () => this.onDeviceEnd());
    socket.on("error", (err) => this.destroy(err));
    socket.on("close", () => this.destroy());
  }

  setNoDelay(noDelay?: boolean): this {
    this.socket.setNoDelay(noDelay);
    return this;
  }

  repace(direction: "upload" | "download"): void {
    this[direction].repace();
  }

  releaseWaiting(now: number): void {
    this.upload.releaseWaiting(now);
    this.download.releaseWaiting(now);
  }

  repaceWaiting(now: number): void {
    this.upload.repaceWaiting(now);
    this.download.repaceWaiting(now);
  }

  override _read(): void {
    this.proxyFull = false;
    this.resumeDevice();
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: () => void): void {
    this.download.push(chunk, () => this.whenDeviceHasRoom(callback));
  }

  override _final(callback: () => void): void {
    this.pendingFinal = () => this.socket.end(callback);
    if (this.download.empty) this.onDownloadDrain();
  }

  override _destroy(err: Error | null, callback: (err: Error | null) => void): void {
    this.upload.clear();
    this.download.clear();
    this.socket.destroy();
    callback(err);
  }

  private linkFor(direction: "upload" | "download"): LinkDirection {
    const bypassed = this.requestLine !== null && this.isBypassed(this.requestLine);
    return bypassed ? UNSHAPED : this.links[direction];
  }

  private onDeviceData(chunk: Buffer): void {
    if (this.requestLine !== null) return this.sendUpload(chunk);
    this.heldRequest.push(chunk);
    if (this.readRequestLine(chunk)) this.sendHeldRequest();
  }

  private sendHeldRequest(): void {
    const held = Buffer.concat(this.heldRequest);
    this.heldRequest = [];
    this.sendUpload(held);
  }

  private sendUpload(chunk: Buffer): void {
    this.uploadsSending++;
    this.socket.pause();
    this.upload.push(chunk, () => {
      this.uploadsSending--;
      this.resumeDevice();
    });
  }

  private onDeviceEnd(): void {
    this.deviceEnded = true;
    if (this.requestLine === null && this.heldRequest.length > 0) {
      this.requestLine = this.requestHead;
      this.sendHeldRequest();
    }
    if (this.upload.empty) this.push(null);
  }

  private readRequestLine(chunk: Buffer): boolean {
    this.requestHead += chunk.toString("latin1", 0, MAX_REQUEST_LINE - this.requestHead.length);
    const end = this.requestHead.indexOf("\r\n");
    if (end === -1 && this.requestHead.length < MAX_REQUEST_LINE) return false;
    this.requestLine = end === -1 ? this.requestHead : this.requestHead.slice(0, end);
    this.requestHead = "";
    return true;
  }

  private whenDeviceHasRoom(callback: () => void): void {
    if (this.download.queuedBytes >= MAX_QUEUED_BYTES) this.writerWaiting = callback;
    else if (this.socket.writableNeedDrain) this.socket.once("drain", callback);
    else callback();
  }

  private deliverToDevice(chunk: Buffer): void {
    this.socket.write(chunk);
    const waiting = this.writerWaiting;
    if (waiting && this.download.queuedBytes < MAX_QUEUED_BYTES / 2) {
      this.writerWaiting = null;
      this.whenDeviceHasRoom(waiting);
    }
  }

  private resumeDevice(): void {
    const hasRoom = this.upload.queuedBytes < MAX_QUEUED_BYTES / 2;
    if (this.uploadsSending === 0 && !this.proxyFull && hasRoom) this.socket.resume();
  }

  private deliverToProxy(chunk: Buffer): void {
    if (this.push(chunk)) {
      this.resumeDevice();
      return;
    }
    this.proxyFull = true;
    this.socket.pause();
  }

  private onUploadDrain(): void {
    if (this.deviceEnded) this.push(null);
  }

  private onDownloadDrain(): void {
    const final = this.pendingFinal;
    this.pendingFinal = null;
    final?.();
  }
}

/** Shapes every device connection it attaches, all sharing one link. */
export class ShapedLink {
  private readonly links = { upload: new LinkDirection(), download: new LinkDirection() };
  private readonly sockets = new Set<ShapedSocket>();

  attach(socket: net.Socket, isBypassed: (requestLine: string) => boolean): Duplex {
    const shaped = new ShapedSocket(socket, this.links, isBypassed);
    this.sockets.add(shaped);
    socket.on("close", () => {
      this.sockets.delete(shaped);
      this.reclaimWaiting();
    });
    return shaped;
  }

  private reclaimWaiting(): void {
    const now = performance.now();
    for (const shaped of this.sockets) shaped.releaseWaiting(now);
    for (const shaped of this.sockets) shaped.repaceWaiting(now);
  }

  setConditions(conditions: NetworkConditions | null): void {
    const { upload, download } = this.links;
    const uploadChanged = upload.configure(conditions?.uploadKbps, conditions?.latencyMs);
    const downloadChanged = download.configure(conditions?.downloadKbps, conditions?.latencyMs);
    if (!uploadChanged && !downloadChanged) return;
    for (const shaped of this.sockets) {
      if (uploadChanged) shaped.repace("upload");
      if (downloadChanged) shaped.repace("download");
    }
  }
}
