import { expect, test } from "bun:test"
import type { PermissionRequest } from "@opencode/client/promise"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createPermissionAutoApprover } from "@/session/requests/auto-approve"

test("auto-approval reconnect sweeps session-owned requests without booting historical locations", async () => {
  const sessions = [
    { id: "ses_active", location: { directory: "/active" } },
    { id: "ses_idle", location: { directory: "/historical" } },
  ]
  const locationReads: string[] = []
  const sessionReads: string[] = []
  const replies: string[] = []
  const observed = Promise.withResolvers<void>()
  const answered = Promise.withResolvers<void>()
  const pending: PermissionRequest = {
    id: "per_idle",
    sessionID: "ses_idle",
    action: "shell",
    resources: ["*"],
  }
  const state = { unsubscribed: false, asked: undefined as ((event: { data: PermissionRequest }) => void) | undefined }
  const sdk = {
    connection: { status: () => "connected" },
    event: {
      on(_type: string, callback: (event: { data: PermissionRequest }) => void) {
        state.asked = callback
        return () => {
          state.unsubscribed = true
        }
      },
    },
    api: {
      session: { active: async () => ({ ses_active: { type: "busy" } }) },
      permission: {
        request: {
          list: async (input: { location: { directory: string } }) => {
            locationReads.push(input.location.directory)
            observed.resolve()
            return { data: [] }
          },
        },
        list: async (input: { sessionID: string }) => {
          sessionReads.push(input.sessionID)
          observed.resolve()
          return input.sessionID === pending.sessionID ? [pending] : []
        },
        reply: async (input: { requestID: string }) => {
          replies.push(input.requestID)
          answered.resolve()
        },
      },
    },
  }
  const data = {
    session: {
      list: () => sessions,
      get: (id: string) => sessions.find((session) => session.id === id),
      invalidate() {},
      sync: async () => {},
      permission: { list: () => [] },
    },
  }
  const [preferences, setPreferences] = createStore({ enabled: true })
  const dispose = createRoot((dispose) => {
    createPermissionAutoApprover({ sdk, data, enabled: () => preferences.enabled } as unknown as Parameters<
      typeof createPermissionAutoApprover
    >[0])
    return dispose
  })
  try {
    await observed.promise
    expect(locationReads).toEqual([])
    expect(sessionReads.toSorted()).toEqual(["ses_active", "ses_idle"])
    await answered.promise
    expect(replies).toEqual([pending.id])
    setPreferences("enabled", false)
    state.asked?.({ data: { ...pending, id: "per_disabled" } })
    expect(replies).toEqual([pending.id])
  } finally {
    dispose()
  }
  expect(state.unsubscribed).toBe(true)
})
