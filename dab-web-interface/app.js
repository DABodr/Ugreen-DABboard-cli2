/*
 * uGreen DAB web interface server
 *
 * This Node.js application exposes a modern web interface for controlling the
 * uGreen DAB board.  It starts an Express HTTP server on port 9595 and
 * uses Socket.IO for bidirectional communication with the browser.  The
 * back‑end interacts with the uGreen radio_cli binary through the
 * child_process module.  All radio_cli output is requested in JSON form
 * (supported since radio_cli v2 according to uGreen’s announcement【869267402104673†L31-L35】) so that it can be parsed and sent
 * directly to the front‑end.  The individual helper functions defined
 * here wrap calls to radio_cli and hide the asynchronous execution
 * details.  The API surface is intentionally minimal — scanning blocks,
 * retrieving multiplex/service information, tuning and fetching DLS/DL+/SLS
 * metadata — but additional commands can easily be added when the radio_cli
 * documentation becomes available.  All executed commands and their
 * outputs are also streamed into a log file to provide visibility for
 * debugging.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration: path to radio_cli binary and log file
// These values can be overridden via environment variables.  When
// installing the web interface with our setup script the symlink
// `/usr/local/sbin/radio_cli` is created automatically.  Expose
// RADR settings here so they may be customised without editing the
// code.  You may also supply a timeout for radio_cli calls via
// RADIO_CLI_TIMEOUT_MS.  See .env.example for typical values.
const RADIO_CLI_PATH = process.env.RADIO_CLI_PATH || '/usr/local/sbin/radio_cli';
const LOG_PATH = path.join(__dirname, 'radio.log');

// CLI option map.  Older and newer versions of radio_cli have
// different short and long option names (e.g. `-b D` vs
// `--boot=D`).  To accommodate this, all options are defined here
// in one place.  If your version uses different flags just set
// the corresponding environment variables (e.g. RADIO_CLI_BOOT="-b",
// RADIO_CLI_FREQUENCY="-f", etc.) or edit this object.  The
// `jsonFlag` determines which switch enables JSON output; if your
// binary always outputs JSON, you may set this to an empty string.
const RADIO_CLI_OPTIONS = {
  boot: process.env.RADIO_CLI_BOOT || '--boot=D',
  frequency: process.env.RADIO_CLI_FREQUENCY || '--frequency',
  listServices: process.env.RADIO_CLI_LIST_SERVICES || '--list-services',
  serviceId: process.env.RADIO_CLI_SERVICE_ID || '--service-id',
  getDls: process.env.RADIO_CLI_GET_DLS || '--get-dls',
  getDlPlus: process.env.RADIO_CLI_GET_DLPLUS || '--get-dlplus',
  getSls: process.env.RADIO_CLI_GET_SLS || '--get-sls',
  jsonFlag: process.env.RADIO_CLI_JSON_FLAG || '-j'
};

// Global timeout (ms) for radio_cli operations.  Long‑running
// commands are killed after this period and the promise is
// rejected.  This prevents the application from hanging
// indefinitely if the radio_cli process becomes unresponsive.
const RADIO_CLI_TIMEOUT_MS = parseInt(process.env.RADIO_CLI_TIMEOUT_MS, 10) || 30000;

// Configuration for audio monitoring.  When using I2S output the audio
// device exposed by the uGreen overlay is typically named
// 'sysdefault:CARD=dabboard'.  If your system uses a different
// identifier, set it here.  Note that audio level monitoring requires
// that the audio stream is available on the Raspberry Pi; this is only
// possible if the board is configured in I2S mode【776467023307590†L120-L130】.
const AUDIO_DEVICE = process.env.AUDIO_DEVICE || 'sysdefault:CARD=dabboard';

// Holder for the arecord process
let audioMonitorProc = null;

// DAB block whitelist.  Only blocks included here may be scanned.
// This list mirrors the blocks defined in the client.  By
// validating against this array we prevent arbitrary strings from
// being passed to radio_cli.
const VALID_BLOCKS = [
  '5A','5B','5C','5D','6A','6B','6C','6D','7A','7B','7C','7D','7E','7F',
  '8A','8B','8C','8D','8E','8F','9A','9B','9C','9D','9E','9F',
  '10A','10B','10C','10D','10E','10F',
  '11A','11B','11C','11D','11E','11F',
  '12A','12B','12C','12D','12E','12F',
  '13A','13B','13C','13D','13E','13F'
];

// Helper to validate a DAB block.  Returns true if the block
// exists in VALID_BLOCKS; false otherwise.
function isValidBlock(block) {
  return typeof block === 'string' && VALID_BLOCKS.includes(block.toUpperCase());
}

// Helper to validate a service identifier.  Service IDs are
// typically alphanumeric strings with no whitespace or special
// characters.  Adjust the regex if your version uses a
// different format.
function isValidServiceId(id) {
  return typeof id === 'string' && /^[0-9A-Za-z]+$/.test(id);
}

/**
 * Start monitoring the audio level using arecord.  This spawns a
 * long‑running process capturing audio from the specified device.  The
 * '-vv' flag prints peak and average levels.  Parsed levels are
 * emitted via the supplied callback.  Returns a function that
 * terminates the process.
 *
 * @param {function(number)} onLevel Callback invoked with a level between 0 and 1
 */
function startAudioMonitor(onLevel) {
  // Use '-c 1' (mono) and '-V mono' to get a simple VU meter.  If '-V'
  // is unavailable, '-vv' prints peak values that can be parsed.
  const args = ['-D', AUDIO_DEVICE, '-c', '2', '-r', '48000', '-f', 'S16_LE', '-vv'];
  audioMonitorProc = spawn('arecord', args);
  let buf = '';
  audioMonitorProc.stderr.on('data', (data) => {
    buf += data.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach((line) => {
      // Example line: "Peak    0.95       -0.91 dB"
      const match = line.match(/Peak\s+([0-9.]+)/);
      if (match) {
        const peak = parseFloat(match[1]);
        // Clamp and normalise between 0 and 1 (0..1)
        const level = Math.max(0, Math.min(1, peak));
        onLevel(level);
      }
    });
  });
  audioMonitorProc.on('close', () => {
    audioMonitorProc = null;
  });

  // Listen for errors from arecord (e.g. device not found).  When
  // these occur append to the log so the administrator can
  // troubleshoot the audio setup.
  audioMonitorProc.on('error', (err) => {
    appendLog('ERR', `audio monitor error: ${err.message}`);
  });
  return () => {
    if (audioMonitorProc) audioMonitorProc.kill('SIGINT');
  };
}

// Ensure the log file exists
fs.closeSync(fs.openSync(LOG_PATH, 'a'));

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve the static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Start the HTTP server
const PORT = process.env.PORT || 9595;
server.listen(PORT, () => {
  console.log(`uGreen DAB web interface listening on port ${PORT}`);
});

// Helper: append log entry
function appendLog(type, message) {
  const timestamp = new Date().toISOString();
  fs.appendFileSync(LOG_PATH, `[${timestamp}] ${type}: ${message}\n`);
}

/**
 * Execute the radio_cli binary with the specified arguments.  All calls
 * automatically append '-j' to request JSON responses.  Returns a
 * Promise that resolves with the parsed JSON (if available) or the raw
 * stdout string when parsing fails.  Rejects if the command exits with
 * non‑zero status.
 *
 * @param {string[]} args Additional arguments to pass to radio_cli
 */
function callRadioCli(args) {
  return new Promise((resolve, reject) => {
    // Always request JSON output when possible.  Append the
    // configured JSON flag unless it is empty.
    const cliArgs = [...args];
    if (RADIO_CLI_OPTIONS.jsonFlag) {
      cliArgs.push(RADIO_CLI_OPTIONS.jsonFlag);
    }
    appendLog('CMD', `${RADIO_CLI_PATH} ${cliArgs.join(' ')}`);
    const proc = spawn(RADIO_CLI_PATH, cliArgs);
    let stdout = '';
    let stderr = '';
    // Setup timeout; kill the process if it exceeds the limit
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      const msg = `radio_cli timeout after ${RADIO_CLI_TIMEOUT_MS}ms`;
      appendLog('ERR', msg);
      reject(new Error(msg));
    }, RADIO_CLI_TIMEOUT_MS);
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      appendLog('OUT', stdout.trim());
      if (stderr) appendLog('ERR', stderr.trim());
      if (code === 0) {
        // Try to parse JSON output; fall back to raw
        try {
          const json = JSON.parse(stdout);
          resolve(json);
        } catch (ex) {
          resolve(stdout.trim());
        }
      } else {
        reject(new Error(`radio_cli exited with code ${code}: ${stderr.trim()}`));
      }
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      appendLog('ERR', `Failed to spawn radio_cli: ${err.message}`);
      reject(err);
    });
  });
}

/**
 * Scan a single DAB block.  This function boots the Si468x into DAB mode
 * (if not already done) and tunes to a specific block.  The SNR and
 * multiplex name are returned if a signal is present.  The exact
 * arguments used here may need adjustment based on the version of
 * radio_cli; the '--frequency' option is documented in early announcements
 *【362693199190379†L31-L42】.  If the block has no signal this call resolves with null.
 *
 * @param {string} block DAB block (e.g. '5A', '11D')
 */
async function scanBlock(block) {
  // Validate block parameter to avoid malicious input
  if (!isValidBlock(block)) {
    throw new Error(`invalid DAB block: ${block}`);
  }
  // Boot into DAB mode using the configured boot option.  Some
  // versions of radio_cli expect the mode separated by a space (e.g.
  // '-b', 'D') while others accept '--boot=D'.  Provide both parts
  // accordingly.
  const bootArg = RADIO_CLI_OPTIONS.boot;
  if (bootArg.includes('=')) {
    await callRadioCli([bootArg]);
  } else {
    // Split into flag and value if no '=' is present
    const [flag, value] = bootArg.split(' ');
    await callRadioCli([flag, value]);
  }
  // Tune to the specified block using the configured frequency option
  const freqOpt = RADIO_CLI_OPTIONS.frequency;
  let freqArgs;
  if (freqOpt.includes('=')) {
    // Option already contains '=' (unlikely), append value directly
    freqArgs = [`${freqOpt}${block}`];
  } else {
    freqArgs = [freqOpt, block];
  }
  const result = await callRadioCli(freqArgs);
  // Expect JSON output with fields like { snr: ..., mux: ..., services: [...] }
  if (result && typeof result === 'object') {
    return result;
  }
  return null;
}

/**
 * Retrieve the list of services for a tuned multiplex.  The radio must
 * already be tuned to a block.  Returns an array of service objects with
 * id and label.  This example assumes radio_cli supports '--list-services'.
 */
async function listServices() {
  const listOpt = RADIO_CLI_OPTIONS.listServices;
  const args = listOpt.includes('=') ? [listOpt] : [listOpt];
  const result = await callRadioCli(args);
  if (Array.isArray(result)) {
    return result;
  }
  return [];
}

/**
 * Select a service by ID.  After selecting a service, you can call
 * getMetadata() to retrieve DLS, DL+ and SLS information.  This
 * example assumes radio_cli supports '--service-id'.
 *
 * @param {string} serviceId The service identifier (often an integer)
 */
async function selectService(serviceId) {
  // Validate serviceId to avoid injection
  if (!isValidServiceId(serviceId)) {
    throw new Error(`invalid service identifier: ${serviceId}`);
  }
  const opt = RADIO_CLI_OPTIONS.serviceId;
  let args;
  if (opt.includes('=')) {
    args = [`${opt}${serviceId}`];
  } else {
    args = [opt, serviceId];
  }
  await callRadioCli(args);
}

/**
 * Fetch metadata for the currently tuned service.  The radio_cli tool
 * exposes separate options for DLS (text), DL+ (enhanced text) and
 * SLS (slideshow images).  This helper aggregates them into a single
 * object.  For SLS images the base64 encoded data is returned.
 */
async function getMetadata() {
  const dlsOpt = RADIO_CLI_OPTIONS.getDls;
  const dlPlusOpt = RADIO_CLI_OPTIONS.getDlPlus;
  const slsOpt = RADIO_CLI_OPTIONS.getSls;
  const dlsArgs = dlsOpt.includes('=') ? [dlsOpt] : [dlsOpt];
  const dlPlusArgs = dlPlusOpt.includes('=') ? [dlPlusOpt] : [dlPlusOpt];
  const slsArgs = slsOpt.includes('=') ? [slsOpt] : [slsOpt];
  const dls = await callRadioCli(dlsArgs).catch(() => '');
  const dlPlus = await callRadioCli(dlPlusArgs).catch(() => '');
  const sls = await callRadioCli(slsArgs).catch(() => '');
  return { dls, dlPlus, sls };
}

/**
 * Socket.IO event handlers.  When a client connects it can emit
 * 'scanAllBlocks' to perform a sequential scan of blocks 5A–13F.  As
 * each block finishes the server emits 'blockResult' with the block
 * identifier and result.  Clients can request the service list and
 * metadata through the respective events.  All results include a
 * timestamp for auditing.
 */
io.on('connection', (socket) => {
  console.log('Client connected');
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });

  socket.on('scanAllBlocks', async () => {
    const blocks = [
      '5A','5B','5C','5D','6A','6B','6C','6D','7A','7B','7C','7D','7E','7F',
      '8A','8B','8C','8D','8E','8F','9A','9B','9C','9D','9E','9F',
      '10A','10B','10C','10D','10E','10F',
      '11A','11B','11C','11D','11E','11F',
      '12A','12B','12C','12D','12E','12F',
      '13A','13B','13C','13D','13E','13F'
    ];
    for (const block of blocks) {
      try {
        const res = await scanBlock(block);
        socket.emit('blockResult', { block, result: res, time: Date.now() });
      } catch (err) {
        socket.emit('blockResult', { block, error: err.message, time: Date.now() });
      }
    }
  });

  // Allow scanning of a single block on demand
  socket.on('scanBlock', async (block) => {
    try {
      const res = await scanBlock(block);
      socket.emit('blockResult', { block, result: res, time: Date.now() });
    } catch (err) {
      socket.emit('blockResult', { block, error: err.message, time: Date.now() });
    }
  });

  socket.on('listServices', async () => {
    try {
      const services = await listServices();
      socket.emit('services', services);
    } catch (err) {
      socket.emit('services', []);
    }
  });

  socket.on('selectService', async (serviceId) => {
    try {
      await selectService(serviceId);
      socket.emit('serviceSelected', { success: true });
    } catch (err) {
      socket.emit('serviceSelected', { success: false, error: err.message });
    }
  });

  socket.on('getMetadata', async () => {
    try {
      const metadata = await getMetadata();
      socket.emit('metadata', metadata);
    } catch (err) {
      socket.emit('metadata', { error: err.message });
    }
  });

  socket.on('getLogs', async () => {
    fs.readFile(LOG_PATH, 'utf8', (err, data) => {
      if (err) {
        socket.emit('logs', 'Failed to read log file');
      } else {
        socket.emit('logs', data);
      }
    });
  });

  // Start audio monitoring.  When called, a long‑running arecord process
  // will be launched.  Parsed levels are sent back to the client via
  // 'audioLevel' events.  The returned function allows the process to
  // be terminated.
  let stopAudio = null;
  socket.on('startAudioMonitor', () => {
    if (stopAudio) return; // already running
    stopAudio = startAudioMonitor((level) => {
      socket.emit('audioLevel', level);
    });
  });
  socket.on('stopAudioMonitor', () => {
    if (stopAudio) {
      stopAudio();
      stopAudio = null;
    }
  });
});