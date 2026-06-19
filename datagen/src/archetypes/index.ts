// Registry of all app archetypes. Add a new archetype by dropping a file in
// this directory that default-exports an AppArchetype, then importing it here.

import type { AppArchetype } from "../types.ts";
import iosSettings from "./ios-settings.ts";
import rnShop from "./rn-shop.ts";
import authLogin from "./auth-login.ts";
import chromiumDashboard from "./chromium-dashboard.ts";

export const ARCHETYPES: AppArchetype[] = [iosSettings, rnShop, authLogin, chromiumDashboard];

export function archetypesForPlatform(platform: AppArchetype["platforms"][number]): AppArchetype[] {
  return ARCHETYPES.filter((a) => a.platforms.includes(platform));
}
