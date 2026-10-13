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
      session: {
        active: async () => ({ ses_active: { type: "busy" } }),
        get: async () => ({ projectID: "default-project" }),
      },
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

function approvalFixture(input: {
  cachedProject?: string
  get: () => Promise<{ projectID: string }>
  reply?: () => Promise<void>
}) {
  const pending: PermissionRequest = {
    id: "per_recovery",
    sessionID: "ses_recovery",
    action: "shell",
    resources: ["*"],
  }
  const replies: string[] = []
  const state = { gets: 0, lists: 0, asked: (_event: { data: PermissionRequest }) => {} }
  const [connection, setConnection] = createStore({ status: "disconnected" })
  const sdk = {
    scope: ServerScope.local,
    connection: { status: () => connection.status },
    event: {
      on(_type: string, callback: typeof state.asked) {
        state.asked = callback
        return () => {}
      },
    },
    api: {
      session: {
        active: async () => ({ ses_recovery: { type: "busy" } }),
        get: async () => {
          state.gets++
          return input.get()
        },
      },
      permission: {
        list: async () => {
          state.lists++
          return [pending]
        },
        reply: async ({ requestID }: { requestID: string }) => {
          replies.push(requestID)
          await input.reply?.()
        },
      },
    },
  }
  const sessions = input.cachedProject ? [{ id: pending.sessionID, projectID: input.cachedProject }] : []
  const data = { session: { list: () => sessions, get: () => sessions[0], permission: { list: () => [] } } }
  const dispose = withSettings(() => {
    permissions.setAutoApproveDefault(true)
    permissions.setAutoApproveOverride(ScopedKey.from(sdk.scope, "project-a"), true)
    permissions.setAutoApproveOverride(ScopedKey.from(sdk.scope, "project-b"), false)
    createPermissionAutoApprover({ sdk, data } as unknown as Parameters<typeof createPermissionAutoApprover>[0])
  })
  return {
    pending,
    replies,
    state,
    dispose,
    connect: () => setConnection("status", "connected"),
    ask: () => state.asked({ data: pending }),
  }
}

test("reconnect resolves the moved session's authoritative project instead of its cached project", async () => {
  const fixture = approvalFixture({ cachedProject: "project-a", get: async () => ({ projectID: "project-b" }) })
  try {
    fixture.connect()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(fixture.state.gets).toBe(1)
    expect(fixture.replies).toEqual([])
  } finally {
    fixture.dispose()
  }
})

test.each(["sweep", "event"] as const)("%s retries a transient authoritative metadata failure", async (origin) => {
  let attempts = 0
  const fixture = approvalFixture({
    get: async () => {
      if (++attempts === 1) throw new Error("transient metadata failure")
      return { projectID: "project-a" }
    },
  })
  try {
    if (origin === "sweep") fixture.connect()
    else fixture.ask()
    await new Promise<void>((resolve) => setTimeout(resolve, 1150))
    expect(fixture.state.gets).toBe(2)
    expect(fixture.replies).toEqual([fixture.pending.id])
    expect(fixture.state.lists).toBe(origin === "sweep" ? 2 : 0)
  } finally {
    fixture.dispose()
  }
})

test.each(["dispose", "disable"] as const)("event metadata completion respects %s", async (guard) => {
  const metadata = Promise.withResolvers<{ projectID: string }>()
  const fixture = approvalFixture({ get: () => metadata.promise })
  try {
    fixture.ask()
    expect(fixture.state.gets).toBe(1)
    if (guard === "dispose") fixture.dispose()
    else permissions.setAutoApproveOverride(ScopedKey.from(ServerScope.local, "project-a"), false)
    metadata.resolve({ projectID: "project-a" })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(fixture.replies).toEqual([])
  } finally {
    fixture.dispose()
  }
})

test.each(["dispose", "disable"] as const)("event metadata retry respects %s", async (guard) => {
  const fixture = approvalFixture({
    get: async () => {
      throw new Error("transient metadata failure")
    },
  })
  try {
    fixture.ask()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (guard === "dispose") fixture.dispose()
    else {
      permissions.setAutoApproveDefault(false)
      permissions.setAutoApproveOverride(ScopedKey.from(ServerScope.local, "project-a"), false)
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 1150))
    expect(fixture.state.gets).toBe(1)
    expect(fixture.replies).toEqual([])
  } finally {
    fixture.dispose()
  }
})

test("event metadata failures exhaust the existing two-retry bound", async () => {
  const fixture = approvalFixture({
    get: async () => {
      throw new Error("metadata unavailable")
    },
  })
  try {
    fixture.ask()
    await new Promise<void>((resolve) => setTimeout(resolve, 3200))
    expect(fixture.state.gets).toBe(3)
    expect(fixture.replies).toEqual([])
  } finally {
    fixture.dispose()
  }
})

test("a failed reply retry refreshes project identity before approving again", async () => {
  let reads = 0
  const fixture = approvalFixture({
    get: async () => ({ projectID: ++reads === 1 ? "project-a" : "project-b" }),
    reply: async () => {
      throw new Error("reply failed before session moved")
    },
  })
  try {
    fixture.ask()
    await new Promise<void>((resolve) => setTimeout(resolve, 1150))
    expect(fixture.state.gets).toBe(2)
    expect(fixture.replies).toEqual([fixture.pending.id])
  } finally {
    fixture.dispose()
  }
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
