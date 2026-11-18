import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  readFile,
  readdir,
  mkdir,
  open,
  link,
  unlink,
  access,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  store: string;
  user: string;
  config?: string;
  recallEnabled: boolean;
  exposeTools: boolean;
  adminUrl: string;
  roots: Record<string, string>;
}
export interface Reply {
  data?: Record<string, any>;
  error?: string;
  images?: { data: string; mimeType: string }[];
}
export interface Request {
  store: string;
  user: string;
  config?: string;
  operation: string;
  key?: string;
  roots: Record<string, string>;
  args: Record<string, unknown>;
}
export type Invoke = (request: Request, signal?: AbortSignal) => Promise<Reply>;
const root = fileURLToPath(new URL("../", import.meta.url));
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const expand = (path: string, base: string) =>
  resolve(
    base,
    path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? join(homedir(), path.slice(2))
        : path,
  );

export async function loadConfig(
  agentDir: string,
  cwd = process.cwd(),
  settings?: Record<string, any>,
): Promise<Config[]> {
  const raw = (
    settings ??
    (SettingsManager.create(cwd, agentDir, {
      projectTrusted: true,
    }).getSettings() as any)
  ).songya;
  if (!Array.isArray(raw) || !raw.length)
    throw new Error(
      `${join(cwd, ".pi/settings.json")} needs a songya array of stores.`,
    );
  const names = new Set<string>();
  return raw.map((entry) => {
    if (
      !entry ||
      typeof entry.store !== "string" ||
      !entry.store.trim() ||
      typeof entry.user !== "string" ||
      !entry.user.trim()
    )
      throw new Error("Each Songya store needs a path and a user identifier.");
    const user = entry.user.trim();
    if (names.has(user))
      throw new Error(`Duplicate Songya store name: ${user}`);
    names.add(user);
    const roots: Record<string, string> = {};
    for (const [name, path] of Object.entries(entry.roots ?? {})) {
      if (typeof path !== "string")
        throw new Error(`Import root ${name} needs a path.`);
      roots[name] = expand(path, cwd);
    }
    return {
      store: expand(entry.store.trim(), cwd),
      user,
      roots,
      config:
        typeof entry.config === "string"
          ? expand(entry.config, cwd)
          : undefined,
      recallEnabled: entry.recallEnabled !== false,
      exposeTools: entry.exposeTools !== false,
      adminUrl:
        typeof entry.adminUrl === "string"
          ? entry.adminUrl
          : "http://127.0.0.1:8664",
    };
  });
}

export function normalizeArguments(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  const numeric = new Set(["offset", "limit", "depth", "start", "end"]);
  const visit = (v: unknown, key = ""): unknown => {
    if (
      numeric.has(key) &&
      typeof v === "string" &&
      v.trim() &&
      Number.isFinite(Number(v))
    )
      return Number(v);
    if (Array.isArray(v)) return v.map((item) => visit(item));
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, value]) => [k, visit(value, k)]),
      );
    return v;
  };
  return visit(input) as Record<string, unknown>;
}
export function mutates(operation: string, args: Record<string, unknown>) {
  return (
    operation.startsWith("save_") ||
    [
      "organize_memory",
      "upload_file",
      "attach_file",
      "replace_file",
      "remove_file",
    ].includes(operation) ||
    (operation === "import_memories" && args.action === "apply")
  );
}

let build: Promise<void> | undefined;
export async function ensureHelper() {
  const binary = join(
    root,
    "bin",
    process.platform === "win32" ? "songya-tools.exe" : "songya-tools",
  );
  try {
    await access(binary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    build ??= new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [join(root, "scripts/build.mjs")], {
        cwd: root,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let diagnostic = "";
      child.stderr.on("data", (chunk) => {
        diagnostic = (diagnostic + chunk).slice(-8192);
      });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0
          ? resolve()
          : reject(
              new Error(
                `Build the Songya helper with npm run build (Go 1.27.3+ required). ${diagnostic}`,
              ),
            ),
      );
    }).catch((error) => {
      build = undefined;
      throw error;
    });
    await build;
  }
  return binary;
}
export const invokeNative: Invoke = async (request, signal) => {
  signal?.throwIfAborted();
  const binary = await ensureHelper();
  signal?.throwIfAborted();
  return new Promise<Reply>((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"] });
    let bytes = 0;
    const chunks: Buffer[] = [];
    let diagnostic = "";
    let failure: Error | undefined;
    let force: ReturnType<typeof setTimeout> | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGTERM");
      force ??= setTimeout(() => child.kill("SIGKILL"), 2000);
      force.unref();
    };
    const abort = () =>
      stop(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Songya request cancelled"),
      );
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(
      () =>
        stop(
          new Error(
            "Songya did not finish within 65 seconds; accepted writes remain retained.",
          ),
        ),
      65000,
    );
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024)
        stop(new Error("Songya response exceeded 64 MiB"));
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-8192);
    });
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      failure = error;
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (force) clearTimeout(force);
      signal?.removeEventListener("abort", abort);
      // A complete response wins a late cancellation: do not lose an accepted result.
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          code === 0 &&
          reply &&
          typeof reply === "object" &&
          (Object.hasOwn(reply, "data") || typeof reply.error === "string")
        ) {
          resolve(reply);
          return;
        }
      } catch {}
      reject(
        failure ??
          new Error(
            `Songya helper exited ${code}: ${diagnostic || "no complete response"}`,
          ),
      );
    });
    child.stdin.end(JSON.stringify(request));
    if (signal?.aborted) abort();
  });
};

async function durableJSON(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + "." + randomUUID() + ".tmp";
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value) + "\n");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporary, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const previous = JSON.parse(await readFile(path, "utf8"));
    if (digest(previous) !== digest(value))
      throw new Error(
        "This Songya request key already belongs to different arguments.",
      );
  } finally {
    await unlink(temporary);
  }
  const dir = await open(dirname(path), "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
export function finished(reply: Reply) {
  const status = reply.data?.status;
  return (
    status === "committed" ||
    status === "not_accepted" ||
    (!reply.error && !status)
  );
}
export class Client {
  readonly agentDir: string;
  readonly invoke: Invoke;
  constructor(agentDir: string, invoke: Invoke = invokeNative) {
    this.agentDir = agentDir;
    this.invoke = invoke;
  }
  pendingDir(config: Config) {
    return join(
      this.agentDir,
      "pi-songya",
      "pending",
      digest([config.store, config.user]),
    );
  }
  async call(
    config: Config,
    operation: string,
    args: Record<string, unknown>,
    key?: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const request: Request = {
      store: config.store,
      ...(config.config ? { config: config.config } : {}),
      user: config.user,
      roots: config.roots,
      operation,
      args: Object.fromEntries(
        Object.entries(args).filter(([key]) => key !== "store"),
      ),
      ...(key ? { key } : {}),
    };
    const write = mutates(operation, args);
    if (write && !key)
      throw new Error("A stable request key is required for a Songya write.");
    const path = key
      ? join(this.pendingDir(config), digest(key) + ".json")
      : undefined;
    if (write && path) {
      try {
        const previous = JSON.parse(await readFile(path, "utf8"));
        if (digest(previous) !== digest(request))
          throw new Error(
            "This Songya request key already belongs to different arguments.",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await durableJSON(path, request);
    }
    const reply = await this.invoke(request, signal);
    if (write && path && finished(reply)) {
      await unlink(path).catch((error) => {
        if (error.code === "ENOENT") return;
        // A local cleanup failure cannot erase the authoritative save result.
        // The original request stays queued; a retry uses its existing key.
        const diagnostics = Array.isArray(reply.data?.diagnostics)
          ? reply.data.diagnostics
          : [];
        reply.data = {
          ...reply.data,
          diagnostics: [
            ...diagnostics,
            {
              path,
              message: `Write result retained, but local queue cleanup needs repair: ${error.message}`,
            },
          ],
        };
      });
    }
    return reply;
  }
  async recover(config: Config) {
    const warnings: string[] = [];
    const dir = this.pendingDir(config);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return warnings;
      throw error;
    }
    for (const name of files.filter((name) => name.endsWith(".json"))) {
      try {
        const path = join(dir, name);
        const request: Request = JSON.parse(await readFile(path, "utf8"));
        if (
          request.store !== config.store ||
          request.user !== config.user ||
          !request.key ||
          !mutates(request.operation, request.args)
        )
          throw new Error(
            "Pending write identity is damaged; retained for repair.",
          );
        const reply = await this.invoke(request);
        if (finished(reply))
          await unlink(path).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        if (reply.error) warnings.push(`${request.operation}: ${reply.error}`);
      } catch (error) {
        warnings.push(`${name}: ${(error as Error).message}`);
      }
    }
    return warnings;
  }
}
