import { createEffect, onCleanup } from "solid-js"
import type { PermissionRequest } from "@opencode/client/promise"
import type { Data } from "@opencode/client/solid"
import type { ServerSDK } from "@/runtime/server/client"
import { projectSettingsKey, useSettings } from "@/settings/model"

const respondedLimit = 1000

const retryLimit = 2

const retryDelayMs = 1000

// Auto-approves permission requests on one server connection for the projects
// the client-local settings cover: the app-wide default, unless a project overrides it.
export function createPermissionAutoApprover(input: { sdk: ServerSDK; data: Data }) {
  const permissions = useSettings().permissions
  const enabled = () => permissions.autoApprovesOnServer(input.sdk.scope)

  const covers = (projectID: string | undefined) =>
    permissions.autoApproves(projectSettingsKey(input.sdk.scope, projectID))

  const state = { disposed: false, generation: 0, responded: new Set<string>() }

  const unsubscribe = input.sdk.event.on("permission.asked", (event) => {
    if (enabled()) void considerWithRetry(event.data, 0)
  })

  onCleanup(() => {
    state.disposed = true
    unsubscribe()
  })

  // The event stream does not replay requests asked while this client was
  // disconnected, and requests may already be pending before the setting turns
  // on, so sweep on every connect while the setting is on.
  createEffect(() => {
    if (!enabled() || input.sdk.connection.status() !== "connected") return
    const generation = ++state.generation
    void sweepWithRetry(generation, 0)
  })

  // Approves pending requests that reach the local store, which is how a
  // previously unknown idle session's requests surface when its view opens
  // and syncs them. Store changes cannot re-trigger the network sweep: it
  // deliberately reads them after an await, outside Solid tracking.
  createEffect(() => {
    if (!enabled()) return

    for (const session of input.data.session.list()) {
      // Track project preference changes for visible requests; eligibility here
      // only starts a lookup and never authorizes a reply from cached metadata.
      if (!covers(session.projectID)) continue

      for (const request of input.data.session.permission.list(session.id) ?? []) void considerWithRetry(request, 0)
    }
  })

  // An incomplete sweep leaves pending requests hidden with no later trigger
  // to recover them, so retry it a bounded number of times. A newer sweep
  // supersedes scheduled retries.
  async function sweepWithRetry(generation: number, attempt: number) {
    const complete = await sweep(generation)

    if (complete || attempt >= retryLimit) return
    setTimeout(
      () => {
        if (state.disposed || !enabled() || generation !== state.generation) return
        void sweepWithRetry(generation, attempt + 1)
      },
      retryDelayMs * (attempt + 1),
    )
  }

  async function sweep(generation: number) {
    // Session-owned reads resolve current placement on the server and borrow
    // only existing instances. Directory inventory reads would boot cold worktrees.
    const active = await input.sdk.api.session.active().catch(() => undefined)

    if (state.disposed || !enabled() || generation !== state.generation) return true
    const ids = [...new Set([...Object.keys(active ?? {}), ...input.data.session.list().map((session) => session.id)])]

    const listed = await Promise.all(
      ids.map((sessionID) =>
        input.sdk.api.permission
          .list({ sessionID })
          .then(async (pending) =>
            (await Promise.all(pending.map((request) => consider(request, generation)))).every(Boolean),
          )
          .catch(() => false),
      ),
    )

    return active !== undefined && listed.every(Boolean)
  }

  async function considerWithRetry(permission: PermissionRequest, attempt: number) {
    const complete = await consider(permission)

    if (complete || attempt >= retryLimit) return
    setTimeout(
      () => {
        if (state.disposed || !enabled()) return
        void considerWithRetry(permission, attempt + 1)
      },
      retryDelayMs * (attempt + 1),
    )
  }

  // Cached metadata survives disconnects, during which another client can move
  // the session to a project with different permissions. This read does not boot its location.
  async function consider(permission: PermissionRequest, generation?: number): Promise<boolean> {
    if (state.disposed || !enabled() || state.responded.has(permission.id)) return true

    if (generation !== undefined && generation !== state.generation) return true
    const session = await input.sdk.api.session.get({ sessionID: permission.sessionID }).catch(() => undefined)

    // Report an incomplete lookup to its retry owner rather than abandoning a hidden request.
    if (!session) return false

    if (generation !== undefined && generation !== state.generation) return true

    return approve(permission, session.projectID)
  }

  async function approve(permission: PermissionRequest, projectID: string) {
    // Evaluate the current project choice after the metadata await, including on retries.
    if (state.disposed || !covers(projectID) || state.responded.has(permission.id)) return true
    remember(permission.id)

    return input.sdk.api.permission
      .reply({ sessionID: permission.sessionID, requestID: permission.id, decision: "once" })
      .then(() => true)
      .catch(() => {
        // Retry owners also reacquire project identity before retrying a failed reply.
        state.responded.delete(permission.id)

        return false
      })
  }

  function remember(id: string) {
    state.responded.add(id)

    for (const oldest of state.responded) {
      if (state.responded.size <= respondedLimit) break
      state.responded.delete(oldest)
    }
  }
}
