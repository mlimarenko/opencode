import { Effect, FileSystem, Path } from "effect"

// Only content-addressed stages created by this owner are candidates for cleanup: the full
// name must be `<sanitized version>-<arch>-<64-hex payload identity>`, with a non-empty
// version. Any other directory (including legacy `<version>-<arch>` stages, a bare
// `<arch>-<identity>` name, or unrelated files) is left untouched as an unmanaged retained
// artifact; it is never generated, read or executed.
function managedStage(entry: string, arch: string) {
  const escaped = arch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`^[a-zA-Z0-9._-]+-${escaped}-[0-9a-f]{64}$`).test(entry)
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
