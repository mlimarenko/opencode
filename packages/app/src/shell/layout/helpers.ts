import type { SessionInfo } from "@opencode/client/promise"
import { Option, Schema } from "effect"
import { pathKey } from "@/workspaces/path-key"
import { isProjectDirectory } from "@/workspaces/paths"
import type { ServerConnection } from "@/runtime/server/registry"
import type { HomeProjectSelection } from "@/shell/state/layout"

export function compareSessionTime(a: SessionInfo, b: SessionInfo) {
  const updated = (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created)

  if (updated !== 0) return updated

  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function toggleHomeProjectSelection(
  current: HomeProjectSelection | undefined,
  server: ServerConnection.Key,
  directory: string,
): HomeProjectSelection {
  if (current?.server === server && current.directory === directory) return { server }

  return { server, directory }
}

export function homeProjectDirectories(result: string | string[] | null) {
  if (!result) return []

  return Array.isArray(result) ? result : [result]
}

export function projectForSession<T extends { id?: string; worktree: string; sandboxes?: string[] }>(
  session: SessionInfo,
  projects: T[],
) {
  const matching = projects.filter((project) => project.id === session.projectID)

  if (matching.length === 1) return matching[0]

  if (matching.length > 1) {
    const directory = pathKey(session.location.directory)

    const exact =
      matching.find((project) => pathKey(project.worktree) === directory) ??
      matching.find((project) => project.sandboxes?.some((sandbox) => pathKey(sandbox) === directory))

    if (exact) return exact

    return (
      matching
        .filter((project) => isProjectDirectory(project, session.location.directory))
        .sort((a, b) => b.worktree.length - a.worktree.length)[0] ?? matching.at(-1)
    )
  }

  const directory = pathKey(session.location.directory)

  const exact =
    projects.find((project) => pathKey(project.worktree) === directory) ??
    projects.find((project) => project.sandboxes?.some((sandbox) => pathKey(sandbox) === directory))

  if (exact) return exact

  return projects
    .filter((project) => isProjectDirectory(project, session.location.directory))
    .sort((a, b) => b.worktree.length - a.worktree.length)[0]
}

export function resolveSessionProjectColor(
  session: SessionInfo,
  opened: { worktree: string; sandboxes?: string[]; color?: string }[],
  stored: { id?: string; worktree: string; sandboxes?: string[] }[],
) {
  // An external worktree can belong to a repository beneath an opened workspace root.
  const canonical = projectForSession(session, stored)?.worktree

  for (const directory of [session.location.directory, canonical]) {
    if (!directory) continue

    const project = opened
      .filter((item) => item.color !== undefined && isProjectDirectory(item, directory))
      .sort((a, b) => b.worktree.length - a.worktree.length)[0]

    if (project) return project.color
  }
}

// SAFETY: This boundary accepts thrown request values and decodes their message before use.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
export const errorMessage = (err: unknown, fallback: string) => {
  const decoded = Schema.decodeUnknownOption(Schema.Struct({ data: Schema.Struct({ message: Schema.String }) }))(err)

  if (Option.isSome(decoded) && decoded.value.data.message) return decoded.value.data.message

  if (err instanceof Error) return err.message

  return fallback
}
