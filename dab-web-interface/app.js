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
const { spawn, execSync } = require("child_process");

// -----------------------------
// Configuration
// -----------------------------

const RADIO_CLI_PATH = process.env.RADIO_CLI_PATH || "/usr/local/sbin/radio_cli";

// Audio device for VU meter (I2S output)
const AUDIO_DEVICE = process.env.AUDIO_DEVICE || "sysdefault:CARD=dabboard";

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

function logInfo(msg) {
  appendLog(`[${nowIso()}] INFO: ${msg}`);
  console.log(`[INFO] ${msg}`);
}

function logWarn(msg) {
  appendLog(`[${nowIso()}] WARN: ${msg}`);
  console.warn(`[WARN] ${msg}`);
}

function isRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/**
 * Check if radio_cli binary exists and is executable
 */
function checkRadioCliExists() {
  try {
    fs.accessSync(RADIO_CLI_PATH, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if arecord is available
 */
function checkArecordExists() {
  try {
    execSync("which arecord", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
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
 * Safely get a numeric value from an object, handling various formats
 */
function safeGetNumber(obj, ...keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) {
      const val = obj[key];
      if (typeof val === "number") return val;
      if (typeof val === "string") {
        const parsed = parseFloat(val);
        if (!isNaN(parsed)) return parsed;
      }
    }
  }
  return null;
}

/**
 * Safely get a string value from an object, trying multiple keys
 */
function safeGetString(obj, ...keys) {
  for (const key of keys) {
    if (obj && obj[key] !== undefined && obj[key] !== null) {
      return String(obj[key]);
    }
  }
  return null;
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

    if (!checkRadioCliExists()) {
      return reject(
        new Error(`radio_cli not found at ${RADIO_CLI_PATH}. Run ugreen_install.sh first.`)
      );
    }

    ensureDir(cwd);
    logCmd(RADIO_CLI_PATH, args);

    let stdout = "";
    let stderr = "";
    let killed = false;

    const child = spawn(RADIO_CLI_PATH, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timer = setTimeout(() => {
      killed = true;
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
      if (killed) return; // Already rejected by timeout
      logOut(stdout);
      logErr(stderr);
      resolve({ stdout, stderr, code });
    });
  });
}

// -----------------------------
// Block to frequency index mapping
// -----------------------------
// European DAB Band III - 38 standard frequencies
// Index corresponds to line number in freq_list.txt (0-indexed)

const BLOCK_TO_FREQ = {
  // Band 5: 174.928 - 180.064 MHz
  '5A': 0, '5B': 1, '5C': 2, '5D': 3,
  // Band 6: 181.936 - 187.072 MHz
  '6A': 4, '6B': 5, '6C': 6, '6D': 7,
  // Band 7: 188.928 - 194.064 MHz
  '7A': 8, '7B': 9, '7C': 10, '7D': 11,
  // Band 8: 195.936 - 201.072 MHz
  '8A': 12, '8B': 13, '8C': 14, '8D': 15,
  // Band 9: 202.928 - 208.064 MHz
  '9A': 16, '9B': 17, '9C': 18, '9D': 19,
  // Band 10: 209.936 - 215.072 MHz
  '10A': 20, '10B': 21, '10C': 22, '10D': 23,
  // Band 11: 216.928 - 222.064 MHz
  '11A': 24, '11B': 25, '11C': 26, '11D': 27,
  // Band 12: 223.936 - 229.072 MHz
  '12A': 28, '12B': 29, '12C': 30, '12D': 31,
  // Band 13: 230.784 - 239.200 MHz
  '13A': 32, '13B': 33, '13C': 34, '13D': 35, '13E': 36, '13F': 37
};

const FREQ_TO_BLOCK = Object.fromEntries(
  Object.entries(BLOCK_TO_FREQ).map(([k, v]) => [v, k])
);

// -----------------------------
// radio_cli actions (real flags)
// -----------------------------

// Path to frequency list file
const FREQ_LIST_PATH = process.env.FREQ_LIST_PATH || path.join(__dirname, "freq_list.txt");

async function bootDab() {
  // -b D boots into DAB mode
  // -y loads frequency list (required for tuning to work!)
  // -j requests JSON output
  if (fs.existsSync(FREQ_LIST_PATH)) {
    await runRadioCli(["-b", "D", "-y", FREQ_LIST_PATH, "-j"]);
  } else {
    logWarn(`Frequency list not found at ${FREQ_LIST_PATH}, tuning may not work`);
    await runRadioCli(["-b", "D", "-j"]);
  }
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

  // Try parsing as single JSON object
  const one = safeJsonParse(trimmed);
  if (one) {
    return normalizeEnsembleInfo(one);
  }

  // Try parsing as multiple JSON lines
  const many = parseMultiJson(res.stdout);
  if (many.length) {
    return normalizeEnsembleInfo(many[many.length - 1]);
  }

  return { raw: trimmed };
}

/**
 * Normalize ensemble info to a consistent format regardless of radio_cli version
 */
function normalizeEnsembleInfo(obj) {
  if (!obj || typeof obj !== "object") return { raw: String(obj) };

  return {
    // Try various possible key names for ensemble/mux name
    ensemble: safeGetString(obj, "ensemble", "ensemble_label", "mux", "mux_name", "label", "name"),
    // Try various possible key names for SNR
    snr: safeGetNumber(obj, "snr", "SNR", "signal_noise_ratio", "snr_db"),
    // Try various possible key names for signal strength
    rssi: safeGetNumber(obj, "rssi", "RSSI", "signal_strength", "signal"),
    // Keep the raw object for debugging
    raw: obj
  };
}

async function listServices() {
  // IMPORTANT: correct option is -g (digital_service_list), not --list-services
  const res = await runRadioCli(["-g", "-j"]);
  const trimmed = String(res.stdout || "").trim();
  if (!trimmed) return { services: [], raw: "" };

  // Try parsing as single JSON (could be array or object)
  const one = safeJsonParse(trimmed);
  if (one) {
    // If it's already an array, normalize each service
    if (Array.isArray(one)) {
      return { services: one.map(normalizeService) };
    }
    // If it's an object with a services array inside
    if (one.services && Array.isArray(one.services)) {
      return { services: one.services.map(normalizeService) };
    }
    // Single service object
    return { services: [normalizeService(one)] };
  }

  // Try parsing as multiple JSON lines
  const many = parseMultiJson(res.stdout);
  if (many.length) {
    return { services: many.map(normalizeService) };
  }

  return { services: [], raw: trimmed };
}

/**
 * Normalize service object to consistent format
 */
function normalizeService(obj) {
  if (!obj || typeof obj !== "object") return { id: String(obj), label: String(obj) };

  return {
    id: safeGetString(obj, "id", "service_id", "serviceId", "sid", "ID") || "0",
    label: safeGetString(obj, "label", "name", "service_name", "serviceName", "Label", "Name") || "Unknown",
    componentId: safeGetString(obj, "component_id", "componentId", "cid") || "0",
    // Keep original for debugging
    raw: obj
  };
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
// Audio Monitor
// -----------------------------

/**
 * Start audio level monitoring using arecord
 * Returns an object with stop() method
 */
function createAudioMonitor(onLevel, onError) {
  if (!checkArecordExists()) {
    onError(new Error("arecord not found. Install alsa-utils package."));
    return null;
  }

  const proc = spawn("arecord", [
    "-D", AUDIO_DEVICE,
    "-c", "2",
    "-r", "48000",
    "-f", "S16_LE",
    "-vv"
  ]);

  let buffer = "";
  let stopped = false;

  proc.on("error", (err) => {
    if (!stopped) {
      logErr(`arecord error: ${err.message}`);
      onError(new Error(`Failed to start audio monitor: ${err.message}`));
    }
  });

  proc.stderr.on("data", (data) => {
    if (stopped) return;

    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      // arecord -vv outputs lines like:
      // "Max peak (12000 samples): 0x00007fff 0x00007fff"
      // or with VU meter: "###############            89%"
      // or: "Peak    0.95       -0.91 dB"

      // Try percentage format first (most common with -vv)
      let match = line.match(/(\d+)%/);
      if (match) {
        const level = parseInt(match[1], 10) / 100;
        onLevel(Math.max(0, Math.min(1, level)));
        continue;
      }

      // Try decimal peak format
      match = line.match(/Peak\s+([0-9.]+)/i);
      if (match) {
        const level = parseFloat(match[1]);
        if (!isNaN(level)) {
          onLevel(Math.max(0, Math.min(1, level)));
          continue;
        }
      }

      // Try hex peak format (convert to percentage)
      match = line.match(/0x([0-9a-fA-F]+)/);
      if (match) {
        const hexVal = parseInt(match[1], 16);
        const level = hexVal / 0x7fff; // 16-bit signed max
        onLevel(Math.max(0, Math.min(1, level)));
      }
    }
  });

  proc.on("close", (code) => {
    if (!stopped && code !== 0) {
      logWarn(`arecord exited with code ${code}`);
    }
  });

  return {
    stop() {
      stopped = true;
      try {
        proc.kill("SIGTERM");
      } catch {}
    }
  };
}

// -----------------------------
// Server Initialization
// -----------------------------

// Pre-flight checks
logInfo("Starting uGreen DAB Web Interface...");

if (!isRoot()) {
  logWarn("Server not running as root. radio_cli commands will fail.");
  console.warn("WARNING: Server not running as root. radio_cli commands will fail.");
}

if (!checkRadioCliExists()) {
  logWarn(`radio_cli not found at ${RADIO_CLI_PATH}. Run ugreen_install.sh first.`);
  console.warn(`WARNING: radio_cli not found at ${RADIO_CLI_PATH}`);
}

if (!checkArecordExists()) {
  logWarn("arecord not found. Audio monitoring will not work. Install alsa-utils.");
  console.warn("WARNING: arecord not found. Audio monitoring disabled.");
}

ensureDir(LOG_DIR);
ensureDir(DATA_DIR);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    root: isRoot(),
    radioCliPath: RADIO_CLI_PATH,
    radioCliExists: checkRadioCliExists(),
    arecordExists: checkArecordExists(),
    time: nowIso(),
  });
});

// API endpoint to get current status
app.get("/api/status", (_req, res) => {
  res.json({
    root: isRoot(),
    radioCliPath: RADIO_CLI_PATH,
    radioCliExists: checkRadioCliExists(),
    audioDevice: AUDIO_DEVICE,
    arecordExists: checkArecordExists(),
    logDir: LOG_DIR,
    dataDir: DATA_DIR,
  });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  logInfo(`Client connected: ${socket.id}`);

  socket.emit("status", {
    ok: true,
    message: "Connected",
    detail: {
      root: isRoot(),
      radioCliPath: RADIO_CLI_PATH,
      radioCliExists: checkRadioCliExists(),
      arecordExists: checkArecordExists(),
      time: nowIso(),
    },
  });

  const sendError = (err) => {
    const msg = err?.message || String(err);
    socket.emit("error", { message: msg });
    logErr(msg);
  };

  // Scan all DAB blocks
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
                snr: info.snr || 0,
                rssi: info.rssi || null
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

  // Scan a single block
  socket.on("scanBlock", async (block) => {
    try {
      // Validate block name
      if (!BLOCK_TO_FREQ.hasOwnProperty(block)) {
        throw new Error(`Invalid block name: ${block}`);
      }

      await bootDab();
      await tuneBlock(block);
      const info = await getEnsembleInfo().catch(() => null);

      if (info && info.ensemble) {
        socket.emit("blockResult", {
          block,
          result: {
            mux: info.ensemble,
            snr: info.snr || 0,
            rssi: info.rssi || null
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

  // List services on current tuned multiplex
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

  // Select a service by ID
  socket.on("selectService", async (data) => {
    try {
      // Handle both formats: just serviceId or { serviceId, componentId }
      let serviceId, componentId = 0;
      if (typeof data === "object" && data !== null) {
        serviceId = data.serviceId || data.id || data;
        componentId = data.componentId || 0;
      } else {
        serviceId = data;
      }

      const sid = parseServiceId(serviceId);
      const cid = parseComponentId(componentId);
      await selectService(sid, cid);
      socket.emit("serviceSelected", { success: true, serviceId: sid });
    } catch (err) {
      socket.emit("serviceSelected", { success: false, error: err.message });
    }
  });

  // Get metadata (DLS text) for current service
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

  // Get server logs
  socket.on("getLogs", async () => {
    try {
      if (fs.existsSync(LOG_PATH)) {
        const logs = fs.readFileSync(LOG_PATH, "utf8");
        const lines = logs.split("\n");
        // Return last 500 lines
        const lastLines = lines.slice(-500).join("\n");
        socket.emit("logs", lastLines);
      } else {
        socket.emit("logs", "Aucun log disponible");
      }
    } catch (err) {
      socket.emit("logs", `Erreur lors de la lecture des logs: ${err.message}`);
    }
  });

  // Audio monitoring
  let audioMonitor = null;

  socket.on("startAudioMonitor", () => {
    if (audioMonitor) {
      return; // Already running
    }

    audioMonitor = createAudioMonitor(
      (level) => {
        socket.emit("audioLevel", level);
      },
      (err) => {
        socket.emit("error", { message: `Audio monitor error: ${err.message}` });
        audioMonitor = null;
      }
    );

    if (!audioMonitor) {
      socket.emit("error", { message: "Failed to start audio monitor" });
    }
  });

  socket.on("stopAudioMonitor", () => {
    if (audioMonitor) {
      audioMonitor.stop();
      audioMonitor = null;
    }
  });

  // Cleanup on disconnect
  socket.on("disconnect", () => {
    logInfo(`Client disconnected: ${socket.id}`);
    if (audioMonitor) {
      audioMonitor.stop();
      audioMonitor = null;
    }
  });
});

server.listen(PORT, HOST, () => {
  const msg = `Server listening on http://${HOST}:${PORT}`;
  appendLog(`[${nowIso()}] ${msg}`);
  console.log(msg);
});

// Clean shutdown
function shutdown(signal) {
  logInfo(`Received ${signal}, shutting down...`);
  server.close(() => {
    logInfo("Server closed");
    process.exit(0);
  });

  // Force exit after 5 seconds
  setTimeout(() => {
    logWarn("Forced shutdown after timeout");
    process.exit(1);
  }, 5000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
