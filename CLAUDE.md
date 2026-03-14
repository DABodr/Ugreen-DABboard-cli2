# CLAUDE.md — Ugreen DABboard CLI2

Interface web pour piloter la carte **uGreen DAB Board v9** sur Raspberry Pi.
Wrapper autour du binaire propriétaire `radio_cli` d'uGreen (licence non-commerciale, non distribuable).

---

## Matériel — uGreen DAB Board v9

**Puce radio :** Silicon Labs **Si4688** (DAB/DAB+/FM/FMHD, RDS/RBDS, sortie I²S)
**Connexion RPi :** bus SPI jusqu'à 10 MHz, mode 0 et 3
**Compatibilité :** Raspberry Pi 1B+, 2B, 3, 4B, **5**, Zero/Zero W
**Dimensions :** 52,1 × 20 mm — hauteur peuplée : 15,4 mm
**Alimentation :** 3,3V via pin 17 — conso max 75,9 mA / 368,9 mW
**Sorties audio :** jack 3,5 mm analogique + I²S numérique
**LED de statut :** indique l'état du pin RSTB (allumée = board active, ne pas débrancher)

### Pinout RPi (physique)

| Pin | Fonction | Description |
|-----|----------|-------------|
| 6, 9, 25, 39 | GND | Masse |
| 12 | DCLK | I²S clock |
| 16 | RSTB | Reset Si468x — **NE JAMAIS débrancher si LED allumée** |
| 17 | VDD3.3 | Alimentation 3,3V |
| 19 | MOSI | SPI master out slave in |
| 21 | MISO | SPI master in slave out |
| 22 | INTB | Interrupt |
| 23 | SCLK | SPI clock |
| 24 | SSBSI | SPI chip select Si468x |
| 26 | SSBNV | SPI chip select flash (optionnel) |
| 35 | DFS | I²S DFS |
| 38 | DOUT | I²S data out |

### config.txt requis (`/boot/config.txt`)

```ini
dtparam=i2c_arm=on
dtparam=i2s=on
dtparam=spi=on
dtparam=audio=on
dtoverlay=ugreen-dabboard
dtdebug=1
```

### Remarques critiques hardware

- **RSTB** : le Si468x peut être **endommagé de façon permanente** si RSTB est haut lors d'une coupure d'alimentation. Ne jamais débrancher la board si la LED est allumée.
- **SPI obligatoire** : activer via `sudo raspi-config` → Advanced Options → SPI
- **Root obligatoire** : l'accès GPIO (pin RSTB) nécessite les privilèges root
- **I²S** : configurer avec `-o 1` **avant** toute syntonisation ; désactiver avec `-o 0`

---

## Binaires fournis — Files_v16/

| Fichier | Version | Description |
|---------|---------|-------------|
| `radio_cli_v3.2.1` | 3.2.1 | CLI API principale (32-bit et 64-bit) |
| `DABBoardRadio_v0.17.2` | 0.17.2 | Programme terminal interactif (32-bit et 64-bit) |

**Firmware embarqué dans radio_cli :** DAB v6.0.6 — FMHD v5.1.3

---

## radio_cli — Référence complète des commandes

```
sudo radio_cli [OPTIONS...]
```

Les options peuvent être **combinées** en une seule commande.

### Options principales

| Option courte | Option longue | Description |
|---|---|---|
| `-b D` | `--boot=D` | Boot firmware DAB (utiliser `F` pour FMHD/FM) |
| `-f N` | `--frequency=N` | Syntonise l'index de fréquence N (0–37 pour Band III EU) |
| `-F kHz` | `--fm_frequency=kHz` | Syntonise une fréquence FM en kHz |
| `-e ID` | `--service=ID` | Service ID |
| `-c ID` | `--component=ID` | Component ID |
| `-p` | `--play` | Démarre la lecture (nécessite `-e`, `-c` et fréquence déjà syntonisée) |
| `-l 0-63` | `--level=N` | Volume (0 = minimum, 63 = maximum) |
| `-k` | `--shutdown` | Éteint le Si468x |
| `-o 0/1` | `--i2s_out=N` | Active (1) ou désactive (0) la sortie I²S — à régler **avant** syntonisation |
| `-y FILE` | `--frequency_list=FILE` | Charge une liste de fréquences personnalisée depuis FILE |

### Commandes d'information

| Option | Description | JSON disponible |
|---|---|---|
| `-g` | Liste des services du multiplex (digital service list) | oui (toujours JSON) |
| `-G` | Informations sur l'ensemble (label, SNR, RSSI) | oui |
| `-D` | Texte de la station (DLS/songname) — DAB ou RDS FM | oui |
| `-d` | Statut radio numérique (digrad status) | oui |
| `-n` | Statut événement numérique (event status) | oui |
| `-i` | Informations sur la puce Si468x | oui |
| `-r` | Statut RDS | - |
| `-t` | Date/heure de l'ensemble au format ISO | - |
| `-u` | Scan complet → sauvegarde dans `full_scan.json` | oui |

### Options de comportement

| Option | Description |
|---|---|
| `-j` | Sortie JSON (supprime texte statique, encapsule les erreurs en JSON) |
| `-z N` | Temps d'attente en secondes pour commandes avec timeout (défaut : 1s) |
| `-R U/E` | Active RDS — `U` = USA, `E` = Europe (au démarrage uniquement) |
| `-x` / `-X` | Station FMHD suivante / précédente |

### Séquences typiques

```bash
# Boot + syntonisation + lecture en une commande
sudo radio_cli -b D -y freq_list.txt -f 33 -e 17333 -c 12 -p -l 50

# Étape par étape
sudo radio_cli -b D -y /chemin/freq_list.txt   # 1. Boot DAB + charge fréquences
sudo radio_cli -G -j                            # 2. Info ensemble (SNR, RSSI, label)
sudo radio_cli -g -j                            # 3. Liste des services
sudo radio_cli -e 17333 -c 12 -p               # 4. Sélectionne et joue un service
sudo radio_cli -D -j -z 3                       # 5. Texte DLS (attendre 3s)
sudo radio_cli -u -j                            # 6. Scan complet → full_scan.json
sudo radio_cli -k                               # 7. Éteindre

# Avec I²S (configurer avant toute syntonisation)
sudo radio_cli -b D -o 1 -f 33 -e 17333 -c 12 -p -l 40
```

### Format JSON des réponses

**Ensemble info (`-G -j`) :**
```json
{"ensemble": "France Bleu IDF", "snr": 15.2, "rssi": -80, "label": "FBlu IDF"}
```

**Service list (`-g -j`) :**
```json
[{"id": "59440", "label": "France Bleu", "componentId": "0"}, ...]
```

**Station text (`-D -j`) :**
```json
{"stationText": "Artiste - Titre de la chanson"}
```
> `"not loaded"` si le texte n'est pas encore disponible — boucler l'appel (voir `get_station_text.sh`)

---

## DABBoardRadio — Programme terminal interactif

```bash
sudo ./DABBoardRadio            # Lance l'interface terminal ncurses
sudo ./DABBoardRadio -S 12345   # Lance et joue directement le service ID 12345
sudo ./DABBoardRadio -s         # Redémarre sans reset si le Si468x est déjà démarré
```

Contrôles : flèches pour naviguer, Entrée pour sélectionner, `q`/`w` pour volume, `x` pour quitter, `Ctrl+C` pour quitter avec radio allumée.

---

## Architecture du projet (interface web)

```
Browser (SPA vanilla JS + Socket.IO)
    ↕ WebSocket JSON
Node.js + Express (app.js)
    ↕ child_process.spawn()
radio_cli (binaire ARM propriétaire uGreen)
    ↕ SPI GPIO
Si4688 (DAB Board)
```

---

## Structure du projet

```
Files_v16/                        # Binaires et documentation uGreen v16
  bin/32-bit/radio_cli_v3.2.1    # Binaire ARM 32-bit
  bin/64-bit/radio_cli_v3.2.1    # Binaire ARM 64-bit (aarch64)
  bin/*/DABBoardRadio_v0.17.2    # Programme terminal interactif
  DABBoard_Instructions_v13.pdf  # Documentation hardware complète
  radio_cli_RELEASE_NOTES.md     # Historique versions radio_cli
  DABBoardRadio_RELEASE_NOTES.md # Historique versions DABBoardRadio
  dabboard.service               # Exemple service systemd
  get_station_text.sh            # Script Python exemple boucle DLS
  config.txt                     # Exemple config RPi (/boot/config.txt)
  ugreen_cmd                     # Référence help de radio_cli
  license.txt                    # Licence non-commerciale

dab-web-interface/
  app.js            # Serveur Express + Socket.IO (~850 lignes) — cœur
  public/index.html # SPA frontend (~900 lignes) — thème Vanilla dark
  package.json      # Express 4.18.2 + Socket.IO 4.7.2, Node >=18
  freq_list.txt     # 38 fréquences DAB Band III européennes (5A→13F)
  data/             # full_scan.json (généré au runtime)
  logs/             # radio.log (généré au runtime)

ugreen_install.sh   # Installation complète (uGreen + Node + service systemd)
ugreen_uninstall.sh # Désinstallation complète
deploy_interface.sh # Déploiement interface seule
```

---

## Commandes de développement

```bash
cd dab-web-interface
npm install
npm run dev          # node --watch app.js (hot-reload)
```

## Variables d'environnement

| Variable | Défaut | Description |
|---|---|---|
| `PORT` | 3000 | Port HTTP |
| `RADIO_CLI_PATH` | `/usr/local/sbin/radio_cli` | Binaire uGreen |
| `RADIO_CLI_TIMEOUT_MS` | 30000 | Timeout commandes (ms) |
| `RADIO_CLI_FULLSCAN_TIMEOUT_MS` | 180000 | Timeout scan complet (ms) |
| `LOG_DIR` | `./logs` | Répertoire logs |
| `DATA_DIR` | `./data` | Données runtime |
| `FREQ_LIST_PATH` | `./freq_list.txt` | Fichier fréquences |

## Accès (production)

- Interface : `http://<ip_pi>:9595/`
- Health check : `GET /health`
- Status API : `GET /api/status`
- Logs : `/var/log/dab-web-interface/radio.log`

---

## État radio serveur (`radioState`)

```js
radioState = {
  mode: null,          // 'dab' | 'fm' | null
  isBooted: false,     // Si468x démarré
  freqIndex: null,     // Indice fréquence DAB courant (0-40)
  fmFreqKhz: null,     // Fréquence FM courante en kHz
  i2sEnabled: false,   // Sortie I²S active
  volume: 40,          // Volume courant (0-63)
}
```

**Boot intelligent** : `ensureBootedDab()` / `ensureBootedFm()` vérifient `radioState.isBooted` et `radioState.mode` avant d'envoyer `-b D` ou `-b F -R E` — évitent un reset inutile du Si468x à chaque commande.

**Arrêt propre** : `shutdownRadio()` envoie `-k` au Si468x puis réinitialise `radioState` — appelé sur `SIGINT`/`SIGTERM` pour protéger le hardware (pin RSTB).

---

## PollingManager (sondage périodique)

```js
class PollingManager {
  start(fn, intervalMs)  // démarre le sondage
  stop()                 // arrête et nettoie le timer
}
```

- **DLS** : sondage toutes les **8s** via `-D -j -z 2` — parse `{"stationText":"..."}` — émet `dlsUpdate`
- **RDS** : sondage toutes les **5s** — combine `-D -j` + `-r -j` — émet `rdsUpdate` avec `{ps, pi, pty, tp, ta, stereo, rssi}`
- Un `PollingManager` par socket connecté — détruit sur `disconnect` pour éviter les conflits multi-clients

---

## Événements Socket.IO

### Client → Serveur (DAB+)

| Événement | Payload | Description |
|---|---|---|
| `scanAllBlocks` | — | Scan des 41 blocs DAB (Band III EU) |
| `scanBlock` | `{ block }` | Scan d'un bloc spécifique |
| `listServices` | — | Liste les services du multiplex actuel |
| `selectService` | `{ serviceId, componentId, block }` | Sélectionne un service (joue + applique volume) |
| `getDigradStatus` | — | Statut radio numérique `-d -j` |
| `getEnsembleInfo` | — | Info ensemble `-G -j` (label, SNR, RSSI) |
| `getEnsembleDatetime` | — | Date/heure ensemble `-t` |
| `getChipInfo` | — | Info puce `-i -j` |
| `startDlsPolling` | — | Lance le sondage DLS toutes les 8s |
| `stopDlsPolling` | — | Arrête le sondage DLS |

### Client → Serveur (FM/RDS)

| Événement | Payload | Description |
|---|---|---|
| `bootFm` | — | Boot firmware FM (`-b F -R E`) si nécessaire |
| `tuneFm` | `{ freq }` | Syntonise en FM — freq en MHz (< 1000) ou kHz (≥ 1000) |
| `fmNext` | — | Station FMHD suivante `-x` |
| `fmPrev` | — | Station FMHD précédente `-X` |
| `startRdsPolling` | — | Lance le sondage RDS toutes les 5s |
| `stopRdsPolling` | — | Arrête le sondage RDS |

### Client → Serveur (commun)

| Événement | Payload | Description |
|---|---|---|
| `setVolume` | `{ level }` | Volume 0-63 via `-l N` — sauvegardé dans `radioState` |
| `setI2s` | `{ enable }` | Toggle I²S `-o 0/1` — à appeler **avant** syntonisation |
| `getLogs` | — | Récupère le journal radio.log |
| `startAudioMonitor` | — | Démarre VU meter (arecord I²S) |
| `stopAudioMonitor` | — | Arrête VU meter |
| `shutdownRadio` | — | Éteint le Si468x `-k` |

### Serveur → Client

| Événement | Payload |
|---|---|
| `blockResult` | `{ block, result: {mux, snr, rssi, label}, error }` |
| `services` | `[{ id, label, componentId }]` |
| `serviceSelected` | `{ success, serviceId, componentId, block, error }` |
| `diagStatus` | `{ snr, rssi, bitErrorRate, fic, ... }` |
| `ensembleInfo` | `{ ensemble, snr, rssi, label }` |
| `ensembleDatetime` | `{ datetime }` |
| `chipInfo` | `{ part, firmware, ... }` |
| `dlsUpdate` | `{ text }` — texte DLS/songname |
| `fmReady` | — — firmware FM booté et prêt |
| `fmTuned` | `{ freq, freqKhz }` |
| `fmSignal` | `{ rssi, snr, stereo }` |
| `rdsUpdate` | `{ ps, pi, pty, tp, ta, stereo, rssi, radioText }` |
| `volumeChanged` | `{ level }` |
| `i2sChanged` | `{ enabled }` |
| `audioLevel` | nombre 0-1 |
| `logs` | string (contenu journal) |
| `error` | `{ message, detail }` |

---

## Architecture UI (Frontend)

### Thème Vanilla dark (inspiré welle.io)

| Variable CSS | Valeur | Usage |
|---|---|---|
| `--bg-primary` | `#0e0e12` | Fond principal |
| `--bg-secondary` | `#16161c` | Cartes/panels |
| `--bg-tertiary` | `#1e1e26` | Inputs/header |
| `--accent-teal` | `#00d4aa` | Accent DAB+ (SNR, badges, focus) |
| `--accent-coral` | `#ff6b8a` | Nom du multiplex/ensemble |
| `--accent-blue` | `#7b9fff` | Accent FM (RSSI, PS name) |
| `--text-primary` | `#e8e8f0` | Texte principal |

### Onglets et panels

- **Topbar** : tabs `DAB+` / `FM` + volume slider (0-63, debounce 200ms) + toggle I²S (pill animée) + onglets Audio/Logs
- **Channel bar DAB** : `<select>` 41 blocs (5A→13F) + bouton `Scan`
- **Channel bar FM** : stepper `◀`/`▶` + input fréquence + `MHz` + bouton `Écouter` + 6 mini-bars RSSI
- **Sidebar DAB** : liste des blocs scannés avec indicateur SNR / nom / mux
- **Sidebar FM** : liste de 12 presets stockés en `localStorage`
- **Main DAB** : nom mux (coral), SNR card (30 segments), tableau services, carte DLS (badge ● live), zone SLS
- **Main FM** : PS name (monospace bleu 26px), RSSI bar (30 segments), grille RDS (PI/PTY/TP/TA), radiotext (badge ● live)

### Bargraphes

**SNR DAB** (30 segments, 13×20px) :
- Segments 0-9 : rouge `#ff4444` (0-9 dB)
- Segments 10-19 : orange `#ff8800` (10-19 dB)
- Segments 20-29 : vert teal `#00d4aa` (20-29 dB)
- Badge `No signal` si SNR < 4 dB

**RSSI FM** (30 segments, -110 à -30 dBm) :
- Segments 0-9 : rouge (très faible)
- Segments 10-19 : orange (moyen)
- Segments 20-29 : vert teal (fort)
- 6 mini-bars synchronisées dans la channel bar FM

### Fréquences DAB (`BLOCK_TO_FREQ`)

41 entrées — Band III européen complet :

```
5A(0)=174928, 5B(1)=176640, 5C(2)=178352, 5D(3)=180064,
6A(4)=181936, 6B(5)=183648, 6C(6)=185360, 6D(7)=187072,
7A(8)=188928, 7B(9)=190640, 7C(10)=192352, 7D(11)=194064,
8A(12)=195936, 8B(13)=197648, 8C(14)=199360, 8D(15)=201072,
9A(16)=202928, 9B(17)=204640, 9C(18)=206352, 9D(19)=208064,
10A(20)=209936, 10N(21)=210096, 10B(22)=211648, 10C(23)=213360,
10D(24)=215072, 11A(25)=216928, 11N(26)=217088, 11B(27)=218640,
11C(28)=220352, 11D(29)=222064, 12A(30)=223936, 12N(31)=224096,
12B(32)=225648, 12C(33)=227360, 12D(34)=229072, 13A(35)=230784,
13B(36)=232496, 13C(37)=234208, 13D(38)=235776, 13E(39)=237488,
13F(40)=239200
```

### Table PTY RDS (`PTY_NAMES`)

32 entrées selon standard RDS Europe — de `"None"` (0) à `"Alarm"` (31) — utilisée pour afficher le type de programme FM.

### Gestion des presets FM

```js
saveFmPreset(freq)     // Ajoute aux 12 derniers dans localStorage
renderFmPresets()      // Affiche la liste — clic = tuneFm
```

---

## Si4688 — Données techniques exploitables (AN649 Rev. 2.0)

### Plages de valeurs réelles (à utiliser pour l'UI)

| Champ | Plage | Unité | Source commande |
|---|---|---|---|
| RSSI DAB | -128 à +63 | **dBµV** | `-d -j` → `rssi` |
| SNR DAB | 0 à **20** | dB | `-d -j` → `snr` |
| FIC Quality | 0 à 100 | % | `-d -j` → `FIC_quality` |
| CNR | 0 à 54 | dB | `-d -j` → `cnr` |
| CU Level | 0 à 470 | CU | `-d -j` → `cu_level` |
| RSSI FM | -128 à +127 | **dBµV** | `-r -j` → `rssi` |
| SNR FM | -128 à +127 | dB | `-r -j` → `snr` |
| Volume | 0 à 63 | — | `-l N` |

> **Attention** : RSSI est en **dBµV** (pas dBm). Conversion : dBm ≈ dBµV − 107 (impédance 50Ω).
> SNR DAB maximal = **20 dB** — les bargraphes ne doivent pas dépasser cette valeur.

### Champs complets de `-d -j` (DAB_DIGRAD_STATUS)

```json
{
  "rssi": -45,          // dBµV, signé, -128..+63
  "snr": 14,            // dB, 0..20
  "FIC_quality": 98,    // %, 0..100
  "cnr": 22,            // dB, 0..54
  "cu_level": 180,      // Capacity Units utilisées, 0..470
  "FIB_error_count": 0, // erreurs FIC irrécupérables
  "fft_offset": 0,      // offset fréquence DQPSK
  "tune_freq": 194064,  // fréquence syntonisée en kHz
  "tune_index": 11,     // index dans la freq list
  "fast_dect": 7,       // métrique détection rapide DAB (> 4 = signal présent)
  "FICerr": false,
  "acqINT": false,
  "valid": true
}
```

### Champs de `-n -j` (DAB_GET_EVENT_STATUS) — à implémenter

```json
{
  "newServiceListAvailable": true,   // liste de services mise à jour
  "serviceListVersion": 42,          // s'incrémente à chaque changement
  "serviceListAvailable": true,
  "newFreqInfoAvailable": false,
  "newAnnouncementInfoAvailable": false,
  "ensembleReconfigEvent": false,
  "ensembleReconfigWarning": false
}
```

> Utiliser `-n -j` en polling pour **détecter automatiquement** une mise à jour de la liste de services (`newServiceListAvailable: true`) sans avoir à relancer `-g -j` systématiquement.

### Mode audio DAB+ via `-n -j` (DAB_GET_AUDIO_INFO)

```json
{
  "bitrate": 96,        // kbps
  "sampleRate": 48000,  // Hz
  "mode": 3,            // 0=DualMono 1=Mono 2=Stereo 3=JointStereo
  "sbr": true,          // HE-AAC v1 (Spectral Band Replication)
  "ps": true            // HE-AAC v2 (Parametric Stereo)
}
```

**Affichage lisible recommandé :**
- `sbr=false, ps=false` → `"DAB · MP2"`
- `sbr=true, ps=false` → `"DAB+ · HE-AAC v1"`
- `sbr=true, ps=true` → `"DAB+ · HE-AAC v2"`
- + mode audio : `"Stereo"` / `"Joint Stereo"` / `"Mono"`
- Exemple complet : `"DAB+ · HE-AAC v2 · Joint Stereo · 96 kbps · 48 kHz"`

### Structure réelle de `full_scan.json` (radio_cli `-u -j`)

```json
{
  "ensembleList": [
    {
      "DigradStatus": {
        "valid": true,
        "tune_index": 11
      },
      "DigitalServiceList": {
        "ServiceList": [
          {
            "AudioOrDataFlag": 0,
            "Label": "France Info",
            "ServId": "17408",
            "ComponentList": [{ "comp_ID": "0" }]
          }
        ]
      }
    }
  ]
}
```

> **Filtres obligatoires à l'import** :
> - `DigradStatus.valid === true` → multiplex reçu
> - `AudioOrDataFlag === 0` → service audio uniquement (exclure services data/TMC/TPEG)

### I²S ALSA — Configuration exacte

- Format fixe : **48000 Hz / 16-bit S16_BE / stéréo**
- RPi = **clock master** ; Si4688 = I²S slave
- Nom de la carte ALSA : **`audiosensepi`** (ou `sndrpirpidabpi` selon version du DTB)
- Commande `arecord` correcte : `arecord -D sysdefault:CARD=audiosensepi -c 2 -r 48000 -f S16_LE -q`
- Volume en mode I²S : `amixer -q set PCM <vol>%` (pas `-l N` de radio_cli)
- **Exclusion mutuelle DAC/I²S** confirmée — `-o 1` au boot désactive le jack analogique

### Comportement digrad — Seuils utiles pour l'UI

| Métrique | Seuil "no signal" | Seuil "bon signal" |
|---|---|---|
| `fast_dect` | < 4 → pas de DAB détecté | ≥ 4 → DAB présent |
| `snr` | < 4 dB → pas décodable | > 12 dB → bon |
| `FIC_quality` | < 50% → décodage instable | > 90% → excellent |
| `valid` | `false` → pas syntonisé | `true` → ensemble valide |

### Codec audio — SERVICE_MODE (DAB_GET_SUBCHAN_INFO)

| Valeur | Signification |
|---|---|
| 4 | DAB+ (HE-AAC) |
| 5 | DAB (MPEG-1/2 Layer II, MP2) |
| 0 | Audio stream générique |
| 7 | XPAD Data (PAD) |

---

## Points techniques critiques

- **Root obligatoire** : `radio_cli` accède aux GPIO (RSTB) → le service systemd tourne en root
- **I²S** : régler `-o 1` impérativement **avant** tout `-f` (syntonisation) ; sinon réinitialiser le Si468x
- **Validation stricte** : toutes les entrées passent par `parseIntStrict`, `parseFrequencyIndex` (0-200), `parseServiceId` (0-999999), `parseFmFrequencyKhz` (arrondit à 100kHz)
- **parseFmFrequencyKhz** : accepte MHz (< 1000) ou kHz (≥ 1000) — arrondit à la centaine de kHz
- **Logging** : tous les appels `radio_cli` tracés CMD/OUT/ERR dans `radio.log`
- **41 blocs Band III** : index 0-40 dans `BLOCK_TO_FREQ` (5A = 174928 kHz → 13F = 239200 kHz)
- **Détection architecture** : `ugreen_install.sh` choisit automatiquement 32-bit ou 64-bit
- **Flash mémoire optionnelle** : Micron M25P16-VMN6P 16Mbit — permet de stocker le firmware sur la board
- **DLS "not loaded"** : radio_cli retourne cette chaîne si le texte n'est pas encore disponible — le PollingManager la filtre et ne l'émet pas
- **SNR max réel = 20 dB** : ne pas calibrer les bargraphes au-delà — valeur hardware Si4688 confirmée AN649
- **RSSI en dBµV** (pas dBm) : conversion dBm ≈ dBµV − 107 si nécessaire
- **AudioOrDataFlag** : filtrer à `0` lors du parse de full_scan.json pour n'afficher que les services audio
