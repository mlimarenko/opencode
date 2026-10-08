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
    if (enabled()) consider(event.data)
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
      for (const request of input.data.session.permission.list(session.id) ?? []) approve(request)
    }
  })

  // An incomplete sweep leaves pending requests hidden with no later trigger
  // to recover them, so retry it a bounded number of times. A newer sweep
  // supersedes scheduled retries.
  async function sweepWithRetry(generation: number, attempt: number) {
    const complete = await sweep()

    if (complete || attempt >= retryLimit) return
    setTimeout(
      () => {
        if (state.disposed || !enabled() || generation !== state.generation) return
        void sweepWithRetry(generation, attempt + 1)
      },
      retryDelayMs * (attempt + 1),
    )
  }

  async function sweep() {
    // Session-owned reads resolve current placement on the server and borrow
    // only existing instances. Directory inventory reads would boot cold worktrees.
    const active = await input.sdk.api.session.active().catch(() => undefined)
    if (state.disposed || !enabled()) return true
    const ids = [...new Set([...Object.keys(active ?? {}), ...input.data.session.list().map((session) => session.id)])]

    const listed = await Promise.all(
      ids.map((sessionID) =>
        input.sdk.api.permission
          .list({ sessionID })
          .then((pending) => {
            if (!state.disposed) pending.forEach((request) => consider(request))

            return true
          })
          .catch(() => false),
      ),
    )

    return active !== undefined && listed.every(Boolean)
  }

  // A request from a session this client has not loaded needs that session's
  // project before a per-project choice can apply to it.
  function consider(permission: PermissionRequest) {
    if (covers(undefined) || input.data.session.get(permission.sessionID)) return approve(permission)
    void input.sdk.api.session
      .get({ sessionID: permission.sessionID })
      .then((session) => approve(permission, session.projectID))
      .catch(() => undefined)
  }

  function approve(
    permission: PermissionRequest,
    projectID = input.data.session.get(permission.sessionID)?.projectID,
    attempt = 0,
  ) {
    // covers() guards the retry timer path: the user may disable the setting
    // between a failed reply and its scheduled retry.
    if (state.disposed || !covers(projectID) || state.responded.has(permission.id)) return
    remember(permission.id)
    input.sdk.api.permission
      .reply({ sessionID: permission.sessionID, requestID: permission.id, decision: "once" })
      .catch(() => {
        // A reply failure leaves the request pending but invisible (the UI
        // hides prompts while auto-approve is on), so retry a bounded number
        // of times. Later sweeps retry it after that.
        state.responded.delete(permission.id)

        if (state.disposed || attempt >= retryLimit) return
        setTimeout(() => approve(permission, projectID, attempt + 1), retryDelayMs * (attempt + 1))
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
