import { randomUUID } from "node:crypto";
import { SimulatorServerProcess } from "./SimulatorServerProcess";
import { Session } from "../types/index";

export interface SessionCreateOptions {
  token?: string;
  replay: boolean;
  showTouches: boolean;
}

interface InternalSession {
  id: string;
  udid: string;
  process: SimulatorServerProcess;
  createdAt: Date;
}

export class SessionManager {
  private sessions = new Map<string, InternalSession>();

  async create(udid: string, options: SessionCreateOptions): Promise<Session> {
    const id = randomUUID();
    const proc = new SimulatorServerProcess({ udid, ...options });

    // Will throw if simulator-server fails to start or times out
    await proc.waitForReady();

    const internal: InternalSession = { id, udid, process: proc, createdAt: new Date() };
    this.sessions.set(id, internal);

    // Remove from map automatically when process dies
    proc.on("exit", () => {
      // Keep the entry so clients can query the "dead" state, but mark it
      // The state getter on the process already reflects "dead"
    });

    return this.toPublic(internal);
  }

  get(id: string): InternalSession | undefined {
    return this.sessions.get(id);
  }

  list(): Session[] {
    return Array.from(this.sessions.values()).map((s) => this.toPublic(s));
  }

  destroy(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.process.kill();
    this.sessions.delete(id);
    return true;
  }

  destroyAll(): void {
    for (const session of this.sessions.values()) {
      session.process.kill();
    }
    this.sessions.clear();
  }

  toPublic(session: InternalSession): Session {
    return {
      id: session.id,
      udid: session.udid,
      streamUrl: session.process.streamUrl,
      state: session.process.state,
      createdAt: session.createdAt.toISOString(),
      settings: session.process.currentSettings,
    };
  }
}
