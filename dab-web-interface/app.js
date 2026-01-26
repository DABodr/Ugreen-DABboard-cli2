#!/usr/bin/env node
/*
  uGreen DAB Web Interface (Node.js 18+)

  Wraps vendor "radio_cli" binary.

  Constraints:
  - radio_cli must be executed as root (hardware access).
  - Options are those from: sudo radio_cli --help

  Socket events:
    client -> server:
      boot
      tune { frequencyIndex }
      fullScan
      listServices
      selectService { serviceId, componentId? }
      getStationText { waitTimeSeconds? }

    server -> client:
      status { ok, message, detail? }
      blockResult { scan: ... }      (full_scan.json content)
      ensembleInfo { ... }           (best-effort)
      services { services: ... }     (best-effort)
      serviceSelected { ... }
      stationText { text }
      error { message, detail? }
*/

"use strict";

const fs = require("fs");
const path = require("path");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const { spawn } = require("child_process");

// -----------------------------
// Configuration
// -----------------------------

const RADIO_CLI_PATH = process.env.RADIO_CLI_PATH || "/usr/local/sbin/radio_cli";

// Timeouts
const RADIO_CLI_TIMEOUT_MS = Number(process.env.RADIO_CLI_TIMEOUT_MS || 30_000);
const RADIO_CLI_FULLSCAN_TIMEOUT_MS = Number(
  process.env.RADIO_CLI_FULLSCAN_TIMEOUT_MS || 180_000
);

// Web server
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

// Logging / data
const LOG_DIR = process.env.LOG_DIR || "/var/log/dab-web-interface";
const LOG_PATH = process.env.LOG_PATH || path.join(LOG_DIR, "radio.log");
const DATA_DIR = process.env.DATA_DIR || "/var/lib/dab-web-interface";

// -----------------------------
// Helpers
// -----------------------------

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function appendLog(line) {
  try {
    ensureDir(path.dirname(LOG_PATH));
    fs.appendFileSync(LOG_PATH, line + "\n", { encoding: "utf8" });
  } catch (e) {
    // logging should never kill the server
    console.error("LOG ERROR:", e?.message || e);
  }
}

function logCmd(cmd, args) {
  appendLog(`[${nowIso()}] CMD: ${cmd} ${args.join(" ")}`);
}

function logOut(out) {
  const text = String(out || "").trimEnd();
  if (!text) return;
  for (const line of text.split("\n")) {
    appendLog(`[${nowIso()}] OUT: ${line}`);
  }
}

function logErr(err) {
  const text = String(err || "").trimEnd();
  if (!text) return;
  for (const line of text.split("\n")) {
    appendLog(`[${nowIso()}] ERR: ${line}`);
  }
}

function isRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

function parseIntStrict(value, name) {
  if (value === undefined || value === null) throw new Error(`${name} is required`);
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) throw new Error(`${name} must be an integer`);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} is invalid`);
  return n;
}

function parseFrequencyIndex(value) {
  const n = parseIntStrict(value, "frequencyIndex");
  if (n < 0 || n > 200) throw new Error("frequencyIndex out of range");
  return n;
}

function parseServiceId(value) {
  const n = parseIntStrict(value, "serviceId");
  if (n < 0 || n > 999999) throw new Error("serviceId out of range");
  return n;
}

function parseComponentId(value) {
  if (value === undefined || value === null || value === "") return 0;
  const n = parseIntStrict(value, "componentId");
  if (n < 0 || n > 9999) throw new Error("componentId out of range");
  return n;
}

function parseWaitTimeSeconds(value) {
  if (value === undefined || value === null) return 1;
  const n = parseIntStrict(value, "waitTimeSeconds");
  if (n < 0 || n > 30) throw new Error("waitTimeSeconds must be between 0 and 30");
  return n;
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function parseMultiJson(stdout) {
  const out = String(stdout || "").trim();
  if (!out) return [];
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  const objs = [];
  for (const line of lines) {
    const obj = safeJsonParse(line);
    if (obj) objs.push(obj);
  }
  return objs;
}

/**
 * Runs radio_cli with timeout.
 * Returns { stdout, stderr, code }.
 */
function runRadioCli(args, { timeoutMs = RADIO_CLI_TIMEOUT_MS, cwd = DATA_DIR } = {}) {
  return new Promise((resolve, reject) => {
    if (!isRoot()) {
      return reject(
        new Error(
          "radio_cli must be called as root. Run dab-webserver.service as root (User=root)."
        )
      );
    }

    ensureDir(cwd);
    logCmd(RADIO_CLI_PATH, args);

    let stdout = "";
    let stderr = "";

    const child = spawn(RADIO_CLI_PATH, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
      const err = new Error(`radio_cli timeout after ${Math.round(timeoutMs / 1000)}s`);
      err.code = "ETIMEDOUT";
      logErr(err.message);
      reject(err);
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      const msg = `Failed to spawn radio_cli: ${err?.message || err}`;
      logErr(msg);
      reject(new Error(msg));
    });

    child.stdout.on("data", (buf) => (stdout += buf.toString("utf8")));
    child.stderr.on("data", (buf) => (stderr += buf.toString("utf8")));

    child.on("close", (code) => {
      clearTimeout(timer);
      logOut(stdout);
      logErr(stderr);
      resolve({ stdout, stderr, code });
    });
  });
}

// -----------------------------
// radio_cli actions (real flags)
// -----------------------------

async function bootDab() {
  // -b D + -j
  await runRadioCli(["-b", "D", "-j"]);
}

async function tuneFrequencyIndex(frequencyIndex) {
  const idx = parseFrequencyIndex(frequencyIndex);
  // -f <index> + -j
  return runRadioCli(["-f", String(idx), "-j"]);
}

async function getEnsembleInfo() {
  // -G + -j
  const res = await runRadioCli(["-G", "-j"]);
  const trimmed = String(res.stdout || "").trim();
  if (!trimmed) return { raw: "" };

  // some versions output a JSON line, others multiple
  const one = safeJsonParse(trimmed);
  if (one) return one;

  const many = parseMultiJson(res.stdout);
  return many.length ? many[many.length - 1] : { raw: trimmed };
}

async function listServices() {
  // IMPORTANT: correct option is -g (digital_service_list), not --list-services
  const res = await runRadioCli(["-g", "-j"]);
  const trimmed = String(res.stdout || "").trim();
  if (!trimmed) return { services: [], raw: "" };

  // sometimes it's one big JSON, sometimes multiple lines
  const one = safeJsonParse(trimmed);
  if (one) return { services: one };

  const many = parseMultiJson(res.stdout);
  return { services: many.length ? many : [], raw: trimmed };
}

async function selectService(serviceId, componentId = 0) {
  const sid = parseServiceId(serviceId);
  const cid = parseComponentId(componentId);

  // -e <service> -c <component> -p  (+ -j doesn't hurt)
  return runRadioCli(["-e", String(sid), "-c", String(cid), "-p", "-j"]);
}

async function getStationText(waitTimeSeconds = 1) {
  const wt = parseWaitTimeSeconds(waitTimeSeconds);
  // -D -z <wait>
  const res = await runRadioCli(["-D", "-z", String(wt)], {
    timeoutMs: RADIO_CLI_TIMEOUT_MS + wt * 1000,
  });
  return { text: String(res.stdout || "").trim() };
}

async function fullScan() {
  // -u saves full_scan.json in cwd. We'll run it in DATA_DIR.
  await runRadioCli(["-b", "D", "-u", "-j"], {
    timeoutMs: RADIO_CLI_FULLSCAN_TIMEOUT_MS,
    cwd: DATA_DIR,
  });

  const scanFile = path.join(DATA_DIR, "full_scan.json");
  if (!fs.existsSync(scanFile)) {
    throw new Error(`full_scan.json not found after scan (expected at ${scanFile})`);
  }

  const data = fs.readFileSync(scanFile, "utf8");
  const parsed = safeJsonParse(data);
  return parsed || { raw: data };
}

// -----------------------------
// Server
// -----------------------------

ensureDir(LOG_DIR);
ensureDir(DATA_DIR);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    root: isRoot(),
    radioCliPath: RADIO_CLI_PATH,
    time: nowIso(),
  });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  socket.emit("status", {
    ok: true,
    message: "Connected",
    detail: {
      root: isRoot(),
      radioCliPath: RADIO_CLI_PATH,
      time: nowIso(),
    },
  });

  const sendError = (err) => {
    const msg = err?.message || String(err);
    socket.emit("error", { message: msg });
    logErr(msg);
  };

  socket.on("boot", async () => {
    try {
      await bootDab();
      socket.emit("status", { ok: true, message: "Boot OK" });
    } catch (err) {
      sendError(err);
    }
  });

  socket.on("tune", async (payload) => {
    try {
      const idx = parseFrequencyIndex(payload?.frequencyIndex);
      await tuneFrequencyIndex(idx);

      // optional info
      const info = await getEnsembleInfo().catch(() => null);
      if (info) socket.emit("ensembleInfo", info);

      socket.emit("status", { ok: true, message: `Tuned to frequency index ${idx}` });
    } catch (err) {
      sendError(err);
    }
  });

  socket.on("fullScan", async () => {
    try {
      socket.emit("status", { ok: true, message: "Full scan started… (can take a while)" });
      const scan = await fullScan();
      socket.emit("blockResult", { scan });
      socket.emit("status", { ok: true, message: "Full scan finished" });
    } catch (err) {
      sendError(err);
    }
  });

  socket.on("listServices", async () => {
    try {
      const result = await listServices();
      socket.emit("services", result);
    } catch (err) {
      sendError(err);
    }
  });

  socket.on("selectService", async (payload) => {
    try {
      const serviceId = parseServiceId(payload?.serviceId);
      const componentId = parseComponentId(payload?.componentId);
      await selectService(serviceId, componentId);
      socket.emit("serviceSelected", { serviceId, componentId });
    } catch (err) {
      sendError(err);
    }
  });

  socket.on("getStationText", async (payload) => {
    try {
      const wt = parseWaitTimeSeconds(payload?.waitTimeSeconds);
      const text = await getStationText(wt);
      socket.emit("stationText", text);
    } catch (err) {
      sendError(err);
    }
  });
});

server.listen(PORT, HOST, () => {
  appendLog(`[${nowIso()}] Server listening on http://${HOST}:${PORT}`);
  console.log(`Server listening on http://${HOST}:${PORT}`);
});

// Clean shutdown
function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
