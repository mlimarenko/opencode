import { describe, expect, test } from "bun:test"
import type { SessionInfo } from "@opencode/client/promise"
import { errorMessage, projectForSession, resolveSessionProjectColor, toggleHomeProjectSelection } from "./helpers"
import { ServerConnection } from "@/runtime/server/registry"

const serverKey = ServerConnection.Key.make

// SAFETY: Project matching reads only the supplied ID, projectID and location; other fields use fixed fixture defaults.
const session = (input: Partial<SessionInfo> & Pick<SessionInfo, "id"> & { directory: string }) =>
  ({
    projectID: "project",
    title: "",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    parentID: undefined,
    time: { created: 0, updated: 0, archived: undefined },
    ...input,
    location: { directory: input.directory },
    directory: undefined,
  }) as SessionInfo

type Project = {
  id: string
  worktree: string
  sandboxes: string[]
  worktrees?: { directory: string; strategy?: string }[]
}

const enriched: { name: string; project: Project }[] = [
  {
    name: "matching project id",
    project: {
      id: "project",
      worktree: "/repo",
      sandboxes: ["/workspaces/feature"],
      worktrees: [{ directory: "/repo" }, { directory: "/workspaces/feature", strategy: "git" }],
    },
  },
  { name: "stale project id", project: { id: "updated", worktree: "/repo", sandboxes: ["/workspaces/feature"] } },
]

describe("layout workspace helpers", () => {
  test.each([
    { directory: "/repo/package", expected: "pink" },
    { directory: "/repo/nested/package", expected: "blue" },
    { directory: "/repo/neutral/package", expected: "" },
    { directory: "/external/worktree", expected: "pink" },
    { directory: "/repo-sibling/package", expected: undefined, canonical: "/unrelated" },
  ])(
    "resolves workspace color without changing project identity ($directory)",
    ({ directory, expected, canonical }) => {
      expect(
        resolveSessionProjectColor(
          session({ id: "feature", directory }),
          [
            { worktree: "/repo", color: "pink" },
            { worktree: "/repo/nested", color: "blue" },
            { worktree: "/repo/neutral", color: "" },
            { worktree: "/external", color: undefined },
          ],
          [{ id: "project", worktree: canonical ?? "/repo/product" }],
        ),
      ).toBe(expected)
    },
  )

  test.each(enriched)("keeps the enriched project for a nested workspace session ($name)", ({ project }) => {
    expect(
      projectForSession(session({ id: "feature", directory: "/workspaces/feature/packages/app" }), [project]),
    ).toBe(project)
  })

  test("scopes home project selection by server", () => {
    expect(
      toggleHomeProjectSelection(undefined, serverKey("https://debian.example"), "/home/luke/repos/amazon"),
    ).toEqual({
      server: serverKey("https://debian.example"),
      directory: "/home/luke/repos/amazon",
    })
    expect(
      toggleHomeProjectSelection(
        { server: serverKey("https://windows.example"), directory: "/home/luke/repos/amazon" },
        serverKey("https://debian.example"),
        "/home/luke/repos/amazon",
      ),
    ).toEqual({ server: serverKey("https://debian.example"), directory: "/home/luke/repos/amazon" })
    expect(
      toggleHomeProjectSelection(
        { server: serverKey("https://debian.example"), directory: "/home/luke/repos/amazon" },
        serverKey("https://debian.example"),
        "/home/luke/repos/amazon",
      ),
    ).toEqual({ server: serverKey("https://debian.example") })
  })

  test("extracts api error message and fallback", () => {
    expect(errorMessage({ data: { message: "boom" } }, "fallback")).toBe("boom")
    expect(errorMessage(new Error("broken"), "fallback")).toBe("broken")
    expect(errorMessage("unknown", "fallback")).toBe("fallback")
  })
})
