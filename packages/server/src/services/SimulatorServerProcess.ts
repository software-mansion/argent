import { spawn, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import * as path from "node:path";
import * as readline from "node:readline";
import { DeviceOrientation, TouchType, ButtonName, ReplayResult, VideoResult } from "../types/index";

// Binary lives in the project root, two levels up from dist/services/
const BINARY_PATH = path.join(__dirname, "..", "..", "simulator-server");
const BINARY_DIR = path.join(__dirname, "..", "..");

const MEDIA_TIMEOUT_MS = 15000;

interface PendingPromise<T> {
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
}

function withTimeout<T>(
  timeoutMs: number,
  register: (resolve: (v: T) => void, reject: (e: Error) => void) => void,
  onTimeout: () => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onTimeout();
      reject(new Error(`Operation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    register(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

interface FpsReport {
  fps: number;
  received: number;
  dropped: number;
  timestamp: number;
}

export interface SimulatorServerOptions {
  udid: string;
  token?: string;
  replay: boolean;
  showTouches: boolean;
}

export class SimulatorServerProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private _streamUrl = "";
  private _state: "starting" | "ready" | "dead" = "starting";
  private _tokenState: "no_token" | "validating" | "valid" | "invalid";

  private readyResolve: ((url: string) => void) | null = null;
  private readyReject: ((err: Error) => void) | null = null;
  private readyPromise: Promise<string>;

  private pendingScreenshots = new Map<string, PendingPromise<VideoResult>>();
  private pendingVideos = new Map<string, PendingPromise<VideoResult>>();

  // Replay collects multiple results, one per requested duration
  private pendingReplayResults: ReplayResult[] = [];
  private pendingReplayExpected = 0;
  private pendingReplayPromise: PendingPromise<ReplayResult[]> | null = null;

  private options: SimulatorServerOptions;

  constructor(options: SimulatorServerOptions) {
    super();
    this.options = { ...options };
    this._tokenState = options.token ? "validating" : "no_token";
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.spawn();
  }

  private spawn(): void {
    const args = ["ios", "--id", this.options.udid];
    if (this.options.token) {
      args.push("-t", this.options.token);
    }

    this.proc = spawn(BINARY_PATH, args, {
      cwd: BINARY_DIR,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.rl = readline.createInterface({ input: this.proc.stdout! });
    this.rl.on("line", (line) => this.handleLine(line.trim()));

    this.proc.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(`[sim ${this.options.udid.slice(0, 8)}] ${data}`);
    });

    this.proc.on("exit", (code) => {
      this._state = "dead";
      this.emit("exit", code);
      if (this.readyReject) {
        this.readyReject(
          new Error(`simulator-server exited with code ${code} before becoming ready`)
        );
        this.readyReject = null;
      }
    });
  }

  private handleLine(line: string): void {
    if (line.startsWith("stream_ready ")) {
      const match = line.match(/(http:\/\/[^ ]+stream\.mjpeg)/);
      if (match) {
        this._streamUrl = match[1];
        this._state = "ready";
        this.sendCommand(`pointer show ${this.options.showTouches ? "true" : "false"}\n`);
        if (this.options.replay) {
          this.sendCommand("video replay start -m -b 50\n");
        }
        if (this.readyResolve) {
          this.readyResolve(this._streamUrl);
          this.readyResolve = null;
        }
      }
      return;
    }

    if (line.startsWith("fps_report ")) {
      const match = line.match(/fps_report\s+(\{.*\})/);
      if (match) {
        try {
          const data: FpsReport = JSON.parse(match[1]);
          this.emit("fps_report", data);
        } catch {
          // malformed, skip
        }
      }
      return;
    }

    const videoReadyMatch = line.match(/^video_ready (\S+) (\S+) (\S+)/);
    if (videoReadyMatch) {
      const [, id, url, filePath] = videoReadyMatch as [string, string, string, string];
      const ext = path.extname(filePath);
      const durationMatch = filePath.match(new RegExp(`-([0-9]+)s\\${ext}$`));
      const durationSecs: number | "full" = durationMatch
        ? parseInt(durationMatch[1]!, 10)
        : "full";

      const result: ReplayResult = { durationSecs, url, filePath };

      if (id === "replay") {
        this.handleReplayReady(result);
      } else {
        const pending = this.pendingVideos.get(id);
        if (pending) {
          this.pendingVideos.delete(id);
          pending.resolve(result);
        }
        this.emit("video_ready", { id, ...result });
      }
      return;
    }

    const videoErrorMatch = line.match(/^video_error (\S+) (.*)/);
    if (videoErrorMatch) {
      const [, id, errorMessage] = videoErrorMatch as [string, string, string];
      if (id === "replay") {
        if (this.pendingReplayPromise) {
          this.pendingReplayPromise.reject(new Error(errorMessage));
          this.pendingReplayPromise = null;
          this.pendingReplayResults = [];
        }
      } else {
        const pending = this.pendingVideos.get(id);
        if (pending) {
          this.pendingVideos.delete(id);
          pending.reject(new Error(errorMessage));
        }
      }
      this.emit("video_error", { id, errorMessage });
      return;
    }

    const screenshotReadyMatch = line.match(/^screenshot_ready (\S+) (\S+) (\S+)/);
    if (screenshotReadyMatch) {
      const [, id, url, filePath] = screenshotReadyMatch as [string, string, string, string];
      const pending = this.pendingScreenshots.get(id);
      if (pending) {
        this.pendingScreenshots.delete(id);
        pending.resolve({ url, filePath, durationSecs: "full" });
      }
      this.emit("screenshot_ready", { id, url, filePath });
      return;
    }

    const screenshotErrorMatch = line.match(/^screenshot_error (\S+) (.*)/);
    if (screenshotErrorMatch) {
      const [, id, errorMessage] = screenshotErrorMatch as [string, string, string];
      const pending = this.pendingScreenshots.get(id);
      if (pending) {
        this.pendingScreenshots.delete(id);
        pending.reject(new Error(errorMessage));
      }
      this.emit("screenshot_error", { id, errorMessage });
      return;
    }

    if (line.startsWith("token_valid ")) {
      this._tokenState = "valid";
      this.emit("token_valid", { plan: line.split(" ")[1] });
      return;
    }

    if (line.startsWith("token_invalid ")) {
      this._tokenState = "invalid";
      this.emit("token_invalid", { reason: line.split(" ").slice(1).join(" ") });
      return;
    }
  }

  private handleReplayReady(result: ReplayResult): void {
    this.pendingReplayResults.push(result);
    this.emit("video_ready", { id: "replay", ...result });
    if (this.pendingReplayResults.length >= this.pendingReplayExpected && this.pendingReplayPromise) {
      const results = [...this.pendingReplayResults];
      this.pendingReplayResults = [];
      this.pendingReplayExpected = 0;
      this.pendingReplayPromise.resolve(results);
      this.pendingReplayPromise = null;
    }
  }

  private sendCommand(cmd: string): void {
    if (this.proc?.stdin && !this.proc.stdin.destroyed) {
      this.proc.stdin.write(cmd);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  waitForReady(timeoutMs = 30000): Promise<string> {
    const timeout = new Promise<string>((_, reject) =>
      setTimeout(
        () => reject(new Error("Timed out waiting for simulator-server to become ready")),
        timeoutMs
      )
    );
    return Promise.race([this.readyPromise, timeout]);
  }

  screenshot(rotation?: DeviceOrientation): Promise<{ url: string; filePath: string }> {
    const id = crypto.randomUUID();
    const rotArg = rotation ? ` -r ${rotation}` : "";
    return withTimeout<{ url: string; filePath: string }>(
      MEDIA_TIMEOUT_MS,
      (resolve, reject) => {
        this.pendingScreenshots.set(id, {
          resolve: (r) => resolve({ url: r.url, filePath: r.filePath }),
          reject,
        });
        this.sendCommand(`screenshot ${id}${rotArg}\n`);
      },
      () => this.pendingScreenshots.delete(id)
    );
  }

  startRecording(): void {
    this.sendCommand("video recording start -b 2000\n");
  }

  stopAndSaveRecording(rotation: DeviceOrientation = "Portrait"): Promise<VideoResult> {
    return withTimeout<VideoResult>(
      MEDIA_TIMEOUT_MS,
      (resolve, reject) => {
        this.pendingVideos.set("recording", { resolve, reject });
        this.sendCommand("video recording stop\n");
        this.sendCommand(`video recording save -r ${rotation}\n`);
      },
      () => this.pendingVideos.delete("recording")
    );
  }

  saveReplay(
    rotation: DeviceOrientation = "Portrait",
    durations: number[] = [5, 10, 30]
  ): Promise<ReplayResult[]> {
    if (!this.options.replay) {
      return Promise.reject(new Error("Replay is not enabled for this session"));
    }
    return withTimeout<ReplayResult[]>(
      MEDIA_TIMEOUT_MS,
      (resolve, reject) => {
        this.pendingReplayResults = [];
        this.pendingReplayExpected = durations.length;
        this.pendingReplayPromise = { resolve, reject };
        const durationsArg = durations.map((d) => `-d ${d}`).join(" ");
        this.sendCommand(`video replay save -r ${rotation} ${durationsArg}\n`);
      },
      () => {
        this.pendingReplayPromise = null;
        this.pendingReplayResults = [];
        this.pendingReplayExpected = 0;
      }
    );
  }

  updateToken(token: string): void {
    this._tokenState = "validating";
    this.sendCommand(`token ${token}\n`);
  }

  setReplay(enabled: boolean): void {
    this.options.replay = enabled;
    if (enabled) {
      this.sendCommand("video replay start -m -b 50\n");
    } else {
      this.sendCommand("video replay stop\n");
    }
  }

  setShowTouches(enabled: boolean): void {
    this.options.showTouches = enabled;
    this.sendCommand(`pointer show ${enabled ? "true" : "false"}\n`);
  }

  touch(type: TouchType, points: Array<{ x: number; y: number }>): void {
    const coords = points.map((p) => `${p.x},${p.y}`).join(" ");
    this.sendCommand(`touch ${type} ${coords}\n`);
  }

  key(direction: "Down" | "Up", keyCode: number): void {
    this.sendCommand(`key ${direction} ${keyCode}\n`);
  }

  button(direction: "Down" | "Up", btn: ButtonName): void {
    this.sendCommand(`button ${direction} ${btn}\n`);
  }

  rotate(orientation: DeviceOrientation): void {
    this.sendCommand(`rotate ${orientation}\n`);
  }

  paste(text: string): void {
    this.sendCommand(`paste START-SIMSERVER-PASTE>>>${text}<<<END-SIMSERVER-PASTE\n`);
  }

  scroll(x: number, y: number, dx: number, dy: number): void {
    this.sendCommand(`wheel ${x},${y} --dx ${dx} --dy ${dy}\n`);
  }

  kill(): void {
    this.rl?.close();
    this.rl = null;
    if (this.proc) {
      this.proc.stdin?.end();
      this.proc.kill();
      this.proc = null;
    }
    this._state = "dead";
  }

  get streamUrl(): string {
    return this._streamUrl;
  }

  get state(): "starting" | "ready" | "dead" {
    return this._state;
  }

  get tokenState(): "no_token" | "validating" | "valid" | "invalid" {
    return this._tokenState;
  }

  get currentSettings(): { replay: boolean; showTouches: boolean } {
    return { replay: this.options.replay, showTouches: this.options.showTouches };
  }
}
