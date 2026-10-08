// Entry point.
//
//   npm start                                  # http://127.0.0.1:8722
//   npm run open                               # ...and open a browser at it
//   MTA_PORT=9000 MTA_PYTHON=python3.12 npm start
//
// Everything except listening lives in app.ts, so this file has nothing to test.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { createApp } from "./app.ts";
import { CONFIG } from "./config.ts";
import { allowed as runAllowed } from "./run.ts";

fs.mkdirSync(CONFIG.dataDir, { recursive: true });

if (!fs.existsSync(path.join(CONFIG.metaagent, "mta_gen.py"))) {
  // Fail here rather than on the first generate: a missing MetaAgent is a setup
  // mistake, and finding out at startup is much cheaper than finding out from a job
  // that died with a Python traceback in its stderr.
  console.error(`[fatal] no mta_gen.py under ${CONFIG.metaagent}`);
  console.error("        point MTA_ROOT at your MetaAgent checkout");
  process.exit(2);
}

const app = createApp();

/**
 * Open the default browser at `url`.
 *
 * Opt-in (`--open`) rather than automatic: a server gets restarted often while you work,
 * and a tool that spawns a tab every time becomes something you fight.
 */
function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "win32"
    ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin"
      ? ["open", [url]]
      : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // Not worth failing a working server over; the URL is printed either way.
  }
}

app.server.listen(CONFIG.port, CONFIG.host, () => {
  const url = `http://${CONFIG.host}:${CONFIG.port}`;
  console.log(`MetaAgent web designer  ${url}`);
  console.log(`  MetaAgent : ${CONFIG.metaagent}`);
  console.log(`  python    : ${CONFIG.python}`);
  console.log(`  data      : ${CONFIG.dataDir}`);
  // Say whether running is on. Two env vars with no feedback is a guessing game, and
  // the failure mode -- pressing Run and getting a 403 -- gives no hint which one was
  // missed.
  const run = runAllowed();
  console.log(run.ok
    ? `  run       : ENABLED${CONFIG.runApiKey ? "" : "  (no MTA_RUN_API_KEY — the agent will report a missing key)"}`
    : `  run       : off  (${run.reason.split(".")[0]})`);
  if (process.argv.includes("--open")) openBrowser(url);
  else console.log("  (add --open, or run `npm run open`, to launch a browser)");
  if (CONFIG.host !== "127.0.0.1" && CONFIG.host !== "localhost") {
    console.warn("  [warn] bound beyond loopback. This turns a posted graph into "
                 + "runnable code and there is no authentication yet — see the "
                 + "'Single-user' section of the README before leaving it there.");
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} — shutting down`);
    void app.close().then(() => process.exit(0));
  });
}
