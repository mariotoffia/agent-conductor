import { spawn } from "node:child_process";

/**
 * How the Mock Agent behaves as a *process*: the scenarios that are about a
 * program rather than about the protocol.
 *
 * Its own module because they are one thing — a CLI that leaves helpers behind,
 * dumps its environment when it fails, ignores a signal, or never speaks ACP at
 * all — and because several of them decide whether the stream is connected at
 * all. The caller hands that decision over rather than making it and being
 * overruled.
 */
export function misbehaveAsProcess(mode: string, connect: () => void): void {
  // `spawns-child` behaves like every real agent CLI: it starts helper processes
  // of its own — MCP servers, tool runners — that outlive it unless the client
  // stops the whole process group.
  if (mode === "spawns-child") spawnStrayWorker();

  if (mode === "stderr") {
    process.stderr.write("mock-agent stderr\n");
  }
  // `leak-secret` behaves like a CLI that dumps its environment when it fails:
  // the resolved credential it was started with goes straight to its diagnostics.
  if (mode === "leak-secret") {
    process.stderr.write(`fatal: request failed with MOCK_SECRET=${process.env.MOCK_SECRET}\n`);
    process.exit(9);
  }
  if (process.argv.includes("--ignore-sigterm")) {
    // Survives SIGTERM so clients have to escalate to end it.
    process.on("SIGTERM", () => undefined);
  }
  if (process.argv.includes("--graceful-sigterm")) {
    // Shuts down cooperatively, so the exit carries a code and no signal at all.
    process.on("SIGTERM", () => process.exit(0));
  }

  if (mode === "malformed") {
    process.stdout.end("{malformed\n", () => process.exit(2));
  } else if (mode === "exit") {
    setImmediate(() => process.exit(23));
  } else if (mode === "leak-secret-split") {
    // Never connects: the diagnostics and the exit are the whole scenario.
    leakSecretSplit();
  } else {
    connect();
  }
}

/** A helper the Agent starts and does not stop, as every agent CLI does. It is
 *  only started when a test says where to watch for it. */
function spawnStrayWorker(): void {
  const log = process.env.MOCK_AGENT_WORKER_LOG;
  if (!log) return;
  const worker = spawn(
    process.execPath,
    ["-e", "setInterval(() => require('node:fs').appendFileSync(process.argv[1], 'x'), 25)", log],
    { stdio: "ignore" },
  );
  worker.unref();
}

/** `leak-secret-split` straddles the credential across two reads, as a long
 *  stack trace does crossing the pipe's buffer: a client redacting a chunk at a
 *  time finds nothing to remove, and reassembles the value itself. */
function leakSecretSplit(): void {
  const secret = process.env.MOCK_SECRET ?? "";
  const at = Math.floor(secret.length / 2);
  process.stderr.write(`fatal: request failed with MOCK_SECRET=${secret.slice(0, at)}`);
  setTimeout(() => {
    process.stderr.write(`${secret.slice(at)}\ngiving up\n`);
    setTimeout(() => process.exit(9), 20);
  }, 20);
}
