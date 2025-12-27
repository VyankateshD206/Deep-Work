require('dotenv').config();

const { app, BrowserWindow, ipcMain } = require('electron');
const CDP = require('chrome-remote-interface');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const net = require('net');

const DEFAULT_DEBUG_PORT = 9222;
const ALT_DEBUG_PORT = 9223;
const PROFILE_DIR_ENV = process.env.CHROME_PROFILE_DIR;
const PROFILE_NAME_ENV = process.env.CHROME_PROFILE_NAME; // e.g., "Default", "Profile 1"
const FORCE_KILL_CHROME = process.env.CHROME_FORCE_KILL === '1';

const ENV_DEBUG_PORT = Number(process.env.CHROME_DEBUG_PORT);
const DEBUG_PORT = Number.isFinite(ENV_DEBUG_PORT) ? ENV_DEBUG_PORT : DEFAULT_DEBUG_PORT;

// Profile selection
// - CHROME_PROFILE_NAME: profile directory name (e.g. "Default", "Profile 1")
// - CHROME_PROFILE_DIR: full path to a profile directory OR the "User Data" root
let selectedProfileName = PROFILE_NAME_ENV || null;
let chromeUserDataRootOverride = null;

if (PROFILE_DIR_ENV && PROFILE_DIR_ENV.trim()) {
  const normalized = path.normalize(PROFILE_DIR_ENV.trim());
  const baseName = path.basename(normalized);
  if (baseName.toLowerCase() === 'user data') {
    chromeUserDataRootOverride = normalized;
  } else {
    selectedProfileName = selectedProfileName || baseName;
    chromeUserDataRootOverride = path.dirname(normalized);
  }
}

function defaultChromeUserDataRoot() {
  const platform = process.platform;
  if (platform === 'win32') return path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
  if (platform === 'darwin') return path.join(process.env.HOME || '', 'Library', 'Application Support', 'Google', 'Chrome');
  return path.join(process.env.HOME || '', '.config', 'google-chrome');
}

function chromeUserDataRoot() {
  return chromeUserDataRootOverride || defaultChromeUserDataRoot();
}

let mainWindow;
let currentDebugPort = DEBUG_PORT;
let launchedChrome;
let detectedActiveProfile = null;
let lastStatusMessage = '';
let currentUserDataDir = null;

let launchedChromeSpawnError = null;
let launchedChromeExited = false;

let cdpClient = null;
let cdpPort = null;
let tabStateStartedAt = 0;
/** @type {Map<string, {id: string, title: string, url: string, createdAt: number, isInitial: boolean}>} */
let tabsById = new Map();
/** @type {Set<string>} */
let initialTabIds = new Set();

function getUserDataDir() {
  if (currentUserDataDir) return currentUserDataDir;
  return chromeUserDataRoot();
}

function readActiveProfileName() {
  try {
    const localStatePath = path.join(getUserDataDir(), 'Local State');
    if (!fs.existsSync(localStatePath)) return null;
    const raw = fs.readFileSync(localStatePath, 'utf8');
    const json = JSON.parse(raw);
    const profile = json.profile || {};
    if (Array.isArray(profile.last_active_profiles) && profile.last_active_profiles.length) {
      return profile.last_active_profiles[0];
    }
    if (typeof profile.last_used === 'string') return profile.last_used;
  } catch (err) {
    console.warn('Could not read active profile', err);
  }
  return null;
}

function getAvailableProfiles() {
  try {
    const baseDir = chromeUserDataRoot();
    const localStatePath = path.join(baseDir, 'Local State');
    if (!fs.existsSync(localStatePath)) return [];
    
    const raw = fs.readFileSync(localStatePath, 'utf8');
    const json = JSON.parse(raw);
    const infoCache = json?.profile?.info_cache || {};
    
    return Object.keys(infoCache).map(key => ({
      id: key,
      name: infoCache[key]?.name || key,
      path: path.join(baseDir, key)
    }));
  } catch (err) {
    console.warn('Could not read available profiles', err);
    return [];
  }
}

function chromeProcessesRunning() {
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      // Prefer PowerShell (less locale-dependent than tasklist output parsing).
      try {
        const out = require('child_process').execSync(
          'powershell -NoProfile -Command "(Get-Process chrome -ErrorAction SilentlyContinue).Count"',
          { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }
        );
        const n = Number(String(out).trim());
        if (Number.isFinite(n)) return n > 0;
      } catch (_) {
        // Fall back to tasklist
      }

      const out = require('child_process').execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH', {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      });

      // Output is CSV; first field is image name. Example: "chrome.exe","1234",...
      return out.toLowerCase().includes('"chrome.exe"');
    }
    if (platform === 'darwin') {
      const out = require('child_process').execSync('pgrep -x "Google Chrome" || true', {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      });
      return Boolean(out.trim());
    }
    const out = require('child_process').execSync('pgrep -x chrome || true', {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    return Boolean(out.trim());
  } catch (_) {
    return false;
  }
}

function chromeProfileLikelyLocked() {
  // Heuristic: if singleton lock artifacts exist, Chrome is likely running (or previously crashed).
  // On Windows, prefer process detection; this is a fallback to avoid spawning Chrome against an in-use profile.
  try {
    const baseDir = chromeUserDataRoot();
    const lockCandidates = [
      path.join(baseDir, 'SingletonLock'),
      path.join(baseDir, 'SingletonSocket'),
      path.join(baseDir, 'SingletonCookie'),
    ];
    if (selectedProfileName) {
      const profileDir = path.join(baseDir, selectedProfileName);
      lockCandidates.push(
        path.join(profileDir, 'SingletonLock'),
        path.join(profileDir, 'SingletonSocket'),
        path.join(profileDir, 'SingletonCookie')
      );
    }

    return lockCandidates.some((p) => fs.existsSync(p));
  } catch (_) {
    return false;
  }
}

function forceKillChrome() {
  if (!FORCE_KILL_CHROME) return;
  const platform = process.platform;
  try {
    if (platform === 'win32') {
      try {
        require('child_process').execSync('taskkill /F /IM chrome.exe /T', {
          stdio: 'ignore',
        });
        console.warn('Force-killed existing Chrome processes due to CHROME_FORCE_KILL=1');
      } catch (err) {
        // Chrome might not be running, which is fine
        if (err.status !== 128) {
          throw err;
        }
      }
    } else if (platform === 'darwin') {
      require('child_process').execSync('pkill -9 "Google Chrome" || true', {
        stdio: 'ignore',
      });
    } else {
      require('child_process').execSync('pkill -9 chrome || true', {
        stdio: 'ignore',
      });
    }
    
    // Remove singleton lock files after killing Chrome
    try {
      const baseDir = chromeUserDataRoot();
      const lockFiles = [
        path.join(baseDir, 'SingletonLock'),
        path.join(baseDir, 'SingletonSocket'),
        path.join(baseDir, 'SingletonCookie')
      ];
      
      if (selectedProfileName) {
        const profileDir = path.join(baseDir, selectedProfileName);
        lockFiles.push(
          path.join(profileDir, 'SingletonLock'),
          path.join(profileDir, 'SingletonSocket'),
          path.join(profileDir, 'SingletonCookie')
        );
      }
      
      lockFiles.forEach(lockFile => {
        if (fs.existsSync(lockFile)) {
          fs.unlinkSync(lockFile);
          console.log(`[DEBUG] Removed lock file: ${lockFile}`);
        }
      });
    } catch (lockErr) {
      console.warn('Failed to remove lock files', lockErr);
    }
  } catch (err) {
    console.warn('Failed to force-kill Chrome processes', err);
  }
}

function resolvePort(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input === 'string' && input.trim()) {
    const n = Number(input);
    if (Number.isFinite(n)) return n;
  }
  return currentDebugPort || DEBUG_PORT;
}

function checkChromeDebugging(port = DEBUG_PORT, timeoutMs = 500) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs },
      (res) => {
        res.destroy();
        resolve(true);
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });

    req.on('error', () => resolve(false));
  });
}

function findChromeExecutable() {
  const platform = process.platform;
  const candidates = [];

  if (platform === 'win32') {
    const suffix = 'Google\\Chrome\\Application\\chrome.exe';
    const roots = [
      process.env.PROGRAMFILES,
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);

    roots.forEach((base) => candidates.push(path.join(base, suffix)));
    candidates.push('chrome.exe');
  } else if (platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/google-chrome');
    candidates.push('/usr/bin/chromium');
    candidates.push('/usr/bin/chromium-browser');
  }

  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch (err) {
      return false;
    }
  });
}

function buildChromeArgs(port = DEBUG_PORT) {
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${chromeUserDataRoot()}`,
  ];

  if (selectedProfileName) {
    args.push(`--profile-directory=${selectedProfileName}`);
  }

  args.push('--new-window');
  args.push('--no-first-run');
  args.push('--no-default-browser-check');
  args.push('about:blank');
  return args;
}

async function launchChromeWithDebugging(executable, port = DEBUG_PORT) {
  launchedChromeSpawnError = null;
  launchedChromeExited = false;

  console.log(`[DEBUG] chromeUserDataRootOverride from env: ${chromeUserDataRootOverride}`);
  console.log(`[DEBUG] selectedProfileName from env: ${selectedProfileName}`);
  console.log(`[DEBUG] Resolved user data root for launch: ${chromeUserDataRoot()}`);

  console.log(`[DEBUG] Chrome executable: ${executable}`);

  const args = buildChromeArgs(port);
  console.log(`[DEBUG] Chrome args: ${args.join(' ')}`);
  
  const child = await new Promise((resolve, reject) => {
    const proc = spawn(executable, args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    proc.once('error', (err) => {
      launchedChromeSpawnError = err;
      reject(err);
    });

    proc.once('spawn', () => resolve(proc));
  });

  // Log stderr/stdout (Chrome often logs important startup errors to stderr).
  child.stdout?.on('data', (buf) => {
    const s = String(buf).trim();
    if (s) console.log(`[CHROME] ${s}`);
  });
  child.stderr?.on('data', (buf) => {
    const s = String(buf).trim();
    if (s) console.warn(`[CHROME] ${s}`);
  });

  child.once('exit', (code, signal) => {
    launchedChromeExited = true;
    console.warn(`[DEBUG] Chrome process exited (code=${code}, signal=${signal})`);
  });

  currentUserDataDir = chromeUserDataRoot();

  return { child, port: port || DEBUG_PORT, userDataDir: currentUserDataDir };
}

async function waitForDebugPort(port = DEBUG_PORT, attempts = 240, delayMs = 200) {
  console.log(`[DEBUG] Waiting for debug port ${port} to open...`);
  for (let i = 0; i < attempts; i += 1) {
    // Fail fast if Chrome couldn't start.
    if (launchedChromeSpawnError) {
      console.warn('[DEBUG] Aborting wait: Chrome spawn error detected');
      return false;
    }
    if (launchedChromeExited) {
      console.warn('[DEBUG] Aborting wait: Chrome process exited before port opened');
      return false;
    }

    const ok = await checkChromeDebugging(port);
    if (ok) {
      console.log(`[DEBUG] Debug port ${port} is open!`);
      return true;
    }
    if (i % 10 === 0 && i > 0) {
      console.log(`[DEBUG] Still waiting... attempt ${i}/${attempts}`);
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.log(`[DEBUG] Timeout waiting for port ${port}`);
  return false;
}

async function ensureChromeDebugging() {
  // Prefer currentDebugPort, then fallback ports.
  if (await checkChromeDebugging(currentDebugPort)) {
    detectedActiveProfile = readActiveProfileName();
    lastStatusMessage = `Connected to Chrome on port ${currentDebugPort}`;
    return true;
  }

  if (await checkChromeDebugging(DEBUG_PORT)) {
    currentDebugPort = DEBUG_PORT;
    detectedActiveProfile = readActiveProfileName();
    lastStatusMessage = `Connected to Chrome on port ${DEBUG_PORT}`;
    return true;
  }

  if (ALT_DEBUG_PORT !== DEBUG_PORT && await checkChromeDebugging(ALT_DEBUG_PORT)) {
    currentDebugPort = ALT_DEBUG_PORT;
    detectedActiveProfile = readActiveProfileName();
    lastStatusMessage = `Connected to Chrome on port ${ALT_DEBUG_PORT}`;
    return true;
  }

  // If Chrome is already running without debugging, launching another instance
  // against the same user-data-dir may fail. Respect CHROME_FORCE_KILL=1.
  // On Windows, also use lock-file heuristic to avoid hanging on failed launches.
  const chromeRunning = chromeProcessesRunning() || (process.platform === 'win32' && chromeProfileLikelyLocked());
  if (chromeRunning && !FORCE_KILL_CHROME) {
    lastStatusMessage = 'Chrome is running but remote debugging is off. Close Chrome or set CHROME_FORCE_KILL=1, then Refresh.';
    return false;
  }

  forceKillChrome();

  const foundExecutable = findChromeExecutable();
  const executable = foundExecutable || 'chrome';

  if (!foundExecutable) {
    // 'chrome' is often not on PATH on Windows; fail early with a clear message.
    console.warn('[DEBUG] Could not find Chrome executable on disk; falling back to "chrome" command name');
  }

  try {
    const { child, port } = await launchChromeWithDebugging(executable, DEBUG_PORT);
    launchedChrome = child;
    currentDebugPort = port;
  } catch (err) {
    const msg = err?.message || String(err) || 'Failed to launch Chrome';
    lastStatusMessage = `Failed to launch Chrome: ${msg}`;
    console.error(lastStatusMessage);
    return false;
  }

  const ok = await waitForDebugPort(currentDebugPort);
  detectedActiveProfile = readActiveProfileName();

  if (!ok) {
    // Give a more actionable status.
    const hint = FORCE_KILL_CHROME
      ? 'Chrome failed to open the debug port. Check the [CHROME] logs above for errors.'
      : 'Chrome may already be running or the profile is locked. Close Chrome or set CHROME_FORCE_KILL=1.';
    lastStatusMessage = `Failed to launch Chrome remote debugging on port ${currentDebugPort}. ${hint}`;
    return false;
  }

  lastStatusMessage = `Launched Chrome with remote debugging on port ${currentDebugPort}`;
  return ok;
}

function tabsFromState() {
  // Keep backwards-compatible shape while adding useful metadata.
  return Array.from(tabsById.values()).map((t) => ({
    id: t.id,
    title: t.title,
    url: t.url,
    isInitial: Boolean(t.isInitial),
    createdAt: t.createdAt,
  }));
}

function sendChromeTabsFromState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const tabs = tabsFromState();
  mainWindow.webContents.send('chrome-tabs', tabs);
}

async function stopTabTracking() {
  tabsById = new Map();
  initialTabIds = new Set();
  tabStateStartedAt = 0;
  cdpPort = null;

  if (cdpClient) {
    try {
      await cdpClient.close();
    } catch (_) {
      // ignore
    }
    cdpClient = null;
  }
}

async function ensureTabTracking() {
  if (!await checkChromeDebugging(currentDebugPort)) return false;

  if (cdpClient && cdpPort === currentDebugPort) return true;

  await stopTabTracking();
  tabStateStartedAt = Date.now();
  cdpPort = currentDebugPort;

  try {
    cdpClient = await CDP({ host: '127.0.0.1', port: currentDebugPort });
    const { Target } = cdpClient;

    await Target.setDiscoverTargets({ discover: true });

    const existing = await Target.getTargets();
    const targetInfos = existing?.targetInfos || [];

    for (const info of targetInfos) {
      if (info.type !== 'page') continue;
      if (typeof info.url === 'string' && info.url.startsWith('devtools://')) continue;

      const tab = {
        id: info.targetId,
        title: info.title || '',
        url: info.url || '',
        createdAt: tabStateStartedAt,
        isInitial: true,
      };
      initialTabIds.add(tab.id);
      tabsById.set(tab.id, tab);
    }

    Target.targetCreated(({ targetInfo }) => {
      if (!targetInfo || targetInfo.type !== 'page') return;
      if (typeof targetInfo.url === 'string' && targetInfo.url.startsWith('devtools://')) return;

      const id = targetInfo.targetId;
      const isInitial = initialTabIds.has(id);
      tabsById.set(id, {
        id,
        title: targetInfo.title || '',
        url: targetInfo.url || '',
        createdAt: Date.now(),
        isInitial,
      });
      sendChromeTabsFromState();
    });

    Target.targetInfoChanged(({ targetInfo }) => {
      if (!targetInfo || targetInfo.type !== 'page') return;
      if (typeof targetInfo.url === 'string' && targetInfo.url.startsWith('devtools://')) return;

      const id = targetInfo.targetId;
      const prev = tabsById.get(id);
      tabsById.set(id, {
        id,
        title: targetInfo.title || prev?.title || '',
        url: targetInfo.url || prev?.url || '',
        createdAt: prev?.createdAt || Date.now(),
        isInitial: prev?.isInitial ?? initialTabIds.has(id),
      });
      sendChromeTabsFromState();
    });

    Target.targetDestroyed(({ targetId }) => {
      if (!targetId) return;
      tabsById.delete(targetId);
      sendChromeTabsFromState();
    });

    // Send initial snapshot immediately after attaching.
    sendChromeTabsFromState();
    return true;
  } catch (err) {
    console.error('Failed to start CDP tab tracking', err);
    lastStatusMessage = err.message || 'Failed to start live tab tracking';
    await stopTabTracking();
    return false;
  }
}

// Profile is chosen via environment or Chrome picker; no in-app profile switching.

async function fetchChromeTabs(eventOrPort, maybePort) {
  try {
    const port = resolvePort(maybePort ?? eventOrPort);
    currentDebugPort = port;
    const ok = await ensureChromeDebugging();
    if (!ok) return [];

    const trackingOk = await ensureTabTracking();
    if (trackingOk) return tabsFromState();

    // Fallback: one-shot list.
    const targets = await CDP.List({ host: '127.0.0.1', port: currentDebugPort });
    return targets
      .filter((target) => target.type === 'page')
      .map((target) => ({
        id: target.id || target.targetId,
        title: target.title,
        url: target.url,
      }));
  } catch (err) {
    console.error('Failed to fetch Chrome tabs', err);
    lastStatusMessage = err.message || 'Failed to fetch tabs';
    return [];
  }
}

async function sendChromeTabs() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const tabs = await fetchChromeTabs();
    mainWindow.webContents.send('chrome-tabs', tabs);
    const profileInfo = detectedActiveProfile ? `profile ${detectedActiveProfile}` : 'profile unknown';
    mainWindow.webContents.send(
      'chrome-status',
      `Loaded ${tabs.length} tabs from port ${currentDebugPort} (${profileInfo})`
    );
  } catch (err) {
    const msg = err.message || 'Failed to fetch tabs';
    lastStatusMessage = msg;
    mainWindow.webContents.send('chrome-status', msg);
  }
}

async function switchProfile(profileId) {
  await stopTabTracking();

  // Kill existing Chrome
  if (launchedChrome && launchedChrome.kill) {
    try {
      launchedChrome.kill();
    } catch (_) { /* ignore */ }
  }
  forceKillChrome();
  
  // Update selected profile - use base directory, not full path
  selectedProfileName = profileId;
  
  // Restart Chrome
  const ok = await ensureChromeDebugging();
  if (ok) {
    await ensureTabTracking();
    await sendChromeTabs();
  }
  return ok;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadURL(
    'data:text/html,' +
      encodeURIComponent(`
        <!doctype html>
        <html>
        <head>
          <meta charset="utf-8" />
          <title>Chrome Tabs</title>
          <style>
            body { font-family: sans-serif; margin: 16px; }
            button { margin-right: 8px; }
            table { border-collapse: collapse; width: 100%; margin-top: 12px; }
            th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
          </style>
        </head>
        <body>
          <h1>Chrome Tabs</h1>
          <div style="margin-bottom: 12px;">
            <label for="profileSelect">Profile: </label>
            <select id="profileSelect" style="margin-right: 12px;">
              <option value="">Loading profiles...</option>
            </select>
            <button id="switchProfile">Switch Profile</button>
            <button id="refresh">Refresh</button>
            <span id="status" style="margin-left: 12px;"></span>
          </div>
          <table id="tabs">
            <thead><tr><th>Title</th><th>URL</th></tr></thead>
            <tbody></tbody>
          </table>
          <script>
            const statusEl = document.getElementById('status');
            const tbody = document.querySelector('#tabs tbody');
            const profileSelect = document.getElementById('profileSelect');
            const switchBtn = document.getElementById('switchProfile');
            
            // Load available profiles
            window.chromeTabs.getProfiles().then(profiles => {
              profileSelect.innerHTML = '';
              profiles.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.name + ' (' + p.id + ')';
                profileSelect.appendChild(opt);
              });
              
              // Select current profile
              window.chromeTabs.getCurrentProfile().then(current => {
                if (current) profileSelect.value = current;
              });
            });
            
            switchBtn.addEventListener('click', async () => {
              const profileId = profileSelect.value;
              if (!profileId) return;
              statusEl.textContent = 'Switching profile and restarting Chrome...';
              try {
                await window.chromeTabs.switchProfile(profileId);
                statusEl.textContent = 'Profile switched successfully!';
                const tabs = await window.chromeTabs.fetch();
                render(tabs);
              } catch (err) {
                statusEl.textContent = err.message || 'Failed to switch profile';
              }
            });

            function render(tabs) {
              tbody.innerHTML = '';
              if (!tabs || !tabs.length) {
                statusEl.textContent = 'No tabs fetched yet';
                return;
              }
              statusEl.textContent = 'Loaded ' + tabs.length + ' tabs';
              tabs.forEach(t => {
                const tr = document.createElement('tr');
                const tdTitle = document.createElement('td');
                const tdUrl = document.createElement('td');
                tdTitle.textContent = t.title || '(no title)';
                tdUrl.textContent = t.url || '';
                tr.appendChild(tdTitle);
                tr.appendChild(tdUrl);
                tbody.appendChild(tr);
              });
            }

            document.getElementById('refresh').addEventListener('click', async () => {
              statusEl.textContent = 'Refreshing...';
              try {
                const tabs = await window.chromeTabs.fetch();
                render(tabs);
              } catch (err) {
                statusEl.textContent = err.message || 'Failed to fetch tabs';
              }
            });

            window.chromeTabs.onUpdate((tabs) => {
              render(tabs);
            });

            window.chromeTabs.onStatus((msg) => {
              statusEl.textContent = msg;
            });

            // initial fetch
            window.chromeTabs.status().then((msg) => statusEl.textContent = msg);
            window.chromeTabs.fetch().then(render).catch((err) => {
              statusEl.textContent = err.message || 'Failed to fetch tabs';
            });
          </script>
        </body>
        </html>
      `)
  );

  return mainWindow;
}

app.whenReady().then(async () => {
  // Register IPC handlers first before creating window
  ipcMain.handle('chrome-tabs:status', () => {
    const profileInfo = detectedActiveProfile ? `profile ${detectedActiveProfile}` : 'profile unknown';
    if (lastStatusMessage) return lastStatusMessage;
    return currentDebugPort
      ? `Ready on port ${currentDebugPort} (${profileInfo})`
      : 'Chrome debugging not ready. Waiting for Chrome to start...';
  });

  ipcMain.handle('chrome-tabs:fetch', fetchChromeTabs);
  ipcMain.handle('chrome-tabs:port', () => currentDebugPort);
  ipcMain.handle('chrome-tabs:profiles', getAvailableProfiles);
  ipcMain.handle('chrome-tabs:current-profile', () => selectedProfileName);
  ipcMain.handle('chrome-tabs:switch-profile', async (event, profileId) => {
    return await switchProfile(profileId);
  });

  // Create window so app appears immediately
  createWindow();
  console.log('[DEBUG] Window created, now ensuring Chrome debugging...');
  
  // Start Chrome debugging in background
  const ok = await ensureChromeDebugging();
  console.log(`[DEBUG] Chrome debugging ready: ${ok}`);

  mainWindow.webContents.on('did-finish-load', () => {
    ensureTabTracking().finally(() => sendChromeTabs());
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }

  if (launchedChrome && launchedChrome.kill) {
    try {
      launchedChrome.kill();
    } catch (err) {
      console.warn('Failed to close launched Chrome', err);
    }
  }
});
