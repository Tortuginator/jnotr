import { describe, expect, test } from "bun:test"
import { fixtureEnv, runCLI } from "./helpers"

describe("CLI error contract", () => {
  test("an unknown flag exits 1 with JSON on stderr", async () => {
    const result = await runCLI(["search", "--bogus", "value"], fixtureEnv())

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(JSON.parse(result.stderr).code).toBe("UNKNOWN_FLAG")
  })

  test("an invalid --format exits 1", async () => {
    const result = await runCLI(["search", "--format", "xml"], fixtureEnv())

    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("BAD_ARG")
  })

  test("a non-positive --page exits 1", async () => {
    const result = await runCLI(["search", "--page", "0"], fixtureEnv())

    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("BAD_ARG")
  })

  test("detail without an id exits 1", async () => {
    const result = await runCLI(["detail"], fixtureEnv())

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(JSON.parse(result.stderr).code).toBe("NO_ID")
  })

  test("detail rejects a table format", async () => {
    const result = await runCLI(["detail", "x", "--format", "table"], fixtureEnv())

    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("BAD_ARG")
  })

  test("an unknown command exits 1", async () => {
    const result = await runCLI(["bogus"], fixtureEnv())

    expect(result.exitCode).toBe(1)
    expect(JSON.parse(result.stderr).code).toBe("BAD_CMD")
  })

  test("a missing registry exits 1 with NO_REGISTRY, before any network call", async () => {
    const result = await runCLI(["search"], {
      TEAMTAILOR_REGISTRY: "/nonexistent/teamtailor-test/employers.csv",
    })

    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(JSON.parse(result.stderr).code).toBe("NO_REGISTRY")
  })
})
