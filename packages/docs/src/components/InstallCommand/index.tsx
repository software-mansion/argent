import React from "react";
import useIsBrowser from "@docusaurus/useIsBrowser";
import CodeBlock from "@theme/CodeBlock";
import TabItem from "@theme/TabItem";
import Tabs from "@theme/Tabs";

type Platform = "macos" | "linux";

const RELEASES = "https://github.com/software-mansion/sim-remote-releases/releases/latest/download";

const COMMANDS: Record<Platform, string> = {
  macos: `curl -fL -o sim-remote ${RELEASES}/sim-remote-aarch64-apple-darwin
chmod +x sim-remote
mkdir -p ~/.local/bin && mv sim-remote ~/.local/bin/`,
  linux: `curl -fL -o sim-remote "${RELEASES}/sim-remote-$(uname -m)-unknown-linux-gnu"
chmod +x sim-remote
mkdir -p ~/.local/bin && mv sim-remote ~/.local/bin/`,
};

/* Reads the platform from the browser. Anything that is not a Mac gets the Linux command. */
function detectPlatform(): Platform {
  return /Mac/i.test(navigator.userAgent) ? "macos" : "linux";
}

/*
 * The install command for the platform of the reader. The server renders the
 * macOS tab, and the browser switches to the detected platform after
 * hydration. The reader can still pick the other tab by hand.
 */
export default function InstallCommand(): React.ReactElement {
  /* False on the server and during hydration, so both renders agree. */
  const isBrowser = useIsBrowser();
  const value: Platform = isBrowser ? detectPlatform() : "macos";

  /* The key remounts the tabs so the detected platform becomes the default. */
  return (
    <Tabs key={value} groupId="platform" defaultValue={value}>
      <TabItem value="macos" label="macOS (Apple Silicon)">
        <CodeBlock language="bash">{COMMANDS.macos}</CodeBlock>
      </TabItem>
      <TabItem value="linux" label="Linux (x86_64 or arm64)">
        <CodeBlock language="bash">{COMMANDS.linux}</CodeBlock>
      </TabItem>
    </Tabs>
  );
}
