import React from "react";
import Navbar from "@theme-original/Navbar";
import useDocusaurusContext from "@docusaurus/useDocusaurusContext";

/*
 * The shared theme (@swmansion/t-rex-ui) mounts its DocSearch bar by default.
 * Argent has no DocSearch application yet, so docusaurus.config.js leaves the
 * algolia block out and the bar has to come out with it: rendered without
 * credentials it still binds Cmd+K and opens a modal that can only answer "no
 * results".
 */
export default function NavbarWrapper(): React.ReactElement {
  const { siteConfig } = useDocusaurusContext();
  return <Navbar isAlgoliaActive={Boolean(siteConfig.themeConfig.algolia)} />;
}
