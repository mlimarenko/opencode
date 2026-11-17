import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"

import { cleanStages } from "./cli-stages"

const layers = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
const arch = process.arch
const a = "a".repeat(64)
const b = "b".repeat(64)
const c = "c".repeat(64)

describe("cleanStages", () => {
  test.each([
    {
      name: "upgrade removes other managed stages",
      staged: [`2.0.18-${arch}-${a}`, `2.0.19-${arch}-${b}`, `2.0.20-${arch}-${c}`],
      current: `2.0.20-${arch}-${c}`,
      keepPrefixes: undefined,
      expected: [`2.0.20-${arch}-${c}`],
    },
    {
      name: "downgrade removes other managed stages",
      staged: [`2.0.18-${arch}-${a}`, `2.0.19-${arch}-${b}`, `2.0.20-${arch}-${c}`],
      current: `2.0.18-${arch}-${a}`,
      keepPrefixes: undefined,
      expected: [`2.0.18-${arch}-${a}`],
    },
    {
      name: "same version keeps the adopted older payload",
      staged: [`2.3.0-${arch}-${a}`, `2.3.0-${arch}-${b}`],
      current: `2.3.0-${arch}-${b}`,
      keepPrefixes: [`2.3.0-${arch}-`],
      expected: [`2.3.0-${arch}-${a}`, `2.3.0-${arch}-${b}`],
    },
    {
      name: "different adopted server version",
      staged: [`2.0.18-${arch}-${a}`, `2.0.19-${arch}-${b}`, `2.0.20-${arch}-${c}`],
      current: `2.0.20-${arch}-${c}`,
      keepPrefixes: [`2.0.19-${arch}-`],
      expected: [`2.0.19-${arch}-${b}`, `2.0.20-${arch}-${c}`],
    },
    {
      name: "unmanaged directories and legacy stages stay untouched",
      staged: [
        "2.3.0-x64",
        "custom-stage",
        `${arch}-${a}`,
        `2.0.18-${arch}-${a}`,
        `2.3.0-${arch}-${b}`,
      ],
      current: `2.3.0-${arch}-${b}`,
      keepPrefixes: [`2.3.0-${arch}-`],
      expected: ["2.3.0-x64", "custom-stage", `${arch}-${a}`, `2.3.0-${arch}-${b}`],
    },
  ])("$name", async (input) => {
    const root = mkdtempSync(path.join(tmpdir(), "opencode-cli-stages-"))

    try {
      input.staged.forEach((stage) => {
        mkdirSync(path.join(root, stage))
        writeFileSync(path.join(root, stage, "opencode-cli"), stage)
      })
      writeFileSync(path.join(root, "unrelated"), "")

      await Effect.runPromise(
        cleanStages(path.join(root, input.current, "opencode-cli"), {
          keepPrefixes: input.keepPrefixes,
        }).pipe(Effect.provide(layers)),
      )

      expect(readdirSync(root).sort()).toEqual([...input.expected, "unrelated"].sort())
      expect(readdirSync(path.join(root, input.current))).toEqual(["opencode-cli"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
