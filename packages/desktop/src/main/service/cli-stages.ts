import { Effect, FileSystem, Path } from "effect"

// Only content-addressed stages created by this owner are candidates for cleanup: their last
// segment is the 64-hex payload identity and the segment before it is the architecture. Any
// other directory (including legacy `<version>-<arch>` stages or unrelated files) is left
// untouched as an unmanaged retained artifact; it is never generated, read or executed.
const IDENTITY = /^[0-9a-f]{64}$/

function managedStage(entry: string, arch: string) {
  const identity = entry.slice(entry.lastIndexOf("-") + 1)
  const rest = entry.slice(0, entry.lastIndexOf("-"))
  const stageArch = rest.slice(rest.lastIndexOf("-") + 1)
  return IDENTITY.test(identity) && stageArch === arch
}

export const cleanStages = Effect.fn("DesktopCli.cleanStages")(function* (
  binary: string,
  options?: { readonly keepPrefixes?: ReadonlyArray<string> },
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const current = path.dirname(binary)
  const root = path.dirname(current)
  const keep = new Set([path.basename(current)])
  const keepPrefixes = options?.keepPrefixes ?? []
  const entries = yield* fs.readDirectory(root)
  yield* Effect.forEach(
    entries,
    Effect.fnUntraced(function* (entry) {
      if (keep.has(entry) || keepPrefixes.some((prefix) => entry.startsWith(prefix))) return
      if (!managedStage(entry, process.arch)) return
      const target = path.join(root, entry)
      const stat = yield* fs.stat(target).pipe(Effect.orElseSucceed(() => undefined))

      if (stat?.type !== "Directory") return
      yield* fs
        .remove(target, { recursive: true, force: true })
        .pipe(Effect.catch((error) => Effect.logError("failed to clean staged v2 CLI", { path: target, error })))
    }),
    { concurrency: "unbounded" },
  )
})
