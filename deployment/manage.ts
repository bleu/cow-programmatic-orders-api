#!/usr/bin/env tsx
/**
 * manage.ts — orchestrates `docker compose` up/down for the deploy stack.
 * Replaces manage.sh.
 *
 * NOTE: This script is specific to Bleu's internal deployment workflow.
 * Adapt the paths and docker compose arguments as needed for your own setup.
 *
 * Usage:
 *   npx tsx deployment/manage.ts <up|down> --env-file <path> [--revision <rev>]
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

function usage(): never {
  console.error(`Usage: tsx deployment/manage.ts <command> [options]

Commands:
  up      Deploy the stack
  down    Tear down the stack

Options:
  -e, --env-file <path>   Path to .env file (required)
  -r, --revision <rev>    Application revision (required for 'up')
  -h, --help              Show this help message
`);
  process.exit(1);
}

function parseArgs(args: string[]): {
  command: string;
  envFile: string;
  revision: string;
} {
  const [command, ...rest] = args;

  if (!command || command === "--help" || command === "-h") {
    usage();
  }

  let envFile = "";
  let revision = "latest";

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "-e" || arg === "--env-file") {
      envFile = rest[++i] ?? "";
    } else if (arg === "-r" || arg === "--revision") {
      revision = rest[++i] ?? "latest";
    } else if (arg === "-h" || arg === "--help") {
      usage();
    } else {
      console.error(`Unknown option: ${arg}`);
      usage();
    }
  }

  if (!envFile) {
    console.error("Error: --env-file required");
    usage();
  }

  return { command, envFile, revision };
}

function loadEnvFile(envFilePath: string): void {
  const absolutePath = resolve(envFilePath);
  const content = readFileSync(absolutePath, "utf-8");

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      process.env[key] = value;
    }
  }
}

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; ignoreError?: boolean } = {}
): void {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: opts.cwd ?? __dirname,
  });
  if (!opts.ignoreError && result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function cmdUp(projectPrefix: string, revision: string): void {
  if (!revision || revision === "latest") {
    console.error("Error: --revision is required for 'up'");
    process.exit(1);
  }

  run("docker", [
    "compose",
    "-p",
    projectPrefix,
    "-f",
    "docker-compose.yml",
    "build",
    "--no-cache",
  ]);

  run("docker", [
    "compose",
    "-p",
    projectPrefix,
    "-f",
    "docker-compose.yml",
    "up",
    "-d",
    "--remove-orphans",
  ]);

  // Prune old images for this project
  const imageName = `${projectPrefix}-ponder`;
  const listResult = spawnSync(
    "docker",
    ["images", "--format", "{{.Repository}}:{{.Tag}}", imageName],
    { encoding: "utf-8", cwd: __dirname }
  );

  if (listResult.status === 0 && listResult.stdout) {
    const oldImages = listResult.stdout
      .trim()
      .split("\n")
      .filter((img) => img && !img.endsWith(`:${revision}`));

    for (const img of oldImages) {
      run("docker", ["rmi", img], { ignoreError: true });
    }
  }

  run("docker", ["image", "prune", "-f"], { ignoreError: true });
  run("docker", ["container", "prune", "-f"], { ignoreError: true });

  console.log(">>> Deploy complete.");
}

function cmdDown(projectPrefix: string): void {
  run(
    "docker",
    [
      "compose",
      "-p",
      projectPrefix,
      "-f",
      "docker-compose.yml",
      "down",
      "-v",
      "--remove-orphans",
    ],
    { ignoreError: true }
  );
}

// ---- main ----

const { command, envFile, revision } = parseArgs(process.argv.slice(2));

loadEnvFile(envFile);

// Hardcoded per project convention
process.env["DATABASE_SCHEMA"] = "programmatic_orders";

const projectPrefix = process.env["PROJECT_PREFIX"];
if (!projectPrefix) {
  console.error("Error: PROJECT_PREFIX must be set in the env file");
  process.exit(1);
}

const appRevision = revision !== "latest" ? revision : process.env["APP_REVISION"] ?? "latest";
process.env["APP_REVISION"] = appRevision;

switch (command) {
  case "up":
    cmdUp(projectPrefix, appRevision);
    break;
  case "down":
    cmdDown(projectPrefix);
    break;
  default:
    console.error(`Unknown command: ${command}`);
    usage();
}
