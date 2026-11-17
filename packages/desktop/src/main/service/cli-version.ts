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

export function stageName(version: string, arch: string = process.arch, identity?: string) {
  const base = `${version}-${arch}`.replace(/[^a-zA-Z0-9._-]/g, "-")
  return identity ? `${base}-${identity}` : base
}

export function stagePrefix(version: string, arch: string = process.arch) {
  return `${stageName(version, arch)}-`
}

/**
 * Stages to keep while cleaning: the running server's version can share the bundled
 * semver with a different payload identity, so keep every stage of that version by
 * prefix. The current stage is kept explicitly by its exact directory name.
 */
export function keptStagePrefixes(runningVersion?: string, arch: string = process.arch) {
  if (!runningVersion) return []
  return [stagePrefix(runningVersion, arch)]
}

/**
 * The legacy `<version>-<arch>` stage of the running server, kept by exact name during the
 * transition to content-addressed stages so cleanup cannot delete a still-running payload.
 */
export function keptStageNames(runningVersion?: string, arch: string = process.arch) {
  if (!runningVersion) return []
  return [stageName(runningVersion, arch)]
}
