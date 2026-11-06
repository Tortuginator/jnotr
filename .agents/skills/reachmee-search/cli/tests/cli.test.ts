import { describe, expect, test } from "bun:test"
import { runCLI } from "./helpers"

function stderrJSON(result: { stderr: string }): { error: string; code: string } {
  return JSON.parse(result.stderr)
}

describe("CLI contract", () => {
  test("rejects unknown flags with a JSON error on stderr", async () => {
    const result = await runCLI(["search", "--bogus"])
    expect(result.exitCode).toBe(1)
    expect(stderrJSON(result).code).toBe("UNKNOWN_FLAG")
    expect(result.stdout).toBe("")
  })

  test("rejects unknown commands", async () => {
    const result = await runCLI(["nope"])
    expect(result.exitCode).toBe(1)
    expect(stderrJSON(result).code).toBe("BAD_CMD")
  })

  test("detail requires an argument", async () => {
    const result = await runCLI(["detail"])
    expect(result.exitCode).toBe(1)
    expect(stderrJSON(result).code).toBe("NO_ID")
  })

  test("detail rejects a bare id before any network call", async () => {
    const result = await runCLI(["detail", "215"])
    expect(result.exitCode).toBe(1)
    expect(stderrJSON(result).code).toBe("BAD_ID")
  })

  test("rejects a bare -q and an unsupported format", async () => {
    const noValue = await runCLI(["search", "-q"])
    expect(noValue.exitCode).toBe(1)
    expect(stderrJSON(noValue).code).toBe("BAD_ARG")

    const badFormat = await runCLI(["search", "--format", "xml"])
    expect(badFormat.exitCode).toBe(1)
    expect(stderrJSON(badFormat).code).toBe("BAD_ARG")
  })

  test("rejects non-positive paging values", async () => {
    const result = await runCLI(["search", "--page", "0"])
    expect(result.exitCode).toBe(1)
    expect(stderrJSON(result).code).toBe("BAD_ARG")
  })

  test("help prints usage", async () => {
    const result = await runCLI(["search", "--help"])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("USAGE")
  })
})
