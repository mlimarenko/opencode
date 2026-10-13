import { afterAll, expect, mock, test } from "bun:test"
import type { PermissionRequest } from "@opencode/client/promise"
import { createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { createPermissionAutoApprover } from "@/session/requests/auto-approve"
import { ScopedKey, ServerScope } from "@/runtime/server/scope"

const [preferences, setPreferences] = createStore({ defaultValue: false, overrides: {} as Record<string, boolean> })
const permissions = {
  setAutoApproveDefault: (value: boolean) => setPreferences("defaultValue", value),
  setAutoApproveOverride: (key: string, value: boolean | undefined) => setPreferences("overrides", key, value),
  autoApproves: (key: string | undefined) => (key ? preferences.overrides[key] : undefined) ?? preferences.defaultValue,
  autoApprovesOnServer: (scope: ServerScope) =>
    preferences.defaultValue ||
    Object.entries(preferences.overrides).some(([key, value]) => value && key.startsWith(ScopedKey.prefix(scope))),
}
// Bun does not compile Solid's JSX context providers; substitute only the settings boundary, not approval logic.
const originalSettings = { ...(await import("@/settings/model")) }
mock.module("@/settings/model", () => ({
  useSettings: () => ({ permissions }),
  projectSettingsKey: (scope: ServerScope, projectID: string | undefined) =>
    projectID ? ScopedKey.from(scope, projectID) : undefined,
}))
afterAll(() => mock.module("@/settings/model", () => originalSettings))

function withSettings(run: (settings: { permissions: typeof permissions }) => void) {
  return createRoot((dispose) => {
    run({ permissions })
    return dispose
  })
}

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
    scope: ServerScope.local,
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
  let settings: { permissions: typeof permissions }
  const dispose = withSettings((preferences) => {
    settings = preferences
    preferences.permissions.setAutoApproveDefault(true)
    createPermissionAutoApprover({ sdk, data } as unknown as Parameters<typeof createPermissionAutoApprover>[0])
  })
  try {
    await observed.promise
    expect(locationReads).toEqual([])
    expect(sessionReads.toSorted()).toEqual(["ses_active", "ses_idle"])
    await answered.promise
    expect(replies).toEqual([pending.id])
    settings!.permissions.setAutoApproveDefault(false)
    state.asked?.({ data: { ...pending, id: "per_disabled" } })
    expect(replies).toEqual([pending.id])
  } finally {
    dispose()
  }
  expect(state.unsubscribed).toBe(true)
})

test.each([
  { defaultValue: true, override: false, expected: 0 },
  { defaultValue: false, override: true, expected: 1 },
  { defaultValue: true, override: undefined, expected: 1 },
])("unloaded project overrides default $defaultValue with $override", async ({ defaultValue, override, expected }) => {
  const pending: PermissionRequest = { id: "per_unknown", sessionID: "ses_unknown", action: "shell", resources: ["*"] }
  const replies: string[] = []
  const inspected: string[] = []
  const listed = Promise.withResolvers<void>()
  const projectID = "project-override"
  const sdk = {
    scope: ServerScope.local,
    connection: { status: () => "connected" },
    event: { on: () => () => {} },
    api: {
      session: {
        active: async () => ({ ses_unknown: { type: "busy" } }),
        get: async ({ sessionID }: { sessionID: string }) => {
          inspected.push(sessionID)
          return { projectID }
        },
      },
      permission: {
        list: async () => {
          listed.resolve()
          return [pending]
        },
        reply: async ({ requestID }: { requestID: string }) => {
          replies.push(requestID)
        },
      },
    },
  }
  const data = { session: { list: () => [], get: () => undefined, permission: { list: () => [] } } }
  const dispose = withSettings((settings) => {
    settings.permissions.setAutoApproveDefault(defaultValue)
    settings.permissions.setAutoApproveOverride(ScopedKey.from(sdk.scope, projectID), override)
    createPermissionAutoApprover({ sdk, data } as unknown as Parameters<typeof createPermissionAutoApprover>[0])
  })
  try {
    await listed.promise
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(inspected).toEqual([pending.sessionID])
    expect(replies).toHaveLength(expected)
  } finally {
    dispose()
  }
})
