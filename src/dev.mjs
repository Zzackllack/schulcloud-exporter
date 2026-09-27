import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
// Vite's package "exports" does not expose bin/vite.js, so resolve the package
// root and walk to the binary. Doing this instead of spawning a bare "vite"
// keeps the script working no matter what PATH the caller happens to have.
const viteBin = join(dirname(require.resolve("vite/package.json")), "bin/vite.js");

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const targets = [
  {
    label: "api",
    color: "\x1b[36m",
    command: process.execPath,
    args: ["src/cli.mjs", "serve"],
  },
  {
    label: "web",
    color: "\x1b[35m",
    command: process.execPath,
    args: [viteBin, "--host", "127.0.0.1"],
  },
];

const children = new Map();
let stopping = false;

function write(target, line) {
  process.stdout.write(`${target.color}${target.label}${RESET} ${DIM}|${RESET} ${line}\n`);
}

function start(target) {
  const child = spawn(target.command, target.args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  children.set(target.label, child);

  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on("line", (line) => write(target, line));
  }

  child.on("error", (error) => {
    write(target, `start fehlgeschlagen: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    children.delete(target.label);
    // Expected during shutdown; anything else means the pair is half dead.
    if (stopping) return;
    write(target, `beendet (${signal ? `signal ${signal}` : `code ${code}`})`);
    stop(code ?? 1);
  });
}

async function stop(code) {
  if (stopping) return;
  stopping = true;
  const running = [...children.values()];
  for (const child of running) child.kill("SIGTERM");
  // Do not hang forever on a child that ignores SIGTERM.
  const forced = setTimeout(() => {
    for (const child of running) child.kill("SIGKILL");
  }, 2000);
  forced.unref();
  await Promise.all(running.map((child) => once(child, "exit").catch(() => {})));
  clearTimeout(forced);
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => stop(0));
}

for (const target of targets) start(target);
