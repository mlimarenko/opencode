import { expect, test } from "bun:test"
import { updatesEnabled } from "./policy"

test("Desktop updates honor the shared automatic-update opt-out across channels", () => {
  for (const channel of ["prod", "beta", "dev"]) {
    for (const packaged of [true, false]) {
      for (const disabled of [undefined, "", "0", "false", "1", "true", "TRUE"]) {
        expect(updatesEnabled(packaged, channel, disabled)).toBe(
          packaged && channel !== "dev" && !["1", "true", "TRUE"].includes(disabled ?? ""),
        )
      }
    }
  }
})
