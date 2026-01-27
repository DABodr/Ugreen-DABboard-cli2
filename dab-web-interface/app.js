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
// Block to frequency index mapping
// -----------------------------

const BLOCK_TO_FREQ = {
  '5A': 0, '5B': 1, '5C': 2, '5D': 3,
  '6A': 4, '6B': 5, '6C': 6, '6D': 7,
  '7A': 8, '7B': 9, '7C': 10, '7D': 11, '7E': 12, '7F': 13,
  '8A': 14, '8B': 15, '8C': 16, '8D': 17, '8E': 18, '8F': 19,
  '9A': 20, '9B': 21, '9C': 22, '9D': 23, '9E': 24, '9F': 25,
  '10A': 26, '10B': 27, '10C': 28, '10D': 29, '10E': 30, '10F': 31,
  '11A': 32, '11B': 33, '11C': 34, '11D': 35, '11E': 36, '11F': 37,
  '12A': 38, '12B': 39, '12C': 40, '12D': 41, '12E': 42, '12F': 43,
  '13A': 44, '13B': 45, '13C': 46, '13D': 47, '13E': 48, '13F': 49
};

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

async function tuneBlock(block) {
  const idx = BLOCK_TO_FREQ[block];
  if (idx === undefined) {
    throw new Error(`Unknown block: ${block}`);
  }
  return tuneFrequencyIndex(idx);
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

  socket.on("scanAllBlocks", async () => {
    try {
      await bootDab();
      const blocks = Object.keys(BLOCK_TO_FREQ);

      for (const block of blocks) {
        try {
          await tuneBlock(block);
          const info = await getEnsembleInfo().catch(() => null);

          if (info && info.ensemble) {
            socket.emit("blockResult", {
              block,
              result: {
                mux: info.ensemble,
                snr: info.snr || 0
              },
              error: null
            });
          } else {
            socket.emit("blockResult", {
              block,
              result: null,
              error: "No signal"
            });
          }
        } catch (err) {
          socket.emit("blockResult", {
            block,
            result: null,
            error: err.message
          });
        }
      }
    } catch (err) {
      sendError(err);
    }
  });

  socket.on("scanBlock", async (block) => {
    try {
      await bootDab();
      await tuneBlock(block);
      const info = await getEnsembleInfo().catch(() => null);

      if (info && info.ensemble) {
        socket.emit("blockResult", {
          block,
          result: {
            mux: info.ensemble,
            snr: info.snr || 0
          },
          error: null
        });
      } else {
        socket.emit("blockResult", {
          block,
          result: null,
          error: "No signal"
        });
      }
    } catch (err) {
      socket.emit("blockResult", {
        block,
        result: null,
        error: err.message
      });
    }
  });

  socket.on("listServices", async () => {
    try {
      const result = await listServices();
      const services = Array.isArray(result.services) ? result.services : [];
      socket.emit("services", services);
    } catch (err) {
      socket.emit("services", []);
      sendError(err);
    }
  });

  socket.on("selectService", async (serviceId) => {
    try {
      const sid = parseServiceId(serviceId);
      await selectService(sid, 0);
      socket.emit("serviceSelected", { success: true });
    } catch (err) {
      socket.emit("serviceSelected", { success: false, error: err.message });
    }
  });

  socket.on("getMetadata", async () => {
    try {
      const text = await getStationText(3);
      socket.emit("metadata", {
        dls: text.text || "",
        dlPlus: "",
        sls: ""
      });
    } catch (err) {
      socket.emit("metadata", { error: err.message });
    }
  });

  socket.on("getLogs", async () => {
    try {
      if (fs.existsSync(LOG_PATH)) {
        const logs = fs.readFileSync(LOG_PATH, "utf8");
        const lines = logs.split("\n");
        const lastLines = lines.slice(-500).join("\n");
        socket.emit("logs", lastLines);
      } else {
        socket.emit("logs", "Aucun log disponible");
      }
    } catch (err) {
      socket.emit("logs", `Erreur lors de la lecture des logs: ${err.message}`);
    }
  });

  let audioMonitorProcess = null;

  socket.on("startAudioMonitor", () => {
    try {
      if (audioMonitorProcess) return;

      audioMonitorProcess = spawn("arecord", [
        "-D", "sysdefault:CARD=dabboard",
        "-c", "2",
        "-r", "48000",
        "-f", "S16_LE",
        "-vv"
      ]);

      let buffer = "";
      audioMonitorProcess.stderr.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const match = line.match(/(\d+)%/);
          if (match) {
            const level = parseInt(match[1], 10) / 100;
            socket.emit("audioLevel", level);
          }
        }
      });

      audioMonitorProcess.on("close", () => {
        audioMonitorProcess = null;
      });
    } catch (err) {
      sendError(err);
    }
  });

  socket.on("stopAudioMonitor", () => {
    if (audioMonitorProcess) {
      audioMonitorProcess.kill();
      audioMonitorProcess = null;
    }
  });

  socket.on("disconnect", () => {
    if (audioMonitorProcess) {
      audioMonitorProcess.kill();
      audioMonitorProcess = null;
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
