import MDXComponents from "@theme-original/MDXComponents";

import Prompt from "@site/src/components/Prompt";
import Video from "@site/src/components/Video";

// Registered here so .mdx pages can use them without an import line.
export default {
  ...MDXComponents,
  Prompt,
  Video,
};
