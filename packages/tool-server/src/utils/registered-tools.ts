import { createRegistry } from "./setup-registry";

export function getRegisteredToolIds(): string[] {
  const registry = createRegistry();
  return registry.getSnapshot().tools;
}
