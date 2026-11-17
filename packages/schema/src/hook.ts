export * as Hook from "./hook.js"

import { Schema } from "effect"

/**
 * A plugin hook refused the work before it ran. The message is the plugin's own
 * explanation and reaches the user unchanged, so it must stay a short reason:
 * no request headers, authorization material, argv or provider response bodies.
 * Constructing this error is the plugin's explicit statement that the text is
 * safe to display; anything else is replaced by a generic refusal at the boundary.
 */
export class Denied extends Schema.TaggedError<Denied>()("Hook.Denied", {
  message: Schema.String,
}) {}

const MAX_DENIAL_MESSAGE = 500
const GENERIC_DENIAL = "Plugin stopped the request."

/**
 * The safe part of a message passed to the explicit denial factory: one printable
 * line, bounded in length. An empty or malformed message still says that the plugin
 * stopped the request, so the reason never degrades into a transport or output error.
 */
export const denialMessage = (text: unknown) => {
  if (typeof text !== "string") return GENERIC_DENIAL
  const line = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  return line === "" ? GENERIC_DENIAL : line.slice(0, MAX_DENIAL_MESSAGE)
}

/**
 * Boundary decision for a rejected hook call: only a denial the plugin built as
 * `Hook.Denied` may carry text. An ordinary thrown Error, a string or any other
 * value is untrusted, so it becomes the generic refusal; its text is not shown.
 */
export const denial = (cause: unknown) =>
  cause instanceof Denied ? cause : new Denied({ message: GENERIC_DENIAL })
