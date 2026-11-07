export function updatesEnabled(packaged: boolean, channel: string, disabled?: string) {
  return packaged && channel !== "dev" && !["1", "true"].includes(disabled?.toLowerCase() ?? "")
}
