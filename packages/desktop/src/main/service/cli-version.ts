export function parseCliVersion(output: string) {
  const marker = output.lastIndexOf(" v")
  const version = marker === -1 ? output : output.slice(marker + 2)

  if (!version) throw new Error("V2 CLI did not provide a version")

  return version
}

export function serviceVersion(input: {
  readonly channel: "local" | "dev" | "beta" | "prod"
  readonly isolated?: boolean
  readonly mode: "initial" | "reconnect"
  readonly version: string
}) {
  if (input.mode === "reconnect") return undefined

  if (input.channel === "beta" && !input.isolated) return undefined

  return input.version
}

// Retrying on timeout can also replace a server stuck in a migration longer than 120 s, which is accepted.
export function shouldRetryEnsure(version: string | undefined, message: string) {
  if (version !== undefined) return false

  return (
    message === "Background service failed to start" ||
    message === "Timed out waiting for the background service to start"
  )
}

export function stageName(version: string, arch: string, identity: string) {
  const base = `${version}-${arch}`.replace(/[^a-zA-Z0-9._-]/g, "-")
  return `${base}-${identity}`
}

/**
 * Grouping prefix for stages of one version; not a stage name and never used to
 * create or execute a stage. The identity is mandatory in `stageName`.
 */
export function stagePrefix(version: string, arch: string = process.arch) {
  return `${`${version}-${arch}`.replace(/[^a-zA-Z0-9._-]/g, "-")}-`
}

/**
 * Stages to keep while cleaning: the running server's version can share the bundled
 * semver with a different payload identity, so keep every managed stage of that
 * version by prefix. The current stage is kept explicitly by its exact directory name.
 */
export function keptStagePrefixes(runningVersion?: string, arch: string = process.arch) {
  if (!runningVersion) return []
  return [stagePrefix(runningVersion, arch)]
}
