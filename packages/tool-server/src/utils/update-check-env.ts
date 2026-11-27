export function isUpdateCheckDisabled(): boolean {
  const raw = process.env.ARGENT_DISABLE_UPDATE_CHECK;
  return raw === "1" || raw?.toLowerCase() === "true";
}
