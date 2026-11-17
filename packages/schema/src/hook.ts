export * as Hook from "./hook.js"

import { Schema } from "effect"

const MAX_DENIAL_MESSAGE = 500
const GENERIC_DENIAL = "Plugin stopped the request."

/**
 * The safe form of a denial message: one printable line, bounded in length. An
 * empty or malformed message still says that the plugin stopped the request, so
 * the reason never degrades into a transport or output error.
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
 * A plugin hook refused the work before it ran. The message reaches the user, so
 * it must stay a short reason: no request headers, authorization material, argv
 * or provider response bodies. Normalization lives in this class, so every way of
 * constructing a denial — the Promise `ctx.deny` factory or a direct Effect
 * `new Hook.Denied(...)` — produces the same bounded single-line text.
 */
export class Denied extends Schema.TaggedError<Denied>()("Hook.Denied", {
  message: Schema.String,
}) {
  constructor(props: { readonly message: string }) {
    super({ message: denialMessage(props.message) })
  }
}

/**
 * Boundary decision for a rejected hook call: only a denial the plugin built as
 * `Hook.Denied` may carry text. An ordinary thrown Error, a string or any other
 * value is untrusted, so it becomes the generic refusal; its text is not shown.
 */
export const denial = (cause: unknown) =>
  cause instanceof Denied ? cause : new Denied({ message: GENERIC_DENIAL })
