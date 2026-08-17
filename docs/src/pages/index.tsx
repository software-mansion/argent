import { Redirect } from "@docusaurus/router";
import useBaseUrl from "@docusaurus/useBaseUrl";
import React from "react";

/**
 * This site has no landing page of its own: the Argent landing page lives at
 * argent.swmansion.com. The root of the docs site goes straight to the docs.
 */
export default function Home(): React.JSX.Element {
  return <Redirect to={useBaseUrl("/docs/fundamentals/getting-started")} />;
}
