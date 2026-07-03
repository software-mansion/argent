import {
  ArtifactStore,
  createArtifactRegistrar,
  type ToolContext,
} from "@argent/registry";
import type { ArtifactOutputMap } from "@argent/artifacts";

export function artifactContext(tool: {
  id: string;
  artifacts?: ArtifactOutputMap;
}): ToolContext {
  return {
    artifacts: createArtifactRegistrar(new ArtifactStore(), tool.artifacts, tool.id),
  };
}
