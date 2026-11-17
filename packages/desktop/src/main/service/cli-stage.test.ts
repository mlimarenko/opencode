import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"

import { payloadIdentity, stageCli } from "./cli-stage"
import { stageName } from "./cli-version"

const layers = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
const executable = "opencode-cli"

function run<A, E>(effect: Effect.Effect<A, E>) {
  return Effect.runPromise(effect.pipe(Effect.provide(layers)))
}

function failingChmod(predicate: (target: string) => boolean) {
  const fs = Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const base = yield* FileSystem.FileSystem
      return {
        ...base,
        chmod: (target: string, mode: number) =>
          predicate(target) ? Effect.fail(new Error("EACCES: chmod")) : base.chmod(target, mode),
      } as FileSystem.FileSystem
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer))
  return Layer.mergeAll(fs, NodePath.layer)
}

function identityOf(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

describe("cli-stage", () => {
  test("stages a second payload under the same version without touching the first", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "opencode-cli-stage-"))
    try {
      const sourceA = path.join(root, "payload-a")
      const sourceB = path.join(root, "payload-b")
      writeFileSync(sourceA, "payload-a")
      writeFileSync(sourceB, "payload-b")
      const identityA = identityOf("payload-a")
      const identityB = identityOf("payload-b")

      const stagedA = await run(
        stageCli({ source: sourceA, version: "2.3.0", arch: "x64", identity: identityA, root, executable }),
      )
      const stagedB = await run(
        stageCli({ source: sourceB, version: "2.3.0", arch: "x64", identity: identityB, root, executable }),
      )

      expect(stagedA).not.toBe(stagedB)
      expect(path.dirname(stagedA)).not.toBe(path.dirname(stagedB))
      expect(readFileSync(stagedA, "utf8")).toBe("payload-a")
      expect(readFileSync(stagedB, "utf8")).toBe("payload-b")
      expect(readdirSync(path.dirname(stagedA))).toEqual([executable])
      expect(readdirSync(path.dirname(stagedB))).toEqual([executable])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("reuses an identical payload without rewriting it", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "opencode-cli-stage-"))
    try {
      const source = path.join(root, "payload")
      writeFileSync(source, "same-payload")
      const identity = identityOf("same-payload")
      const input = { source, version: "2.3.0", arch: "x64", identity, root, executable }

      const first = await run(stageCli(input))
      const before = statSync(first)
      const second = await run(stageCli(input))
      const after = statSync(second)

      expect(second).toBe(first)
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(readFileSync(second, "utf8")).toBe("same-payload")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("publishes a missing stage with executable mode", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "opencode-cli-stage-"))
    try {
      const source = path.join(root, "payload")
      writeFileSync(source, "payload")
      const staged = await run(
        stageCli({ source, version: "2.3.0", arch: "x64", identity: identityOf("payload"), root, executable }),
      )

      expect(existsSync(staged)).toBe(true)
      expect(readFileSync(staged, "utf8")).toBe("payload")
      if (process.platform !== "win32") expect(statSync(staged).mode & 0o777).toBe(0o755)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("replaces a corrupt stage instead of trusting its path", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "opencode-cli-stage-"))
    try {
      const source = path.join(root, "payload")
      writeFileSync(source, "payload")
      const identity = identityOf("payload")
      const input = { source, version: "2.3.0", arch: "x64", identity, root, executable }

      const staged = await run(stageCli(input))
      writeFileSync(staged, "corrupt")
      const replaced = await run(stageCli(input))

      expect(replaced).toBe(staged)
      expect(readFileSync(replaced, "utf8")).toBe("payload")
      if (process.platform !== "win32") expect(statSync(replaced).mode & 0o777).toBe(0o755)
      expect(readdirSync(path.dirname(replaced))).toEqual([executable])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails without a fallback when publication cannot complete", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "opencode-cli-stage-"))
    try {
      const source = path.join(root, "payload")
      writeFileSync(source, "payload")
      const identity = identityOf("payload")
      const directory = path.join(root, "cli", stageName("2.3.0", "x64", identity))
      const destination = path.join(directory, executable)
      mkdirSync(destination, { recursive: true })

      await expect(
        run(stageCli({ source, version: "2.3.0", arch: "x64", identity, root, executable })),
      ).rejects.toThrow()
      expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails when the source payload is missing and leaves no destination", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "opencode-cli-stage-"))
    try {
      const identity = identityOf("missing")
      const destination = path.join(root, "cli", stageName("2.3.0", "x64", identity), executable)

      await expect(
        run(stageCli({ source: path.join(root, "missing"), version: "2.3.0", arch: "x64", identity, root, executable })),
      ).rejects.toThrow()
      expect(existsSync(destination)).toBe(false)
      expect(readdirSync(path.dirname(destination))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("restores execute bits on an identical reused payload without changing its identity", async () => {
    if (process.platform === "win32") return
    const root = mkdtempSync(path.join(tmpdir(), "opencode-cli-stage-"))
    try {
      const source = path.join(root, "payload")
      writeFileSync(source, "payload")
      const identity = identityOf("payload")
      const input = { source, version: "2.3.0", arch: "x64", identity, root, executable }

      const staged = await run(stageCli(input))
      chmodSync(staged, 0o644)
      const before = statSync(staged)
      const again = await run(stageCli(input))
      const after = statSync(again)

      expect(again).toBe(staged)
      expect(after.mode & 0o777).toBe(0o755)
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(readFileSync(again, "utf8")).toBe("payload")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("restores a partially lost execute bit on an identical reused payload", async () => {
    if (process.platform === "win32") return
    const root = mkdtempSync(path.join(tmpdir(), "opencode-cli-stage-"))
    try {
      const source = path.join(root, "payload")
      writeFileSync(source, "payload")
      const identity = identityOf("payload")
      const input = { source, version: "2.3.0", arch: "x64", identity, root, executable }

      const staged = await run(stageCli(input))
      chmodSync(staged, 0o655)
      const before = statSync(staged)
      expect(before.mode & 0o777).toBe(0o655)
      const again = await run(stageCli(input))
      const after = statSync(again)

      expect(again).toBe(staged)
      expect(after.mode & 0o777).toBe(0o755)
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
      expect(readFileSync(again, "utf8")).toBe("payload")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails closed when the execute bit cannot be restored", async () => {
    if (process.platform === "win32") return
    const root = mkdtempSync(path.join(tmpdir(), "opencode-cli-stage-"))
    try {
      const source = path.join(root, "payload")
      writeFileSync(source, "payload")
      const identity = identityOf("payload")
      const input = { source, version: "2.3.0", arch: "x64", identity, root, executable }

      const staged = await run(stageCli(input))
      chmodSync(staged, 0o644)

      await expect(
        Effect.runPromise(stageCli(input).pipe(Effect.provide(failingChmod((target) => target === staged)))),
      ).rejects.toThrow()
      expect(statSync(staged).mode & 0o777).toBe(0o644)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("removes its temporary file when publication chmod fails", async () => {
    if (process.platform === "win32") return
    const root = mkdtempSync(path.join(tmpdir(), "opencode-cli-stage-"))
    try {
      const source = path.join(root, "payload")
      writeFileSync(source, "payload")
      const identity = identityOf("payload")
      const destination = path.join(root, "cli", stageName("2.3.0", "x64", identity), executable)

      await expect(
        Effect.runPromise(
          stageCli({ source, version: "2.3.0", arch: "x64", identity, root, executable }).pipe(
            Effect.provide(failingChmod((target) => target.endsWith(".tmp"))),
          ),
        ),
      ).rejects.toThrow()
      expect(existsSync(destination)).toBe(false)
      expect(readdirSync(path.dirname(destination)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
