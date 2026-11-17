import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, Layer } from "effect"

import { cleanStages } from "./cli-stages"

const layers = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

describe("cleanStages", () => {
  test.each([
    {
      name: "upgrade",
      staged: ["2.0.18-x64-aaa", "2.0.19-x64-bbb", "2.0.20-x64-ccc"],
      current: "2.0.20-x64-ccc",
      keep: undefined,
      keepPrefixes: undefined,
      expected: ["2.0.20-x64-ccc"],
    },
    {
      name: "downgrade",
      staged: ["2.0.18-x64-aaa", "2.0.19-x64-bbb", "2.0.20-x64-ccc"],
      current: "2.0.18-x64-aaa",
      keep: undefined,
      keepPrefixes: undefined,
      expected: ["2.0.18-x64-aaa"],
    },
    {
      name: "prerelease",
      staged: ["2.0.20-x64-aaa", "2.1.0-beta.1-x64-bbb", "local-x64-ccc"],
      current: "2.1.0-beta.1-x64-bbb",
      keep: undefined,
      keepPrefixes: undefined,
      expected: ["2.1.0-beta.1-x64-bbb"],
    },
    {
      name: "legacy stage transition",
      staged: ["2.3.0-x64", "2.3.0-x64-new"],
      current: "2.3.0-x64-new",
      keep: ["2.3.0-x64"],
      keepPrefixes: ["2.3.0-x64-"],
      expected: ["2.3.0-x64", "2.3.0-x64-new"],
    },
    {
      name: "same version, adopted older payload",
      staged: ["2.3.0-x64-old", "2.3.0-x64-new"],
      current: "2.3.0-x64-new",
      keep: undefined,
      keepPrefixes: ["2.3.0-x64-"],
      expected: ["2.3.0-x64-old", "2.3.0-x64-new"],
    },
    {
      name: "different adopted server version",
      staged: ["2.0.18-x64-aaa", "2.0.19-x64-bbb", "2.0.20-x64-ccc"],
      current: "2.0.20-x64-ccc",
      keep: undefined,
      keepPrefixes: ["2.0.19-x64-"],
      expected: ["2.0.19-x64-bbb", "2.0.20-x64-ccc"],
    },
  ])("keeps only the current, legacy and running-version stages after $name", async (input) => {
    const root = mkdtempSync(path.join(tmpdir(), "opencode-cli-stages-"))

    try {
      input.staged.forEach((stage) => {
        mkdirSync(path.join(root, stage))
        writeFileSync(path.join(root, stage, "opencode-cli"), stage)
      })
      writeFileSync(path.join(root, "unrelated"), "")

      await Effect.runPromise(
        cleanStages(path.join(root, input.current, "opencode-cli"), {
          keep: input.keep,
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
