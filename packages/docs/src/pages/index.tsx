import { Redirect } from "@docusaurus/router";
import useBaseUrl from "@docusaurus/useBaseUrl";
import React from "react";

/** The Argent landing page lives at argent.swmansion.com, not here. */
export default function Home(): React.JSX.Element {
  return <Redirect to={useBaseUrl("/docs/fundamentals/getting-started")} />;
}
