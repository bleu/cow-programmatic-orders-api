#!/usr/bin/env tsx
/**
 * deploy-remotely.ts — rsync + SSH deploy or local deploy.
 * Replaces deploy-remotely.sh.
 *
 * NOTE: This script is specific to Bleu's internal deployment workflow.
 * It assumes a particular server layout and SSH setup. Adapt as needed for
 * your own hosting environment.
 *
 * Usage:
 *   npx tsx deployment/deploy-remotely.ts <deploy_target> [env_file_path]
 *
 * deploy_target:
 *   -            Local deployment (runs manage.ts in this repo)
 *   host:path    Remote deployment via SSH (rsync + scp + ssh)
 *
 * Note: Remote deployment requires Node 18+ and pnpm installed on the remote host.
 * Run `pnpm install` on the remote after the first deploy to install tsx.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; ignoreError?: boolean } = {}
): void {
  console.log(`+ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    stdio: "inherit",
    cwd: opts.cwd,
  });
  if (!opts.ignoreError && result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runCapture(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { encoding: "utf-8" });
  if (result.status !== 0) {
    console.error(`Command failed: ${cmd} ${args.join(" ")}`);
    console.error(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

function usage(): never {
  console.error(
    `Usage: tsx deployment/deploy-remotely.ts <deploy_target> [env_file_path]

  deploy_target:
    -            Local deployment
    host:path    Remote deployment via SSH

  env_file_path: path to .env file (default: .env)
`
  );
  process.exit(1);
}

const [deployTarget, envFilePath = ".env"] = process.argv.slice(2);

if (!deployTarget) {
  usage();
}

const appRevision = runCapture("git", ["rev-parse", "--short", "HEAD"]);
const repoRootDir = runCapture("git", ["rev-parse", "--show-toplevel"]);
const manageCmd = process.env["MANAGE_CMD_OVERRIDE"] ?? "up";

if (deployTarget === "-") {
  // Local deployment
  const absoluteEnvFile = resolve(envFilePath);
  run(
    "npx",
    [
      "tsx",
      "deployment/manage.ts",
      manageCmd,
      "--env-file",
      absoluteEnvFile,
      "--revision",
      appRevision,
    ],
    { cwd: repoRootDir }
  );
} else if (/^[^:]+:.+/.test(deployTarget)) {
  // Remote deployment via SSH
  const colonIdx = deployTarget.indexOf(":");
  const sshHost = deployTarget.slice(0, colonIdx);
  const remotePath = deployTarget.slice(colonIdx + 1);

  // rsync repo to remote host
  run("rsync", [
    "-avz",
    "--delete",
    "--mkpath",
    "--exclude=.git",
    "--exclude=node_modules",
    "--exclude=.env",
    "--exclude=.env.local",
    "--exclude=.vite",
    "--exclude=*.log",
    "--exclude=tmp/",
    `${repoRootDir}/`,
    `${sshHost}:${remotePath}/`,
  ]);

  // Copy env file to remote deployment directory
  const remoteEnvPath = `${remotePath}/deployment/.env`;
  run("scp", [envFilePath, `${sshHost}:${remoteEnvPath}`]);

  // Run manage.ts on the remote host
  // Note: The remote host must have Node 18+ and pnpm installed.
  // After the first deploy, run `pnpm install` on the remote to install tsx.
  const remoteDeployDir = `${remotePath}/deployment`;
  // Use bash login shell so NVM / system Node.js is in PATH on the remote host.
  run("ssh", [
    sshHost,
    `bash -lc "cd ${remoteDeployDir} && npx tsx manage.ts ${manageCmd} --env-file .env --revision ${appRevision}"`,
  ]);
} else {
  console.error(
    "Error: <deploy_target> must be '-' (local) or SSH_HOST:PATH (remote)"
  );
  usage();
}
