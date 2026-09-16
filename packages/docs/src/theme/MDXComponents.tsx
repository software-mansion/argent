import MDXComponents from "@theme-original/MDXComponents";

import { Card, Cards } from "@site/src/components/Cards";
import InstallCommand from "@site/src/components/InstallCommand";
import Prompt from "@site/src/components/Prompt";
import Video from "@site/src/components/Video";

// Registered here so .mdx pages can use them without an import line.
export default {
  ...MDXComponents,
  Card,
  Cards,
  InstallCommand,
  Prompt,
  Video,
};
