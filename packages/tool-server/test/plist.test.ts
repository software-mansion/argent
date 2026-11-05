import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPlist, parsePlist } from "../src/utils/plist";

// What `plutil -convert binary1` made of test/fixtures/info-binary.plist's source.
const EXPECTED = {
  CFBundleIdentifier: "com.example.App",
  CFBundleDisplayName: "Zażółć & app",
  DTPlatformVersion: 18,
  Big: 5000000000,
  Scale: 2.5,
  LSRequiresIPhoneOS: true,
  UIStatusBarHidden: false,
  UIDeviceFamily: [1, 2],
  Nested: { Data: Buffer.from([0, 1, 2]), When: new Date("2026-10-30T10:00:00Z") },
};

describe("parsePlist", () => {
  it("reads a binary plist as Xcode writes an app's Info.plist", () => {
    const bytes = readFileSync(path.join(__dirname, "fixtures", "info-binary.plist"));
    expect(parsePlist(bytes)).toEqual(EXPECTED);
  });

  it("round-trips through the XML writer, entities and all", () => {
    const xml = buildPlist(EXPECTED);
    expect(xml).toContain("<!DOCTYPE plist");
    expect(xml).toContain("Zażółć &amp; app");
    expect(parsePlist(Buffer.from(xml))).toEqual(EXPECTED);
  });

  it("reads xcodebuild-style XML with indentation and empty containers", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>__xctestrun_metadata__</key>
	<dict>
		<key>FormatVersion</key>
		<integer>1</integer>
	</dict>
	<key>Runner</key>
	<dict>
		<key>CommandLineArguments</key>
		<array/>
		<key>TestHostPath</key>
		<string>__TESTROOT__/Debug-iphoneos/Runner.app</string>
		<key>Spaces</key>
		<string>  kept  </string>
	</dict>
</dict>
</plist>`;
    expect(parsePlist(Buffer.from(xml))).toEqual({
      __xctestrun_metadata__: { FormatVersion: 1 },
      Runner: {
        CommandLineArguments: [],
        TestHostPath: "__TESTROOT__/Debug-iphoneos/Runner.app",
        Spaces: "  kept  ",
      },
    });
  });

  it("rejects what is not a property list", () => {
    expect(() => parsePlist(Buffer.from("<html></html>"))).toThrow(/not a property list/);
    expect(() => parsePlist(Buffer.from("bplist00 truncated"))).toThrow();
  });
});
