import { describe, it, expect } from "vitest";
import { TypedEventEmitter } from "../src/event-emitter";

type Events = { x: () => void };

describe("TypedEventEmitter.emit — listener set mutated during the emit", () => {
  it("still calls a listener an earlier listener detached", () => {
    const emitter = new TypedEventEmitter<Events>();
    const ran: string[] = [];

    const b = (): void => {
      ran.push("B");
    };
    const a = (): void => {
      emitter.off("x", b);
      ran.push("A");
    };

    emitter.on("x", a);
    emitter.on("x", b);
    emitter.emit("x");

    expect(ran).toEqual(["A", "B"]);
  });

  it("defers a listener an earlier listener attached to the next emit", () => {
    const emitter = new TypedEventEmitter<Events>();
    const ran: string[] = [];

    const late = (): void => {
      ran.push("LATE");
    };
    const c = (): void => {
      emitter.on("x", late);
      ran.push("C");
    };

    emitter.on("x", c);
    emitter.emit("x");
    expect(ran).toEqual(["C"]);

    emitter.emit("x");
    expect(ran).toEqual(["C", "C", "LATE"]);
  });
});
