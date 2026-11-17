import { Effect, FileSystem, Path } from "effect"

// Each payload identity stages its own copy of the CLI. The current stage is kept by its exact
// directory name, and every stage of the running server's version is kept by prefix: a
// same-semver rebuild has a different payload identity, and the adopted server may still be the
// older one. Windows refuses to delete an executable that has not exited yet, so a failed removal
// is logged and retried on the next launch.
export const cleanStages = Effect.fn("DesktopCli.cleanStages")(function* (
  binary: string,
  options?: { readonly keep?: ReadonlyArray<string>; readonly keepPrefixes?: ReadonlyArray<string> },
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const current = path.dirname(binary)
  const root = path.dirname(current)
  const keep = new Set([path.basename(current), ...(options?.keep ?? [])])
  const keepPrefixes = options?.keepPrefixes ?? []
  const entries = yield* fs.readDirectory(root)
  yield* Effect.forEach(
    entries,
    Effect.fnUntraced(function* (entry) {
      if (keep.has(entry) || keepPrefixes.some((prefix) => entry.startsWith(prefix))) return
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
