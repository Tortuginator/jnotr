import { join } from "path"

const CLI_PATH = join(import.meta.dir, "../src/cli.ts")

export const FIXTURES = join(import.meta.dir, "fixtures")

export interface CLIResult {
  stdout: string
  stderr: string
  exitCode: number
}

export async function runCLI(args: string[], env: Record<string, string | undefined> = {}): Promise<CLIResult> {
  const proc = Bun.spawn(["bun", "run", CLI_PATH, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode }
}

export function parseJSON<T = unknown>(result: CLIResult): T {
  if (result.exitCode !== 0) {
    throw new Error(`CLI exited with code ${result.exitCode}. stderr: ${result.stderr}`)
  }
  try {
    return JSON.parse(result.stdout) as T
  } catch {
    throw new Error(`Failed to parse JSON. stdout: ${result.stdout}\nstderr: ${result.stderr}`)
  }
}

/** Environment pointing every data source at the committed offline fixtures. */
export function fixtureEnv(dir = FIXTURES, registry = "employers.csv"): Record<string, string> {
  return {
    WORKDAY_FIXTURE_DIR: dir,
    WORKDAY_REGISTRY: join(dir, registry),
    WORKDAY_AREA: join(dir, "area.json"),
  }
}
