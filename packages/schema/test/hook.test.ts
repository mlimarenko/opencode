import { describe, expect, test } from "bun:test"
import { Hook } from "../src/hook.js"

describe("Hook denial boundary", () => {
  test("keeps the text of an explicit denial", () => {
    expect(Hook.denial(new Hook.Denied({ message: "[OpenAI API Guard] paid API is off" })).message).toBe(
      "[OpenAI API Guard] paid API is off",
    )
  })

  test("does not show the text of an unknown or malformed rejection", () => {
    const secret = "Bearer LEAK-MARKER"
    expect(Hook.denial(new Error(secret)).message).toBe("Plugin stopped the request.")
    expect(Hook.denial(secret).message).toBe("Plugin stopped the request.")
    expect(Hook.denial({ message: secret }).message).toBe("Plugin stopped the request.")
    expect(Hook.denial(undefined).message).toBe("Plugin stopped the request.")
    expect(Hook.denialMessage(secret)).toBe(secret)
    expect(Hook.denialMessage(42)).toBe("Plugin stopped the request.")
  })

  test("normalizes and bounds the text a plugin explicitly marks as safe", () => {
    expect(Hook.denialMessage("a\nb\u0000c")).toBe("a b c")
    expect(Hook.denialMessage("   ")).toBe("Plugin stopped the request.")
    expect(Hook.denialMessage("x".repeat(900)).length).toBe(500)
  })
})
