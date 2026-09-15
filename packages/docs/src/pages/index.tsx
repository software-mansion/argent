import Head from "@docusaurus/Head";
import { Redirect } from "@docusaurus/router";
import useBaseUrl from "@docusaurus/useBaseUrl";
import React from "react";

/** The Argent landing page lives at argent.swmansion.com, not here. */
export default function Home(): React.JSX.Element {
  return (
    <>
      <Head>
        <title>Argent documentation</title>
        <meta
          name="description"
          content="Argent documentation. Install the Argent MCP server and let your AI coding agent drive iOS simulators, Android emulators, physical devices, TVs and desktop apps."
        />
      </Head>
      <Redirect to={useBaseUrl("/docs/fundamentals/getting-started")} />
    </>
  );
}
