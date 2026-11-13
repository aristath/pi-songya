import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(join(root, "bin"), { recursive: true });
const child = spawn(
  "go",
  [
    "build",
    "-buildvcs=false",
    "-trimpath",
    "-o",
    join(
      root,
      "bin",
      process.platform === "win32" ? "songya-tools.exe" : "songya-tools",
    ),
    ".",
  ],
  {
    cwd: join(root, "native"),
    stdio: "inherit",
    env: { ...process.env, CGO_ENABLED: "0", GOWORK: "off" },
  },
);
child.on("error", (error) => {
  console.error(
    `Songya helper build failed: ${error.message}. Install Go 1.27.3 or newer and run npm run build.`,
  );
  process.exitCode = 1;
});
child.on("exit", (code) => {
  if (code) process.exitCode = code;
});
