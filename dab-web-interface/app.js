'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { spawn } = require('child_process');
const { Server } = require('socket.io');

// ===========================
// Configuration (env + défaut)
// ===========================
const PORT = parseInt(process.env.PORT || '9595', 10);

// Le binaire réellement exécutable (souvent /usr/local/sbin/radio_cli -> symlink)
const RADIO_CLI_PATH = process.env.RADIO_CLI_PATH || '/usr/local/sbin/radio_cli';

// radio_cli exige root -> on passe par sudo (recommandé) plutôt que faire tourner Node en root
const USE_SUDO = (process.env.USE_SUDO || '1') === '1';
const SUDO_PATH = process.env.SUDO_PATH || '/usr/bin/sudo';

// timeout pour ne pas rester bloqué
const RADIO_TIMEOUT_MS = parseInt(process.env.RADIO_TIMEOUT_MS || '30000', 10);

// log
const LOG_PATH = process.env.LOG_PATH || '/var/log/dab-web-interface/radio.log';

// anti-spam en cas d’erreur répétée
const ERROR_BACKOFF_MS = parseInt(process.env.ERROR_BACKOFF_MS || '2000', 10);

// ===========================
// Options radio_cli (selon ton --help)
// ===========================
const RADIO_CLI_OPTIONS = {
  boot: ['-b', 'D'],        // DAB firmware
  frequency: '-f',          // index numérique (pas "9A")
  listServices: '-g',       // digital_service_list (JSON uniquement avec -j)
  serviceId: '-e',
  componentId: '-c',
  play: '-p',
  volume: '-l',
  stationText: '-D',
  ensembleInfo: '-G',
  jsonFlag: '-j',
  waitTime: '-z',
  shutdown: '-k',
};

// ===========================
// DAB Block -> index (Band III EU)
// ===========================
const DAB_BLOCKS = [
  '5A','5B','5C','5D',
  '6A','6B','6C','6D',
  '7A','7B','7C','7D',
  '8A','8B','8C','8D',
  '9A','9B','9C','9D',
  '10A','10B','10C','10D',
  '11A','11B','11C','11D',
  '12A','12B','12C','12D',
  '13A','13B','13C','13D','13E','13F'
];

function blockToIndex(block) {
  if (!block || typeof block !== 'string') return null;
  const b = block.trim().toUpperCase();
  const idx = DAB_BLOCKS.indexOf(b);
  return idx >= 0 ? idx : null;
}

function safeInt(value, { min, max } = { min: 0, max: Number.MAX_SAFE_INTEGER }) {
  // accepte string/number, rejette NaN, flottants, etc.
  const n = Number(value);
  if (!Number.isInteger(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

// ===========================
// Logging robuste
// ===========================
function ensureLogFileWritable(logPath) {
  try {
    const dir = path.dirname(logPath);
    fs.mkdirSync(dir, { recursive: true });
    // Touch
    fs.appendFileSync(logPath, '');
    return logPath;
  } catch (e) {
    // fallback /tmp si permissions foireuses
    const fallback = '/tmp/dab-web-radio.log';
    try {
      fs.appendFileSync(fallback, '');
      return fallback;
    } catch {
      return null;
    }
  }
}

const EFFECTIVE_LOG_PATH = ensureLogFileWritable(LOG_PATH);

function logLine(line) {
  const ts = new Date().toISOString();
  const msg = `[${ts}] ${line}\n`;
  if (EFFECTIVE_LOG_PATH) {
    try { fs.appendFileSync(EFFECTIVE_LOG_PATH, msg); } catch {}
  }
  process.stdout.write(msg);
}

function logCmd(cmd, args) {
  logLine(`CMD: ${cmd} ${args.join(' ')}`);
}

// ===========================
// Exécution radio_cli avec timeout + capture
// ===========================
function buildRadioCommandArgs(args) {
  // args = options radio_cli
  if (!USE_SUDO) {
    return { cmd: RADIO_CLI_PATH, finalArgs: args };
  }
  return { cmd: SUDO_PATH, finalArgs: [RADIO_CLI_PATH, ...args] };
}

function runRadioCli(args, { timeoutMs = RADIO_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const { cmd, finalArgs } = buildRadioCommandArgs(args);
    logCmd(cmd, finalArgs);

    const child = spawn(cmd, finalArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill('SIGKILL'); } catch {}
      const err = new Error(`radio_cli timeout after ${timeoutMs}ms`);
      err.code = 'TIMEOUT';
      reject(err);
    }, timeoutMs);

    child.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const e = new Error(`Failed to spawn radio_cli: ${err.message}`);
      e.code = err.code || 'SPAWN_ERROR';
      reject(e);
    });

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      if (stdout.trim()) logLine(`OUT: ${stdout.trim()}`);
      if (stderr.trim()) logLine(`ERR: ${stderr.trim()}`);

      resolve({ code, stdout, stderr });
    });
  });
}

// radio_cli sort parfois du JSON "par morceaux" (ou des lignes)
// -> parse permissif: tente parse complet, sinon tente dernière ligne JSON
function parseJsonLoose(text) {
  const t = (text || '').trim();
  if (!t) return null;

  try { return JSON.parse(t); } catch {}

  // Essayons de trouver la dernière "ligne" JSON
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith('{') || line.startsWith('[')) {
      try { return JSON.parse(line); } catch {}
    }
  }
  return null;
}

// ===========================
// État minimal
// ===========================
let lastFrequencyIndex = null;
let lastErrorAt = 0;

// anti-boucle spam en cas d’échec constant
function inBackoff() {
  const now = Date.now();
  return (now - lastErrorAt) < ERROR_BACKOFF_MS;
}

function markError() {
  lastErrorAt = Date.now();
}

// ===========================
// Serveur web + Socket.IO
// ===========================
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    port: PORT,
    radioCliPath: RADIO_CLI_PATH,
    useSudo: USE_SUDO,
    logPath: EFFECTIVE_LOG_PATH,
    lastFrequencyIndex
  });
});

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  logLine('Client connected');

  socket.emit('serverInfo', {
    port: PORT,
    useSudo: USE_SUDO,
    radioCliPath: RADIO_CLI_PATH,
    logPath: EFFECTIVE_LOG_PATH
  });

  // Boot DAB firmware (optionnel: tu peux le faire au moment du scan aussi)
  socket.on('boot', async () => {
    if (inBackoff()) {
      socket.emit('errorMsg', 'Backoff actif (trop d’erreurs récentes).');
      return;
    }
    try {
      await runRadioCli([RADIO_CLI_OPTIONS.boot[0], RADIO_CLI_OPTIONS.boot[1], RADIO_CLI_OPTIONS.jsonFlag]);
      socket.emit('booted', { ok: true });
    } catch (e) {
      markError();
      socket.emit('booted', { ok: false, error: e.message, code: e.code });
    }
  });

  // scanBlock: reçoit "9A" -> index -> boot+tune+list services JSON
  socket.on('scanBlock', async (payload) => {
    if (inBackoff()) {
      socket.emit('blockResult', { ok: false, error: 'Backoff actif (trop d’erreurs récentes).' });
      return;
    }

    const block = payload?.block;
    const idx = blockToIndex(block);

    if (idx === null) {
      socket.emit('blockResult', { ok: false, error: `Block invalide: ${block}` });
      return;
    }

    lastFrequencyIndex = idx;

    try {
      // Commandes combinées: boot DAB + tune index + print service list JSON
      const args = [
        RADIO_CLI_OPTIONS.boot[0], RADIO_CLI_OPTIONS.boot[1],
        RADIO_CLI_OPTIONS.frequency, String(idx),
        RADIO_CLI_OPTIONS.listServices,
        RADIO_CLI_OPTIONS.jsonFlag
      ];

      const { stdout, code, stderr } = await runRadioCli(args);

      const json = parseJsonLoose(stdout);
      socket.emit('blockResult', {
        ok: code === 0,
        block: block.toUpperCase(),
        frequencyIndex: idx,
        raw: stdout,
        parsed: json,
        stderr: stderr || ''
      });

      // si JSON service list détecté, on le forward direct
      if (json) socket.emit('servicesList', json);
    } catch (e) {
      markError();
      socket.emit('blockResult', { ok: false, error: e.message, code: e.code });
    }
  });

  // selectService: nécessite serviceId + componentId (et un block ou index)
  socket.on('selectService', async (payload) => {
    if (inBackoff()) {
      socket.emit('serviceSelected', { ok: false, error: 'Backoff actif (trop d’erreurs récentes).' });
      return;
    }

    // sécurité: ints only
    const serviceId = safeInt(payload?.serviceId, { min: 0, max: 999999 });
    const componentId = safeInt(payload?.componentId, { min: 0, max: 999999 });

    if (serviceId === null || componentId === null) {
      socket.emit('serviceSelected', { ok: false, error: 'serviceId/componentId invalides (entiers requis).' });
      return;
    }

    let idx = null;

    if (payload?.frequencyIndex !== undefined && payload?.frequencyIndex !== null) {
      idx = safeInt(payload.frequencyIndex, { min: 0, max: DAB_BLOCKS.length - 1 });
    } else if (payload?.block) {
      idx = blockToIndex(payload.block);
    } else if (lastFrequencyIndex !== null) {
      idx = lastFrequencyIndex;
    }

    if (idx === null) {
      socket.emit('serviceSelected', { ok: false, error: 'Aucune fréquence/index fourni (scanBlock avant).' });
      return;
    }

    lastFrequencyIndex = idx;

    try {
      // Pour jouer: -f idx -e service -c component -p
      // (boot non obligatoire si déjà booté, mais on peut le mettre au besoin)
      const args = [
        RADIO_CLI_OPTIONS.frequency, String(idx),
        RADIO_CLI_OPTIONS.serviceId, String(serviceId),
        RADIO_CLI_OPTIONS.componentId, String(componentId),
        RADIO_CLI_OPTIONS.play
      ];

      const { code, stdout, stderr } = await runRadioCli(args);

      socket.emit('serviceSelected', {
        ok: code === 0,
        frequencyIndex: idx,
        serviceId,
        componentId,
        raw: stdout,
        stderr: stderr || ''
      });
    } catch (e) {
      markError();
      socket.emit('serviceSelected', { ok: false, error: e.message, code: e.code });
    }
  });

  // getMetadata: station text (non JSON)
  socket.on('getMetadata', async (payload) => {
    if (inBackoff()) {
      socket.emit('metadata', { ok: false, error: 'Backoff actif (trop d’erreurs récentes).' });
      return;
    }

    const wait = safeInt(payload?.waitTime, { min: 1, max: 10 }) ?? 2;

    try {
      const args = [
        RADIO_CLI_OPTIONS.stationText,
        RADIO_CLI_OPTIONS.waitTime, String(wait)
      ];
      const { code, stdout, stderr } = await runRadioCli(args, { timeoutMs: RADIO_TIMEOUT_MS });

      socket.emit('metadata', {
        ok: code === 0,
        waitTime: wait,
        text: (stdout || '').trim(),
        stderr: (stderr || '').trim()
      });
    } catch (e) {
      markError();
      socket.emit('metadata', { ok: false, error: e.message, code: e.code });
    }
  });

  // volume
  socket.on('setVolume', async (payload) => {
    if (inBackoff()) {
      socket.emit('volumeSet', { ok: false, error: 'Backoff actif (trop d’erreurs récentes).' });
      return;
    }
    const level = safeInt(payload?.level, { min: 0, max: 63 });
    if (level === null) {
      socket.emit('volumeSet', { ok: false, error: 'Volume invalide (0..63).' });
      return;
    }
    try {
      const args = [RADIO_CLI_OPTIONS.volume, String(level)];
      const { code, stdout, stderr } = await runRadioCli(args);
      socket.emit('volumeSet', { ok: code === 0, level, raw: stdout, stderr: stderr || '' });
    } catch (e) {
      markError();
      socket.emit('volumeSet', { ok: false, error: e.message, code: e.code });
    }
  });

  // shutdown chip
  socket.on('shutdown', async () => {
    if (inBackoff()) {
      socket.emit('shutdownResult', { ok: false, error: 'Backoff actif (trop d’erreurs récentes).' });
      return;
    }
    try {
      const { code, stdout, stderr } = await runRadioCli([RADIO_CLI_OPTIONS.shutdown]);
      socket.emit('shutdownResult', { ok: code === 0, raw: stdout, stderr: stderr || '' });
    } catch (e) {
      markError();
      socket.emit('shutdownResult', { ok: false, error: e.message, code: e.code });
    }
  });

  socket.on('disconnect', () => {
    logLine('Client disconnected');
  });
});

server.listen(PORT, () => {
  logLine(`uGreen DAB web interface listening on port ${PORT}`);
});
