#!/usr/bin/env node
"use strict";

const fs      = require("fs");
const path    = require("path");
const http    = require("http");
const express = require("express");
const { Server }  = require("socket.io");
const { spawn, execSync } = require("child_process");

// ============================================================
// Configuration
// ============================================================

const RADIO_CLI_PATH = process.env.RADIO_CLI_PATH || "/usr/local/sbin/radio_cli";
const AUDIO_DEVICE   = process.env.AUDIO_DEVICE   || "sysdefault:CARD=dabboard";

const RADIO_CLI_TIMEOUT_MS          = Number(process.env.RADIO_CLI_TIMEOUT_MS          || 30_000);
const RADIO_CLI_FULLSCAN_TIMEOUT_MS = Number(process.env.RADIO_CLI_FULLSCAN_TIMEOUT_MS || 180_000);

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const LOG_DIR        = process.env.LOG_DIR        || path.join(__dirname, "logs");
const LOG_PATH       = process.env.LOG_PATH       || path.join(LOG_DIR, "radio.log");
const DATA_DIR       = process.env.DATA_DIR       || path.join(__dirname, "data");
const FREQ_LIST_PATH = process.env.FREQ_LIST_PATH || path.join(__dirname, "freq_list.txt");

const DLS_POLL_MS = 8_000;   // polling DLS DAB+
const RDS_POLL_MS = 5_000;   // polling RDS FM

// ============================================================
// Radio State (partagé — une seule puce Si4688)
// ============================================================

const radioState = {
  mode:        null,   // 'dab' | 'fm' | null
  isBooted:    false,
  freqIndex:   null,   // DAB : index 0-37
  fmFreqKhz:  null,   // FM  : fréquence en kHz
  serviceId:   null,
  componentId: null,
  i2sEnabled:  false,
  volume:      40,
};

// ============================================================
// Helpers — Logging
// ============================================================

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function nowIso()     { return new Date().toISOString(); }

function appendLog(line) {
  try { ensureDir(path.dirname(LOG_PATH)); fs.appendFileSync(LOG_PATH, line + "\n", "utf8"); }
  catch (e) { console.error("LOG ERROR:", e?.message); }
}
function logCmd(cmd, args) { appendLog(`[${nowIso()}] CMD: ${cmd} ${args.join(" ")}`); }
function logOut(out) {
  const t = String(out || "").trimEnd();
  if (!t) return;
  t.split("\n").forEach(l => appendLog(`[${nowIso()}] OUT: ${l}`));
}
function logErr(err) {
  const t = String(err || "").trimEnd();
  if (!t) return;
  t.split("\n").forEach(l => appendLog(`[${nowIso()}] ERR: ${l}`));
}
function logInfo(msg) { appendLog(`[${nowIso()}] INFO: ${msg}`); console.log(`[INFO] ${msg}`); }
function logWarn(msg) { appendLog(`[${nowIso()}] WARN: ${msg}`); console.warn(`[WARN] ${msg}`); }

// ============================================================
// Helpers — Checks
// ============================================================

function isRoot() { return typeof process.getuid === "function" && process.getuid() === 0; }

function checkRadioCliExists() {
  try { fs.accessSync(RADIO_CLI_PATH, fs.constants.X_OK); return true; } catch { return false; }
}
function checkArecordExists() {
  try { execSync("which arecord", { stdio: "ignore" }); return true; } catch { return false; }
}

// ============================================================
// Helpers — Parsing
// ============================================================

function parseIntStrict(value, name) {
  if (value === undefined || value === null) throw new Error(`${name} is required`);
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) throw new Error(`${name} must be an integer`);
  const n = Number(s);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} is invalid`);
  return n;
}
function parseFrequencyIndex(v) {
  const n = parseIntStrict(v, "frequencyIndex");
  if (n < 0 || n > 200) throw new Error("frequencyIndex out of range");
  return n;
}
function parseServiceId(v) {
  const n = parseIntStrict(v, "serviceId");
  if (n < 0 || n > 999999) throw new Error("serviceId out of range");
  return n;
}
function parseComponentId(v) {
  if (v === undefined || v === null || v === "") return 0;
  const n = parseIntStrict(v, "componentId");
  if (n < 0 || n > 9999) throw new Error("componentId out of range");
  return n;
}
function parseFmFrequencyKhz(v) {
  const n = parseFloat(String(v).trim());
  if (isNaN(n)) throw new Error("Fréquence FM invalide");
  // Si la valeur est < 1000, on l'interprète en MHz → conversion kHz
  const khz = n < 1000 ? Math.round(n * 10) * 100 : Math.round(n / 100) * 100;
  if (khz < 87_500 || khz > 108_000) throw new Error("Fréquence FM hors plage (87.5–108 MHz)");
  return khz;
}
function parseVolumeLevel(v) {
  const n = parseInt(String(v), 10);
  if (isNaN(n)) throw new Error("Niveau volume invalide");
  return Math.max(0, Math.min(63, n));
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}
function parseMultiJson(stdout) {
  return String(stdout || "").trim().split("\n")
    .map(l => safeJsonParse(l.trim())).filter(Boolean);
}
function safeGetNumber(obj, ...keys) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj[k] !== null) {
      const n = typeof obj[k] === "number" ? obj[k] : parseFloat(obj[k]);
      if (!isNaN(n)) return n;
    }
  }
  return null;
}
function safeGetString(obj, ...keys) {
  for (const k of keys) {
    if (obj?.[k] !== undefined && obj[k] !== null) return String(obj[k]);
  }
  return null;
}

// ============================================================
// runRadioCli
// ============================================================

function runRadioCli(args, { timeoutMs = RADIO_CLI_TIMEOUT_MS, cwd = DATA_DIR } = {}) {
  return new Promise((resolve, reject) => {
    if (!isRoot())            return reject(new Error("radio_cli doit tourner en root."));
    if (!checkRadioCliExists()) return reject(new Error(`radio_cli introuvable à ${RADIO_CLI_PATH}.`));

    ensureDir(cwd);
    logCmd(RADIO_CLI_PATH, args);

    let stdout = "", stderr = "", killed = false;
    const child = spawn(RADIO_CLI_PATH, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch {}
      const e = new Error(`radio_cli timeout (${Math.round(timeoutMs / 1000)}s)`);
      e.code = "ETIMEDOUT";
      logErr(e.message);
      reject(e);
    }, timeoutMs);

    child.on("error", err => { clearTimeout(timer); const m = `spawn error: ${err?.message}`; logErr(m); reject(new Error(m)); });
    child.stdout.on("data", buf => (stdout += buf.toString("utf8")));
    child.stderr.on("data", buf => (stderr += buf.toString("utf8")));
    child.on("close", code => {
      clearTimeout(timer);
      if (killed) return;
      logOut(stdout); logErr(stderr);
      resolve({ stdout, stderr, code });
    });
  });
}

// ============================================================
// Block ↔ Frequency index mapping (Band III Europe)
// ============================================================

const BLOCK_TO_FREQ = {
  "5A": 0,  "5B": 1,  "5C": 2,  "5D": 3,
  "6A": 4,  "6B": 5,  "6C": 6,  "6D": 7,
  "7A": 8,  "7B": 9,  "7C": 10, "7D": 11,
  "8A": 12, "8B": 13, "8C": 14, "8D": 15,
  "9A": 16, "9B": 17, "9C": 18, "9D": 19,
  "10A": 20, "10N": 21, "10B": 22, "10C": 23, "10D": 24,
  "11A": 25, "11N": 26, "11B": 27, "11C": 28, "11D": 29,
  "12A": 30, "12N": 31, "12B": 32, "12C": 33, "12D": 34,
  "13A": 35, "13B": 36, "13C": 37, "13D": 38, "13E": 39, "13F": 40,
};

// ============================================================
// Boot intelligent — n'effectue un reboot que si nécessaire
// ============================================================

async function ensureBootedDab() {
  if (radioState.isBooted && radioState.mode === "dab") return;
  logInfo("Boot firmware DAB...");
  const args = ["-b", "D"];
  if (radioState.i2sEnabled) args.push("-o", "1"); else args.push("-o", "0");
  if (fs.existsSync(FREQ_LIST_PATH)) args.push("-y", FREQ_LIST_PATH);
  args.push("-j");
  await runRadioCli(args);
  radioState.mode      = "dab";
  radioState.isBooted  = true;
  radioState.freqIndex = null;
  radioState.fmFreqKhz = null;
}

async function ensureBootedFm() {
  if (radioState.isBooted && radioState.mode === "fm") return;
  logInfo("Boot firmware FMHD...");
  const args = ["-b", "F", "-R", "E", "-j"];
  if (radioState.i2sEnabled) args.push("-o", "1"); else args.push("-o", "0");
  await runRadioCli(args);
  radioState.mode      = "fm";
  radioState.isBooted  = true;
  radioState.freqIndex = null;
  radioState.fmFreqKhz = null;
}

// ============================================================
// Actions DAB
// ============================================================

async function tuneFrequencyIndex(idx) {
  const n = parseFrequencyIndex(idx);
  const args = fs.existsSync(FREQ_LIST_PATH)
    ? ["-y", FREQ_LIST_PATH, "-f", String(n), "-j"]
    : ["-f", String(n), "-j"];
  const res = await runRadioCli(args);
  radioState.freqIndex = n;
  return res;
}

async function tuneBlock(block) {
  const idx = BLOCK_TO_FREQ[block];
  if (idx === undefined) throw new Error(`Bloc inconnu : ${block}`);
  return tuneFrequencyIndex(idx);
}

async function getEnsembleInfo() {
  const res = await runRadioCli(["-G", "-j"]);
  const t   = String(res.stdout || "").trim();
  if (!t) return { raw: "" };
  const one = safeJsonParse(t);
  if (one) return normalizeEnsembleInfo(one);
  const many = parseMultiJson(res.stdout);
  if (many.length) return normalizeEnsembleInfo(many[many.length - 1]);
  return { raw: t };
}

function normalizeEnsembleInfo(obj) {
  if (!obj || typeof obj !== "object") return { raw: String(obj) };
  return {
    ensemble: safeGetString(obj, "ensemble", "ensemble_label", "mux", "label", "name"),
    snr:      safeGetNumber(obj, "snr", "SNR", "snr_db"),
    rssi:     safeGetNumber(obj, "rssi", "RSSI", "signal_strength"),
    raw:      obj,
  };
}

async function listServices() {
  const res = await runRadioCli(["-g", "-j"]);
  const t   = String(res.stdout || "").trim();
  if (!t) return { services: [] };
  const one = safeJsonParse(t);
  if (one) {
    if (Array.isArray(one))           return { services: one.map(normalizeService) };
    if (Array.isArray(one.services))  return { services: one.services.map(normalizeService) };
    return { services: [normalizeService(one)] };
  }
  const many = parseMultiJson(res.stdout);
  if (many.length) return { services: many.map(normalizeService) };
  return { services: [], raw: t };
}

function normalizeService(obj) {
  if (!obj || typeof obj !== "object") return { id: String(obj), label: String(obj) };
  return {
    id:          safeGetString(obj, "id", "service_id", "serviceId", "sid", "ID")             || "0",
    label:       safeGetString(obj, "label", "name", "service_name", "serviceName", "Label")  || "Unknown",
    componentId: safeGetString(obj, "component_id", "componentId", "cid")                     || "0",
    raw:         obj,
  };
}

async function selectService(serviceId, componentId = 0, volume = radioState.volume) {
  const sid = parseServiceId(serviceId);
  const cid = parseComponentId(componentId);
  const vol = parseVolumeLevel(volume);
  await runRadioCli(["-e", String(sid), "-c", String(cid), "-p", "-l", String(vol), "-j"]);
  radioState.serviceId   = sid;
  radioState.componentId = cid;
  radioState.volume      = vol;
}

async function getStationText(waitSec = 2) {
  const wt  = Math.max(1, Math.min(10, parseInt(waitSec) || 2));
  const res = await runRadioCli(["-D", "-z", String(wt), "-j"], {
    timeoutMs: RADIO_CLI_TIMEOUT_MS + wt * 1000,
  });
  const t   = String(res.stdout || "").trim();
  const obj = safeJsonParse(t);
  // radio_cli retourne {"stationText": "..."} ou {"stationText": "not loaded"}
  const text = obj?.stationText || t;
  return text === "not loaded" ? null : (text || null);
}

async function getDigradStatus() {
  const res = await runRadioCli(["-d", "-j"]);
  return safeJsonParse(String(res.stdout || "").trim()) || { raw: res.stdout };
}

async function getEnsembleDatetime() {
  const res = await runRadioCli(["-t", "-j"]);
  return { datetime: String(res.stdout || "").trim() };
}

async function getChipInfo() {
  const res = await runRadioCli(["-i", "-j"]);
  return safeJsonParse(String(res.stdout || "").trim()) || { raw: res.stdout };
}

async function fullScan() {
  await runRadioCli(["-b", "D", "-u", "-j"], {
    timeoutMs: RADIO_CLI_FULLSCAN_TIMEOUT_MS,
    cwd: DATA_DIR,
  });
  radioState.mode     = "dab";
  radioState.isBooted = true;
  const scanFile = path.join(DATA_DIR, "full_scan.json");
  if (!fs.existsSync(scanFile)) throw new Error(`full_scan.json introuvable (${scanFile})`);
  return safeJsonParse(fs.readFileSync(scanFile, "utf8")) || {};
}

// ============================================================
// Actions FM
// ============================================================

async function tuneFm(freqKhz) {
  const freq = parseFmFrequencyKhz(freqKhz);
  await runRadioCli(["-F", String(freq), "-j"]);
  // Appliquer le volume après syntonisation
  await runRadioCli(["-l", String(radioState.volume), "-j"]).catch(() => {});
  radioState.fmFreqKhz = freq;
  return freq;
}

async function fmStepNext()     { await runRadioCli(["-x", "-j"]); }
async function fmStepPrev()     { await runRadioCli(["-X", "-j"]); }

async function getRdsStatus() {
  const res = await runRadioCli(["-r", "-j"]);
  return safeJsonParse(String(res.stdout || "").trim()) || { raw: res.stdout };
}

// ============================================================
// Volume / I²S
// ============================================================

async function setVolume(level) {
  const vol = parseVolumeLevel(level);
  await runRadioCli(["-l", String(vol), "-j"]);
  radioState.volume = vol;
  return vol;
}

async function shutdownRadio() {
  try {
    await runRadioCli(["-k"], { timeoutMs: 5_000 });
  } catch {}
  radioState.isBooted    = false;
  radioState.mode        = null;
  radioState.freqIndex   = null;
  radioState.fmFreqKhz  = null;
  radioState.serviceId   = null;
  radioState.componentId = null;
}

// ============================================================
// PollingManager — sondage périodique par socket
// ============================================================

class PollingManager {
  constructor(name) {
    this._name    = name;
    this._timer   = null;
    this._running = false;
  }
  start(fn, intervalMs) {
    this.stop();
    this._running = true;
    const tick = async () => {
      if (!this._running) return;
      try { await fn(); } catch (e) { logWarn(`${this._name} poll error: ${e?.message}`); }
      if (this._running) this._timer = setTimeout(tick, intervalMs);
    };
    this._timer = setTimeout(tick, intervalMs);
    logInfo(`${this._name} polling started (${intervalMs}ms)`);
  }
  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    logInfo(`${this._name} polling stopped`);
  }
  get running() { return this._running; }
}

// ============================================================
// Audio Monitor (VU meter via arecord)
// ============================================================

function createAudioMonitor(onLevel, onError) {
  if (!checkArecordExists()) {
    onError(new Error("arecord introuvable. Installez alsa-utils."));
    return null;
  }
  const proc = spawn("arecord", ["-D", AUDIO_DEVICE, "-c", "2", "-r", "48000", "-f", "S16_LE", "-vv"]);
  let buffer = "", stopped = false;

  proc.on("error", err => { if (!stopped) { logErr(`arecord: ${err.message}`); onError(err); } });
  proc.stderr.on("data", data => {
    if (stopped) return;
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      let m = line.match(/(\d+)%/);
      if (m)  { onLevel(Math.max(0, Math.min(1, parseInt(m[1]) / 100))); continue; }
      m = line.match(/Peak\s+([0-9.]+)/i);
      if (m)  { const l = parseFloat(m[1]); if (!isNaN(l)) { onLevel(Math.max(0, Math.min(1, l))); continue; } }
      m = line.match(/0x([0-9a-fA-F]+)/);
      if (m)  { onLevel(Math.max(0, Math.min(1, parseInt(m[1], 16) / 0x7fff))); }
    }
  });
  proc.on("close", code => { if (!stopped && code !== 0) logWarn(`arecord exit ${code}`); });
  return { stop() { stopped = true; try { proc.kill("SIGTERM"); } catch {} } };
}

// ============================================================
// Express + HTTP
// ============================================================

ensureDir(LOG_DIR);
ensureDir(DATA_DIR);
logInfo("Démarrage uGreen DAB Web Interface...");
if (!isRoot())            logWarn("Pas en root — les commandes radio_cli échoueront.");
if (!checkRadioCliExists()) logWarn(`radio_cli introuvable à ${RADIO_CLI_PATH}.`);
if (!checkArecordExists())  logWarn("arecord introuvable — monitoring audio désactivé.");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => res.json({
  ok: true, root: isRoot(), radioCliExists: checkRadioCliExists(),
  mode: radioState.mode, isBooted: radioState.isBooted, time: nowIso(),
}));
app.get("/api/status", (_req, res) => res.json({
  root: isRoot(), radioCliPath: RADIO_CLI_PATH,
  radioCliExists: checkRadioCliExists(), audioDevice: AUDIO_DEVICE,
  arecordExists: checkArecordExists(), radioState, logDir: LOG_DIR, dataDir: DATA_DIR,
}));

// ============================================================
// Socket.IO
// ============================================================

io.on("connection", socket => {
  logInfo(`Client connecté: ${socket.id}`);

  // Informer le client de l'état actuel
  socket.emit("status", {
    ok: true,
    message: "Connecté",
    detail: {
      root: isRoot(), radioCliExists: checkRadioCliExists(),
      arecordExists: checkArecordExists(),
      radioState: { mode: radioState.mode, isBooted: radioState.isBooted, volume: radioState.volume, i2sEnabled: radioState.i2sEnabled },
      time: nowIso(),
    },
  });

  const sendError = err => {
    const msg = err?.message || String(err);
    socket.emit("error", { message: msg });
    logErr(msg);
  };

  // Pollers par socket
  const dlsPoller = new PollingManager(`DLS[${socket.id.slice(0,6)}]`);
  const rdsPoller = new PollingManager(`RDS[${socket.id.slice(0,6)}]`);
  let   audioMonitor = null;

  function startDlsPolling() {
    dlsPoller.start(async () => {
      const text = await getStationText(2);
      if (text) socket.emit("dlsUpdate", { text });
    }, DLS_POLL_MS);
  }

  function startRdsPolling() {
    rdsPoller.start(async () => {
      // Radiotext
      const rt = await getStationText(2).catch(() => null);
      // Statut RDS
      const rds = await getRdsStatus().catch(() => ({}));
      socket.emit("rdsUpdate", {
        radiotext: rt || "",
        ps:     safeGetString(rds, "ps", "PS", "stationName", "station_name") || "",
        pi:     safeGetString(rds, "pi", "PI", "program_id")                  || "",
        pty:    safeGetNumber(rds, "pty", "PTY", "program_type")               ?? 0,
        tp:     !!(rds.tp  || rds.TP  || rds.traffic_program),
        ta:     !!(rds.ta  || rds.TA  || rds.traffic_announcement),
        stereo: !!(rds.stereo || rds.Stereo || rds.is_stereo),
        rssi:   safeGetNumber(rds, "rssi", "RSSI", "signal_strength", "fieldstrength"),
        freq:   radioState.fmFreqKhz,
      });
    }, RDS_POLL_MS);
  }

  // ── DAB : scan tous les blocs ──────────────────────────────
  socket.on("scanAllBlocks", async () => {
    try {
      dlsPoller.stop(); rdsPoller.stop();
      await ensureBootedDab();

      for (const [block] of Object.entries(BLOCK_TO_FREQ)) {
        try {
          await tuneBlock(block);
          const info = await getEnsembleInfo().catch(() => null);
          if (info?.ensemble) {
            socket.emit("blockResult", { block, result: { mux: info.ensemble, snr: info.snr ?? 0, rssi: info.rssi ?? null }, error: null });
          } else {
            socket.emit("blockResult", { block, result: null, error: "No signal" });
          }
        } catch (err) {
          socket.emit("blockResult", { block, result: null, error: err.message });
        }
      }
    } catch (err) { sendError(err); }
  });

  // ── DAB : scan un seul bloc ────────────────────────────────
  socket.on("scanBlock", async block => {
    try {
      dlsPoller.stop();
      if (!Object.hasOwn(BLOCK_TO_FREQ, block)) throw new Error(`Bloc invalide : ${block}`);
      await ensureBootedDab();
      await tuneBlock(block);
      const info = await getEnsembleInfo().catch(() => null);
      if (info?.ensemble) {
        socket.emit("blockResult", { block, result: { mux: info.ensemble, snr: info.snr ?? 0, rssi: info.rssi ?? null }, error: null });
      } else {
        socket.emit("blockResult", { block, result: null, error: "No signal" });
      }
    } catch (err) { socket.emit("blockResult", { block, result: null, error: err.message }); }
  });

  // ── DAB : liste des services ───────────────────────────────
  socket.on("listServices", async () => {
    try {
      const result = await listServices();
      socket.emit("services", Array.isArray(result.services) ? result.services : []);
    } catch (err) { socket.emit("services", []); sendError(err); }
  });

  // ── DAB : sélection + lecture d'un service ─────────────────
  socket.on("selectService", async data => {
    try {
      dlsPoller.stop();
      let serviceId, componentId = 0;
      if (data && typeof data === "object") {
        serviceId   = data.serviceId || data.id || data;
        componentId = data.componentId || 0;
      } else { serviceId = data; }

      await selectService(serviceId, componentId, radioState.volume);
      socket.emit("serviceSelected", { success: true, serviceId: String(serviceId) });

      // Obtenir l'heure de l'ensemble
      const dt = await getEnsembleDatetime().catch(() => null);
      if (dt?.datetime) socket.emit("ensembleDatetime", dt);

      // Lancer le polling DLS
      startDlsPolling();
    } catch (err) { socket.emit("serviceSelected", { success: false, error: err.message }); }
  });

  // ── DAB : métadonnées one-shot ─────────────────────────────
  socket.on("getMetadata", async () => {
    try {
      const text = await getStationText(3);
      socket.emit("dlsUpdate", { text: text || "" });
    } catch (err) { socket.emit("error", { message: err.message }); }
  });

  // ── DAB : statut digrad ────────────────────────────────────
  socket.on("getDigradStatus", async () => {
    try { socket.emit("diagStatus", await getDigradStatus()); }
    catch (err) { sendError(err); }
  });

  // ── DAB : infos puce ──────────────────────────────────────
  socket.on("getChipInfo", async () => {
    try { socket.emit("chipInfo", await getChipInfo()); }
    catch (err) { sendError(err); }
  });

  // ── FM : boot firmware FM ──────────────────────────────────
  socket.on("bootFm", async () => {
    try {
      dlsPoller.stop(); rdsPoller.stop();
      await ensureBootedFm();
      socket.emit("fmReady", { volume: radioState.volume, i2sEnabled: radioState.i2sEnabled });
    } catch (err) { sendError(err); }
  });

  // ── FM : syntonisation fréquence ───────────────────────────
  socket.on("tuneFm", async ({ freqKhz } = {}) => {
    try {
      rdsPoller.stop();
      await ensureBootedFm();
      const freq = await tuneFm(freqKhz);
      socket.emit("fmTuned", { freqKhz: freq, freqMhz: +(freq / 1000).toFixed(1) });
      // Obtenir signal initial
      const digrad = await getDigradStatus().catch(() => ({}));
      const rssi = safeGetNumber(digrad, "rssi", "RSSI", "fieldstrength");
      if (rssi !== null) socket.emit("fmSignal", { rssi });
      // Lancer polling RDS
      startRdsPolling();
    } catch (err) { sendError(err); }
  });

  // ── FM : station suivante / précédente ─────────────────────
  socket.on("fmNext", async () => {
    try {
      rdsPoller.stop();
      await fmStepNext();
      const digrad = await getDigradStatus().catch(() => ({}));
      const freq = safeGetNumber(digrad, "frequency", "freq") || radioState.fmFreqKhz;
      if (freq) {
        radioState.fmFreqKhz = freq;
        socket.emit("fmTuned", { freqKhz: freq, freqMhz: +(freq / 1000).toFixed(1) });
      }
      startRdsPolling();
    } catch (err) { sendError(err); }
  });

  socket.on("fmPrev", async () => {
    try {
      rdsPoller.stop();
      await fmStepPrev();
      const digrad = await getDigradStatus().catch(() => ({}));
      const freq = safeGetNumber(digrad, "frequency", "freq") || radioState.fmFreqKhz;
      if (freq) {
        radioState.fmFreqKhz = freq;
        socket.emit("fmTuned", { freqKhz: freq, freqMhz: +(freq / 1000).toFixed(1) });
      }
      startRdsPolling();
    } catch (err) { sendError(err); }
  });

  // ── Volume ────────────────────────────────────────────────
  socket.on("setVolume", async ({ level } = {}) => {
    try {
      const vol = await setVolume(level);
      socket.emit("volumeChanged", { level: vol });
    } catch (err) { sendError(err); }
  });

  // ── I²S toggle (appliqué au prochain boot) ────────────────
  socket.on("setI2s", ({ enable } = {}) => {
    radioState.i2sEnabled = !!enable;
    radioState.isBooted   = false; // forcer reboot au prochain usage
    socket.emit("i2sChanged", { enabled: radioState.i2sEnabled });
    logInfo(`I²S ${radioState.i2sEnabled ? "activé" : "désactivé"} — reboot requis`);
  });

  // ── Logs ──────────────────────────────────────────────────
  socket.on("getLogs", () => {
    try {
      if (!fs.existsSync(LOG_PATH)) { socket.emit("logs", "Aucun log disponible"); return; }
      const lines = fs.readFileSync(LOG_PATH, "utf8").split("\n");
      socket.emit("logs", lines.slice(-500).join("\n"));
    } catch (err) { socket.emit("logs", `Erreur logs: ${err.message}`); }
  });

  // ── Audio Monitor ─────────────────────────────────────────
  socket.on("startAudioMonitor", () => {
    if (audioMonitor) return;
    audioMonitor = createAudioMonitor(
      level => socket.emit("audioLevel", level),
      err   => { socket.emit("error", { message: `Audio: ${err.message}` }); audioMonitor = null; }
    );
    if (!audioMonitor) socket.emit("error", { message: "Impossible de démarrer le monitoring audio" });
  });

  socket.on("stopAudioMonitor", () => {
    if (audioMonitor) { audioMonitor.stop(); audioMonitor = null; }
  });

  // ── Déconnexion ───────────────────────────────────────────
  socket.on("disconnect", () => {
    logInfo(`Client déconnecté: ${socket.id}`);
    dlsPoller.stop();
    rdsPoller.stop();
    if (audioMonitor) { audioMonitor.stop(); audioMonitor = null; }
  });
});

// ============================================================
// Démarrage
// ============================================================

server.listen(PORT, HOST, () => {
  const msg = `Serveur en écoute sur http://${HOST}:${PORT}`;
  appendLog(`[${nowIso()}] ${msg}`);
  console.log(msg);
});

// Arrêt propre — éteint la puce Si468x
async function shutdown(signal) {
  logInfo(`Signal ${signal} reçu, arrêt...`);
  if (radioState.isBooted) {
    logInfo("Arrêt Si468x (-k)...");
    await shutdownRadio().catch(() => {});
  }
  server.close(() => { logInfo("Serveur fermé"); process.exit(0); });
  setTimeout(() => { logWarn("Arrêt forcé"); process.exit(1); }, 5_000);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
