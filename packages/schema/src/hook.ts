export * as Hook from "./hook.js"

import { Schema } from "effect"

/**
 * A plugin hook refused the work before it ran. The message is the plugin's own
 * explanation and reaches the user unchanged, so it must stay a short reason:
 * no request headers, authorization material, argv or provider response bodies.
 */
export class Denied extends Schema.TaggedError<Denied>()("Hook.Denied", {
  message: Schema.String,
}) {}

const MAX_DENIAL_MESSAGE = 500

/**
 * The safe part of a rejected hook call: one printable line, bounded in length.
 * A rejection without a message still says that the plugin stopped the request,
 * so the reason never degrades into a transport or output error.
 */
export const denialMessage = (cause: unknown) => {
  const text = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : ""
  const line = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return line === "" ? "Plugin stopped the request." : line.slice(0, MAX_DENIAL_MESSAGE)
}
