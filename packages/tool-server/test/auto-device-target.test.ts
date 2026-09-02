import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { z } from "zod";
import { Registry, type ToolCapability } from "@argent/registry";
import { createHttpApp } from "../src/http";
import { createRegistry } from "../src/utils/setup-registry";
import { deviceEntryId, isBooted } from "../src/utils/booted-devices";
import { AUTO_DEVICE_TARGET_PROBE } from "../src/utils/auto-device-target";
import { DependencyMissingError } from "../src/utils/check-deps";

const IPHONE = "6DBF83B4-0000-4000-8000-00000000AAAA";
const ANDROID = "emulator-5554";
const CHROMIUM = "chromium-cdp-9222";
const REMOTE = "remote:6DBF83B4-0000-4000-8000-00000000BBBB";

type Listed = { platform: string; state?: string; udid?: string; serial?: string; id?: string };

const iphone = (state = "Booted"): Listed => ({ platform: "ios", state, udid: IPHONE });
const remoteIphone = (state = "Booted"): Listed => ({
  platform: "ios-remote",
  state,
  udid: REMOTE,
});
const android = (state = "device"): Listed => ({ platform: "android", state, serial: ANDROID });
const chromium = (): Listed => ({ platform: "chromium", state: "Running", id: CHROMIUM });

const IOS_ONLY: ToolCapability = { apple: { simulator: true } };
const CHROMIUM_ONLY: ToolCapability = { chromium: { app: true } };

/**
 * A registry holding a stub `list-devices` plus one device tool whose schema
 * requires `udid` — the shape the whole feature keys off.
 */
function harness(
  devices: Listed[],
  capability?: ToolCapability,
  options?: Parameters<typeof createHttpApp>[1]
) {
  const execute = vi.fn(async (_s: unknown, params: { udid: string }) => ({ saw: params.udid }));
  // A spy, not a literal: whether the enumeration ran at all is the invariant the
  // explicit-udid path exists to protect.
  const listDevices = vi.fn(async () => ({ devices }));
  const registry = new Registry();
  registry.registerTool({
    id: "list-devices",
    zodSchema: z.object({}),
    services: () => ({}),
    execute: listDevices,
  });
  registry.registerTool({
    id: "poke",
    capability,
    zodSchema: z.object({ udid: z.string().describe("Target device id.") }),
    services: () => ({}),
    execute,
  });
  return { registry, execute, listDevices, app: createHttpApp(registry, options).app };
}

describe("the advertised schema relaxes `udid` while the zod schema keeps it", () => {
  it("drops udid from the advertised required list and says why", () => {
    const { registry } = harness([]);
    const schema = registry.getTool("poke")!.inputSchema as {
      required?: string[];
      properties: { udid: { description: string } };
    };
    expect(schema.required ?? []).not.toContain("udid");
    expect(schema.properties.udid.description).toContain("Target device id.");
    // Eight real descriptions end without a terminator, so the join has to supply
    // one rather than run the hint on from the last word.
    const unpunctuated = new Registry();
    unpunctuated.registerTool({
      id: "blunt",
      zodSchema: z.object({ udid: z.string().describe("iOS Simulator UDID") }),
      services: () => ({}),
      async execute() {
        return {};
      },
    });
    expect(
      (
        unpunctuated.getTool("blunt")!.inputSchema as {
          properties: { udid: { description: string } };
        }
      ).properties.udid.description
    ).toMatch(/^iOS Simulator UDID\. Optional/);
    expect(schema.properties.udid.description).toMatch(/the one booted device this tool supports/);
  });

  it("still refuses a udid-less call that does not come through HTTP", async () => {
    // Flows and run-sequence dispatch through invokeTool, where the zod schema
    // is authoritative. Relaxing them too would let a recorded step replay
    // against whatever happens to be booted.
    const { registry } = harness([iphone()]);
    await expect(registry.invokeTool("poke", {})).rejects.toThrow(/Invalid params/);
  });

  it("leaves a tool whose udid is already optional untouched", () => {
    // `boot-device` is the real case: no udid there means "boot by avdName",
    // so filling one in would silently change which call was made.
    const registry = new Registry();
    registry.registerTool({
      id: "opt",
      zodSchema: z.object({ udid: z.string().optional().describe("Target device id.") }),
      services: () => ({}),
      async execute() {
        return {};
      },
    });
    const def = registry.getTool("opt")!;
    expect(def.autoDeviceTargetParam).toBeUndefined();
    expect(
      (def.inputSchema as { properties: { udid: { description: string } } }).properties.udid
        .description
    ).toBe("Target device id.");
  });

  it("leaves a tool that declares no udid untouched", () => {
    const registry = new Registry();
    registry.registerTool({
      id: "none",
      zodSchema: z.object({ path: z.string() }),
      services: () => ({}),
      async execute() {
        return {};
      },
    });
    expect(registry.getTool("none")!.autoDeviceTargetParam).toBeUndefined();
    expect((registry.getTool("none")!.inputSchema as { required: string[] }).required).toEqual([
      "path",
    ]);
  });
});

describe("the HTTP dispatcher fills in the single booted device", () => {
  it("resolves it and hands it to execute", async () => {
    const { app, execute } = harness([iphone()]);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(200);
    expect(res.body.data.saw).toBe(IPHONE);
    expect(execute.mock.calls[0]![1].udid).toBe(IPHONE);
  });

  it("leaves an explicitly passed udid alone", async () => {
    const { app, execute } = harness([iphone(), android()]);
    const res = await request(app).post("/tools/poke").send({ udid: ANDROID });
    expect(res.status).toBe(200);
    expect(execute.mock.calls[0]![1].udid).toBe(ANDROID);
  });

  it("refuses when nothing is booted, listing what it saw", async () => {
    const { app, execute } = harness([iphone("Shutdown")]);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No booted device runs `poke`/);
    // The listing is the point: it replaces the `list-devices` call the agent
    // would otherwise have had to make to recover.
    expect(res.body.error).toContain(IPHONE);
    expect(res.body.error).toContain("Shutdown");
    expect(execute).not.toHaveBeenCalled();
  });

  it("refuses an ambiguous pool rather than picking one, naming the candidates", async () => {
    // The shut-down sim is in `devices` but not in `candidates`, so this also
    // pins that the ambiguity listing enumerates the candidates rather than
    // everything `list-devices` returned.
    const { app, execute } = harness([iphone(), android(), iphone("Shutdown")]);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2 booted devices match the platforms `poke` declares/);
    expect(res.body.error).toContain(IPHONE);
    expect(res.body.error).toContain(ANDROID);
    expect(res.body.error).not.toContain("Shutdown");
    expect(execute).not.toHaveBeenCalled();
  });

  it("narrows a mixed pool by the tool's own capability", async () => {
    // An iPhone and a Chromium app are both booted, which is ambiguous in the
    // raw — but only one of them is a candidate for a chromium-only tool.
    const { app, execute } = harness([iphone(), chromium()], CHROMIUM_ONLY);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(200);
    expect(execute.mock.calls[0]![1].udid).toBe(CHROMIUM);
  });

  it("refuses when the only booted device is one the tool cannot drive", async () => {
    const { app } = harness([chromium()], IOS_ONLY);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No booted device runs `poke`/);
  });

  it("does not fill in for a tool whose udid is already optional", async () => {
    const registry = new Registry();
    const execute = vi.fn(async (_s: unknown, params: { udid?: string }) => ({ saw: params.udid }));
    registry.registerTool({
      id: "list-devices",
      zodSchema: z.object({}),
      services: () => ({}),
      async execute() {
        return { devices: [iphone()] };
      },
    });
    registry.registerTool({
      id: "opt",
      zodSchema: z.object({ udid: z.string().optional() }),
      services: () => ({}),
      execute,
    });
    const res = await request(createHttpApp(registry).app).post("/tools/opt").send({});
    expect(res.status).toBe(200);
    expect(res.body.data.saw).toBeUndefined();
  });
});

/**
 * The set is derived from each schema rather than declared per tool, so this is
 * where a tool joining or leaving it becomes a reviewed change instead of a
 * silent one. Update the list in the same commit that changes a schema.
 */
describe("which registered tools auto-target", () => {
  const EXPECTED = [
    "await-screen-idle",
    "await-ui-element",
    "button",
    "chromium-cookies",
    "chromium-storage",
    "chromium-tabs",
    "describe",
    "gesture-custom",
    "gesture-drag",
    "gesture-pinch",
    "gesture-rotate",
    "gesture-scroll",
    "gesture-swipe",
    "gesture-tap",
    "keyboard",
    "launch-app",
    "native-describe-screen",
    "native-devtools-status",
    "native-find-views",
    "native-full-hierarchy",
    "native-network-logs",
    "native-user-interactable-view-at-point",
    "native-view-at-point",
    "open-url",
    "paste",
    "reinstall-app",
    "restart-app",
    "rotate",
    "run-sequence",
    "screen-recording-start",
    "screen-recording-stop",
    "screenshot",
    "screenshot-diff",
    "settings-permissions",
    "shake",
    "stop-simulator-server",
    "tv-remote",
  ];

  function registeredTools() {
    const registry = createRegistry();
    const ids = registry.getSnapshot().tools;
    return ids.map((id) => registry.getTool(id)!);
  }

  it("is exactly the pinned list", () => {
    const auto = registeredTools()
      .filter((def) => def.autoDeviceTargetParam !== undefined)
      .map((def) => def.id)
      .sort();
    expect(auto).toEqual(EXPECTED);
  });

  it("leaves no tool still demanding a udid it could have resolved", () => {
    // The point of deriving the set: a tool cannot end up half-in, advertising
    // `udid` as required while its 36 siblings do not.
    const stillRequired = registeredTools()
      .filter((def) =>
        ((def.inputSchema as { required?: string[] })?.required ?? []).includes("udid")
      )
      .map((def) => def.id);
    expect(stillRequired).toEqual([]);
  });

  it("has no other param whose name the near-miss guard would catch", () => {
    // http.ts refuses to auto-target a call carrying a key that merely looks
    // like `udid`, so a tool introducing one would lose auto-targeting — loudly,
    // but for a reason nobody would think to look for.
    const collisions = registeredTools().flatMap((def) =>
      Object.keys((def.inputSchema as { properties?: object })?.properties ?? {})
        .filter(
          (k) =>
            k !== "udid" &&
            k
              .toLowerCase()
              .replace(/[^a-z]/g, "")
              .includes("udid")
        )
        .map((k) => `${def.id}.${k}`)
    );
    expect(collisions).toEqual([]);
  });

  it("never touches a `device_id` tool", () => {
    // On the debugger/profiler tools that spelling is a Metro/CDP LOGICAL id,
    // which `list-devices` does not report and a UDID cannot stand in for.
    const deviceIdTools = registeredTools().filter((def) =>
      Object.hasOwn((def.inputSchema as { properties?: object })?.properties ?? {}, "device_id")
    );
    expect(deviceIdTools.length).toBeGreaterThan(0);
    expect(deviceIdTools.filter((def) => def.autoDeviceTargetParam !== undefined)).toEqual([]);
  });
});

describe("the caller keeps a device id they can act on", () => {
  it("echoes the resolved device, so a client that scopes work by it still has one", async () => {
    // The MCP adapter keys its artifact directory and its post-interaction
    // screenshot/describe off the device, reading only the args it sent.
    const { app } = harness([iphone()]);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(200);
    expect(res.body.device).toBe(IPHONE);
  });

  it("echoes nothing when the caller named the device itself", async () => {
    const { app } = harness([iphone()]);
    const res = await request(app).post("/tools/poke").send({ udid: IPHONE });
    expect(res.status).toBe(200);
    expect(res.body.device).toBeUndefined();
  });
});

describe("a call that named a device is never re-targeted", () => {
  // Zod strips unknown keys, so before auto-targeting each of these was a
  // "udid is required" 400. Resolving a different device instead would run the
  // action somewhere the caller never mentioned and report success.
  it.each(["UDID", "udids", "device_udid", "deviceUdid"])(
    "refuses rather than resolving past a `%s` key",
    async (key) => {
      const { app, execute } = harness([iphone()]);
      const res = await request(app)
        .post("/tools/poke")
        .send({ [key]: ANDROID });
      expect(res.status).toBe(400);
      expect(execute).not.toHaveBeenCalled();
      expect(res.body.message).toContain(key);
    }
  );

  it("refuses when a body was sent but no parser claimed it", async () => {
    // What `curl -d '{"udid":"..."}'` sends: `-d` defaults to form-urlencoded,
    // so the args never become `req.body` and the id is already gone by here.
    const { app, execute } = harness([iphone()]);
    const res = await request(app)
      .post("/tools/poke")
      .set("Content-Type", "application/x-www-form-urlencoded")
      .send(JSON.stringify({ udid: ANDROID }));
    expect(res.status).toBe(400);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["null", null],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("resolves for a udid of %s, which names no device", async (_label, value) => {
    // A client with a required-shaped field spells "absent" this way; `""`
    // otherwise classifies as an Android serial and reaches `adb -s ''`.
    const { app, execute } = harness([iphone()]);
    const res = await request(app).post("/tools/poke").send({ udid: value });
    expect(res.status).toBe(200);
    expect(execute.mock.calls[0]![1].udid).toBe(IPHONE);
  });

  it("still resolves for a genuinely empty request", async () => {
    const { app, execute } = harness([iphone()]);
    const res = await request(app).post("/tools/poke");
    expect(res.status).toBe(200);
    expect(execute.mock.calls[0]![1].udid).toBe(IPHONE);
  });
});

describe("the refusal names what it passed over", () => {
  it("prints a remote simulator's id, and says why it was not chosen", async () => {
    // `isBooted` reports a remote sim as not-booted, so without the note the
    // listing shows `Booted` directly under "no booted device".
    const { app } = harness([remoteIphone()]);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toContain(REMOTE);
    expect(res.body.error).not.toContain("?");
    expect(res.body.error).toMatch(/remote simulator is never resolved automatically/);
  });

  it("claims only that the candidates match the platforms the tool declares", async () => {
    // `capability` sees platform and kind, never form factor: it cannot tell an
    // Apple TV simulator from an iPhone, so "supports this tool" would overstate it.
    const { app } = harness([iphone(), android()]);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.body.error).toMatch(/match the platforms `poke` declares/);
    expect(res.body.error).not.toMatch(/devices support/);
  });
});

describe("the advertised schema stays well-formed", () => {
  it("omits `required` entirely when udid was the only entry", () => {
    // The generator omits an empty `required`, and draft-04 validators reject
    // `[]`, so the relaxed copy must not introduce one.
    const { registry } = harness([]);
    expect(registry.getTool("poke")!.inputSchema).not.toHaveProperty("required");
  });

  it("keeps the other required args when there are some", () => {
    const registry = new Registry();
    registry.registerTool({
      id: "two",
      zodSchema: z.object({ udid: z.string(), x: z.number() }),
      services: () => ({}),
      async execute() {
        return {};
      },
    });
    expect((registry.getTool("two")!.inputSchema as { required: string[] }).required).toEqual([
      "x",
    ]);
  });

  it("leaves no registered tool advertising an empty required list", () => {
    const registry = createRegistry();
    const empty = registry
      .getSnapshot()
      .tools.map((id) => registry.getTool(id)!)
      .filter((def) => {
        const req = (def.inputSchema as { required?: unknown })?.required;
        return Array.isArray(req) && req.length === 0;
      })
      .map((def) => def.id);
    expect(empty).toEqual([]);
  });
});

describe("what counts as booted, per platform", () => {
  // `isBooted` is the one predicate both resolvers share, and its states were
  // reachable only indirectly. A table so a platform's vocabulary cannot drift.
  it.each([
    ["ios", "Booted", true],
    ["ios", "Shutdown", false],
    ["ios", "Booting", false],
    ["android", "device", true],
    ["android", "offline", false],
    ["android", "unauthorized", false],
    ["vega", "running", true],
    ["vega", "device", true],
    ["vega", "stopped", false],
    ["chromium", "Running", true],
    ["ios-remote", "Booted", false],
  ])("%s in state %s", (platform, state, expected) => {
    expect(isBooted({ platform, state } as Parameters<typeof isBooted>[0])).toBe(expected);
  });

  it("reads a platform it does not know as not-booted", () => {
    // The fallback is what keeps an unrecognised entry from being auto-selected
    // or bound into a flow.
    expect(isBooted({ platform: "holo", state: "device" } as never)).toBe(false);
  });

  it("reads each platform's id off the key that platform actually uses", () => {
    expect(deviceEntryId({ platform: "ios", udid: IPHONE })).toBe(IPHONE);
    expect(deviceEntryId({ platform: "ios-remote", udid: REMOTE })).toBe(REMOTE);
    expect(deviceEntryId({ platform: "chromium", id: CHROMIUM })).toBe(CHROMIUM);
    expect(deviceEntryId({ platform: "android", serial: ANDROID })).toBe(ANDROID);
    expect(deviceEntryId({ platform: "vega", serial: "amazon-1" })).toBe("amazon-1");
  });
});

describe("every platform resolves, not just the two the mixed-pool cases use", () => {
  it.each([
    ["android", android(), ANDROID],
    [
      "vega",
      { platform: "vega", state: "running", serial: "amazon-4a27df03c9" } as Listed,
      "amazon-4a27df03c9",
    ],
    ["chromium", chromium(), CHROMIUM],
  ])("resolves a lone booted %s device", async (_p, entry, id) => {
    const { app, execute } = harness([entry]);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(200);
    expect(execute.mock.calls[0]![1].udid).toBe(id);
  });

  it("skips an entry that carries no id for its platform", async () => {
    // A vega row with no serial renders as `?`; it must not be resolved to one.
    const { app } = harness([{ platform: "vega", state: "running" } as Listed]);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No booted device runs `poke`/);
  });
});

describe("naming the device keeps the call off the enumeration", () => {
  it("does not list devices at all when udid was passed", async () => {
    // The whole point of the guard: `list-devices` fans out to simctl/adb/vega
    // and dominates the latency of a call that never needed it.
    const { app, listDevices } = harness([iphone()]);
    const res = await request(app).post("/tools/poke").send({ udid: IPHONE });
    expect(res.status).toBe(200);
    expect(listDevices).not.toHaveBeenCalled();
  });

  it("lists exactly once when it has to resolve", async () => {
    const { app, listDevices } = harness([iphone()]);
    await request(app).post("/tools/poke").send({});
    expect(listDevices).toHaveBeenCalledTimes(1);
  });
});

describe("an unresolvable target is reported to telemetry", () => {
  it("records the refusal under its own failure stage", async () => {
    const recordFailure = vi.fn();
    const { app } = harness([iphone("Shutdown")], undefined, { recordFailure });
    await request(app).post("/tools/poke").send({});
    expect(recordFailure).toHaveBeenCalledTimes(1);
    expect(recordFailure.mock.calls[0]![0]).toBe("poke");
    expect(recordFailure.mock.calls[0]![2]).toMatchObject({
      error_code: "HTTP_AUTO_DEVICE_TARGET_UNRESOLVED",
      failure_stage: "http_auto_device_target",
      failure_area: "http",
      error_kind: "validation",
    });
  });
});

describe("the enumeration is attributed to the request that caused it", () => {
  // It is a real `list-devices` invocation - it emits its own invoke/complete
  // pair - so without the recorder every device-less call adds an anonymous
  // `list-devices` to telemetry, with none of the request's AI-client context.
  it("registers the child invocation under the caller's own metadata", async () => {
    const recordInvocation = vi.fn((_id: string, _meta: unknown) => vi.fn());
    const { app, execute } = harness([iphone()], undefined, { recordInvocation });
    await request(app).post("/tools/poke").set("x-argent-ai-client", "claude_code").send({});
    expect(execute).toHaveBeenCalledTimes(1);
    // Two: the request's own invocation and the enumeration it made.
    expect(recordInvocation).toHaveBeenCalledTimes(2);
    for (const [, meta] of recordInvocation.mock.calls) {
      expect(meta).toMatchObject({ ai_client: "claude_code" });
    }
  });

  it("releases the child registration once the enumeration is done", async () => {
    const release = vi.fn();
    const recordInvocation = vi.fn(() => release);
    const { app } = harness([iphone()], undefined, { recordInvocation });
    await request(app).post("/tools/poke").set("x-argent-ai-client", "claude_code").send({});
    // Both registrations: the request's own and the enumeration's.
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("records nothing extra when the request carried no attribution", async () => {
    const recordInvocation = vi.fn(() => vi.fn());
    const { app } = harness([iphone()], undefined, { recordInvocation });
    await request(app).post("/tools/poke").send({});
    expect(recordInvocation).not.toHaveBeenCalled();
  });
});

describe("an unresolvable device is refused the way a bad param is", () => {
  // Same three fields as a schema rejection: prose in `message`, the structured
  // list in `issues`, that same list as JSON in `error` for a CLI released
  // before `issues` existed. Without it `argent run` drops to a generic runtime
  // failure and loses exit 2, the help block and the `--json` object.
  it.each([
    ["nothing booted", [] as Listed[]],
    ["two booted", [iphone(), android()]],
  ])("carries prose, issues and a parseable error for %s", async (_label, devices) => {
    const { app } = harness(devices);
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toBe(res.body.issues[0].message);
    expect(res.body.issues).toEqual([
      { code: "custom", path: ["udid"], message: expect.any(String) },
    ]);
    expect(JSON.parse(res.body.error)).toEqual(res.body.issues);
  });

  it("attributes the failure to the device param in telemetry", async () => {
    const recordFailure = vi.fn();
    const { app } = harness([], undefined, { recordFailure });
    await request(app).post("/tools/poke").send({});
    expect(recordFailure.mock.calls[0]![1]).toMatchObject({ invalid_params: ["udid"] });
  });
});

describe("the enumeration can fail on its own account", () => {
  // `list-devices` shells xcrun / adb / vega. Left to throw, it reaches
  // express's default handler and answers text/html with a stack trace and
  // absolute paths, which the client reads as a bare "500" with no cause.
  function failingHarness(err: Error, options?: Parameters<typeof createHttpApp>[1]) {
    const registry = new Registry();
    registry.registerTool({
      id: "list-devices",
      zodSchema: z.object({}),
      services: () => ({}),
      execute: async () => {
        throw err;
      },
    });
    registry.registerTool({
      id: "poke",
      zodSchema: z.object({ udid: z.string().describe("Target device id.") }),
      services: () => ({}),
      async execute() {
        return {};
      },
    });
    return createHttpApp(registry, options).app;
  }

  it("answers JSON with the cause, not an HTML stack trace", async () => {
    const app = failingHarness(new Error("adb: command not found"));
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(500);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(JSON.stringify(res.body)).toContain("adb: command not found");
    expect(JSON.stringify(res.body)).not.toContain("at Registry.invokeTool");
  });

  it("reports a missing dependency as 424 with what is missing", async () => {
    const app = failingHarness(
      new DependencyMissingError(
        [{ name: "adb", hint: "install platform-tools" } as never],
        "adb is missing"
      )
    );
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(424);
    expect(res.body.missing).toHaveLength(1);
  });

  it("buckets it as a device-resolution fault, not a validation one", async () => {
    const recordFailure = vi.fn();
    const app = failingHarness(new Error("simctl exploded"), { recordFailure });
    await request(app).post("/tools/poke").send({});
    expect(recordFailure.mock.calls[0]![2]).toMatchObject({
      error_code: "HTTP_DEVICE_RESOLUTION_FAILED",
      failure_stage: "http_auto_device_target",
      error_kind: "unknown",
    });
  });
});

describe("a capability refiner that throws is not read as a declined device", () => {
  it('answers the refiner\'s own fault, not "no booted device runs"', async () => {
    const { app, execute } = harness([iphone()], {
      apple: { simulator: true },
      supports: () => {
        throw new Error("refiner exploded");
      },
    });
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).toContain("refiner exploded");
    expect(JSON.stringify(res.body)).not.toContain("No booted device runs");
    expect(execute).not.toHaveBeenCalled();
  });

  it("still drops a device the refiner merely declines", async () => {
    const { app } = harness([iphone(), android()], {
      apple: { simulator: true },
      android: { emulator: true },
      supports: (device) => device.platform === "ios",
    });
    const res = await request(app).post("/tools/poke").send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ saw: IPHONE });
  });
});

describe("no registered tool advertises a run-on udid description", () => {
  it("terminates the tool's own sentence before the hint", () => {
    const registry = createRegistry();
    const runOn = registry
      .getSnapshot()
      .tools.map((id) => registry.getTool(id)!)
      .filter((def) => def.autoDeviceTargetParam !== undefined)
      .filter((def) => {
        const d = (def.inputSchema as { properties: { udid: { description: string } } }).properties
          .udid.description;
        const head = d.slice(0, d.indexOf("Optional:")).trimEnd();
        return head.length > 0 && !/[.!?:]$/.test(head);
      })
      .map((def) => def.id);
    expect(runOn).toEqual([]);
  });
});

describe("a malformed argument is reported as itself, not as an ambiguous device", () => {
  function typedHarness(devices: Listed[]) {
    const execute = vi.fn(async () => ({ ok: true }));
    const listDevices = vi.fn(async () => ({ devices }));
    const registry = new Registry();
    registry.registerTool({
      id: "list-devices",
      zodSchema: z.object({}),
      services: () => ({}),
      execute: listDevices,
    });
    registry.registerTool({
      id: "poke",
      zodSchema: z.object({ udid: z.string().describe("Target device id."), x: z.number() }),
      services: () => ({}),
      execute,
    });
    return { execute, listDevices, app: createHttpApp(registry).app };
  }

  it("names the bad param when several devices are booted", async () => {
    const { app } = typedHarness([iphone(), android()]);
    const res = await request(app).post("/tools/poke").send({ x: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("x");
    expect(res.body.message).not.toContain("ambiguous");
    expect(res.body.issues).toHaveLength(1);
    expect(res.body.issues[0].path).toEqual(["x"]);
    // The pre-fix answer. Kept as an explicit negative because it is the whole
    // defect: the caller retried with a udid to learn what was actually wrong.
    expect(res.body.error).not.toContain("ambiguous");
  });

  it("skips the device enumeration entirely when another param is wrong", async () => {
    const { app, listDevices, execute } = typedHarness([iphone(), android()]);
    await request(app).post("/tools/poke").send({ x: "nope" });
    expect(listDevices).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("still resolves when every other param is fine", async () => {
    const { app, listDevices, execute } = typedHarness([iphone()]);
    const res = await request(app).post("/tools/poke").send({ x: 1 });
    expect(res.status).toBe(200);
    expect(listDevices).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(res.body.device).toBe(IPHONE);
  });

  it("reports the unresolvable device once the other params pass", async () => {
    const { app } = typedHarness([]);
    const res = await request(app).post("/tools/poke").send({ x: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No booted device runs");
  });

  it("keeps `error` parseable as the issue array released CLIs expect", async () => {
    const { app } = typedHarness([iphone(), android()]);
    const res = await request(app).post("/tools/poke").send({ x: "nope" });
    const parsed = JSON.parse(res.body.error) as { path: string[] }[];
    expect(parsed.map((i) => i.path[0])).toEqual(["x"]);
  });

  it("reports a cross-field rule the missing device would otherwise hide", async () => {
    // zod skips object-level refinements while any field is missing, so probing
    // the raw args would find nothing here and answer "ambiguous" instead.
    const listDevices = vi.fn(async () => ({ devices: [iphone(), android()] }));
    const registry = new Registry();
    registry.registerTool({
      id: "list-devices",
      zodSchema: z.object({}),
      services: () => ({}),
      execute: listDevices,
    });
    registry.registerTool({
      id: "poke",
      zodSchema: z
        .object({
          udid: z.string().describe("Target device id."),
          text: z.string().optional(),
          key: z.string().optional(),
        })
        .refine((d) => !!d.text !== !!d.key, {
          message: "exactly one of text/key",
          path: ["text"],
        }),
      services: () => ({}),
      async execute() {
        return {};
      },
    });
    const { app } = createHttpApp(registry);
    const res = await request(app).post("/tools/poke").send({ text: "hi", key: "enter" });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("exactly one of text/key");
    expect(listDevices).not.toHaveBeenCalled();
  });

  it("buckets the probe failure as a validation failure, not a device one", async () => {
    const recordFailure = vi.fn();
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = new Registry();
    registry.registerTool({
      id: "list-devices",
      zodSchema: z.object({}),
      services: () => ({}),
      execute: async () => ({ devices: [iphone(), android()] }),
    });
    registry.registerTool({
      id: "poke",
      zodSchema: z.object({ udid: z.string().describe("Target device id."), x: z.number() }),
      services: () => ({}),
      execute,
    });
    const { app } = createHttpApp(registry, { recordFailure });
    await request(app).post("/tools/poke").send({ x: "nope" });
    expect(recordFailure.mock.calls[0]![2]).toMatchObject({
      error_code: "HTTP_ZOD_VALIDATION_FAILED",
      failure_stage: "http_zod_validation",
    });
    expect(recordFailure.mock.calls[0]![1]).toMatchObject({ invalid_params: ["x"] });
  });
});

describe("every auto-targeted tool accepts the probe device id", () => {
  it("leaves the probe substitution invisible in the reported issues", () => {
    // The probe is substituted, not filtered out of the result, so a tool that
    // constrained its device arg beyond `z.string()` would answer every
    // device-less call with an error about a value the caller never sent.
    const registry = createRegistry();
    const rejecting = registry
      .getSnapshot()
      .tools.map((id) => registry.getTool(id)!)
      .filter((def) => def.autoDeviceTargetParam !== undefined && def.zodSchema !== undefined)
      .filter((def) => {
        const field = (def.zodSchema as unknown as { shape?: Record<string, z.ZodTypeAny> })
          .shape?.[def.autoDeviceTargetParam!];
        return field !== undefined && !field.safeParse(AUTO_DEVICE_TARGET_PROBE).success;
      })
      .map((def) => def.id);
    expect(rejecting).toEqual([]);
  });
});
