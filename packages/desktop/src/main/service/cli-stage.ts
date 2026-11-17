export * as CliStage from "./cli-stage"

import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { Cause, Effect, FileSystem, Path } from "effect"
import { stageName } from "./cli-version"

/**
 * Identity of a CLI payload: the SHA-256 of its bytes. The desktop stages the bundled
 * executable under this identity instead of its semver, so a same-version rebuild gets
 * its own stage and an unchanged payload is reused. The identity is the only input that
 * decides whether a staged executable may be reused.
 */
export const payloadIdentity = (file: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const hash = createHash("sha256")
        createReadStream(file)
          .on("error", reject)
          .on("data", (chunk) => hash.update(chunk))
          .on("end", () => resolve(hash.digest("hex")))
      }),
    catch: (cause) => new Error(`Cannot read CLI payload ${file}`, { cause }),
  })

export interface StageInput {
  /** The bundled executable to publish. */
  readonly source: string
  readonly version: string
  readonly arch: string
  readonly identity: string
  /** The desktop userData directory; the stage lives under `<root>/cli/<stage>`. */
  readonly root: string
  readonly executable: string
}

/**
 * Publish the bundled CLI under a content-addressed stage and return its executable.
 *
 * - An existing stage whose bytes match `identity` is reused only when POSIX execute bits
 *   are present. A missing execute bit is restored with chmod 0755; if that fails the
 *   operation fails instead of returning an unexecutable path.
 * - A missing or corrupt stage is published from `source` through a same-directory
 *   temporary file, chmod + rename. On any copy/chmod/rename failure the temporary file is
 *   removed (a cleanup error is logged and the original failure still propagates) and no
 *   older binary is selected.
 * - A same-version rebuild gets a different identity and therefore a different
 *   directory, so a running executable is not overwritten. On Windows a rename over a
 *   still-running executable fails and the failure is surfaced, not hidden.
 */
export const stageCli = Effect.fn("DesktopCli.stageCli")(function* (input: StageInput) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = path.join(input.root, "cli", stageName(input.version, input.arch, input.identity))
  const destination = path.join(directory, input.executable)

  if (yield* fs.exists(destination)) {
    const current = yield* payloadIdentity(destination).pipe(Effect.orElseSucceed(() => undefined))
    if (current === input.identity) {
      if (process.platform !== "win32") {
        const stat = yield* fs.stat(destination)
        if ((stat.mode & 0o111) === 0) {
          yield* fs.chmod(destination, 0o755).pipe(
            Effect.catch((error) =>
              Effect.fail(new Error(`Cannot restore executable mode on ${destination}`, { cause: error })),
            ),
          )
          yield* Effect.logInfo("v2 CLI staged executable mode restored", { path: destination })
        }
      }
      return destination
    }
    yield* Effect.logWarning("v2 CLI staged executable does not match its identity; replacing", {
      path: destination,
      expected: input.identity,
      actual: current,
    })
  }

  yield* fs.makeDirectory(directory, { recursive: true })
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`
  yield* Effect.gen(function* () {
    yield* fs.copyFile(input.source, temporary)
    if (process.platform !== "win32") yield* fs.chmod(temporary, 0o755)
    yield* fs.rename(temporary, destination)
  }).pipe(
    Effect.catchCause((cause) =>
      fs.remove(temporary, { force: true }).pipe(
        Effect.catchCause((cleanup) =>
          Effect.logWarning("failed to remove temporary CLI stage", {
            path: temporary,
            cause: Cause.squash(cleanup),
          }),
        ),
        Effect.andThen(Effect.failCause(cause)),
      ),
    ),
  )
  yield* Effect.logInfo("v2 CLI executable staged", {
    source: input.source,
    path: destination,
    identity: input.identity,
  })

  return destination
})
