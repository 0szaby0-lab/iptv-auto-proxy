// Node.js — IPTV auto-registration service for render.com
// submits WPForms free trial form every 20 hours with a fresh SimpleLogin alias + Gmail IMAP

const express = require('express');
const cron = require('node-cron');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
let chromium = null;
try {
  const pExtra = require('playwright-extra');
  const stealthPlugin = require('puppeteer-extra-plugin-stealth');
  chromium = pExtra.chromium;
  chromium.use(stealthPlugin());
} catch (e) {
  // Playwright-extra optional (e.g. on Android / lightweight environments)
}
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const app = express();
const PORT = process.env.PORT || 3000;

// in-memory log buffer for /logs endpoint
const runtimeLogs = [];
const origLog = console.log;
const origErr = console.error;
console.log = (...args) => {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
  runtimeLogs.push(line);
  if (runtimeLogs.length > 500) runtimeLogs.shift();
  origLog(...args);
};
console.error = (...args) => {
  const line = `[${new Date().toISOString()}] [ERR] ${args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ')}`;
  runtimeLogs.push(line);
  if (runtimeLogs.length > 500) runtimeLogs.shift();
  origErr(...args);
};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// log all incoming HTTP requests
app.use((req, res, next) => {
  if (req.path !== '/logs') {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[HTTP] ${req.method} ${req.originalUrl} from ${ip} (UA: ${req.headers['user-agent'] || 'none'})`);
  }
  next();
});

// ─── config ───────────────────────────────────────────────────────
const TARGET_URL = 'https://iptvload.org/free-iptv-trial-24-hours/';
const REGISTER_INTERVAL_HOURS = 22;

// SimpleLogin & Gmail IMAP configuration
const SIMPLELOGIN_API = process.env.SIMPLELOGIN_API || 'https://app.simplelogin.io';
const SIMPLELOGIN_API_KEY = process.env.SIMPLELOGIN_API_KEY;

const IMAP_CONFIG = {
  host: process.env.IMAP_HOST || 'imap.gmail.com',
  port: parseInt(process.env.IMAP_PORT, 10) || 993,
  secure: true,
  auth: {
    user: process.env.IMAP_USER,
    pass: process.env.IMAP_PASS
  },
  logger: false
};

// random data pools
const FIRST_NAMES = [
  'James', 'Robert', 'John', 'Michael', 'David', 'William', 'Richard', 'Joseph',
  'Thomas', 'Christopher', 'Charles', 'Daniel', 'Matthew', 'Anthony', 'Mark',
  'Steven', 'Paul', 'Andrew', 'Joshua', 'Kenneth', 'Kevin', 'Brian', 'George',
  'Timothy', 'Ronald', 'Edward', 'Jason', 'Jeffrey', 'Ryan', 'Jacob',
  'Mary', 'Patricia', 'Jennifer', 'Linda', 'Barbara', 'Elizabeth', 'Susan',
  'Jessica', 'Sarah', 'Karen', 'Lisa', 'Nancy', 'Betty', 'Margaret', 'Sandra',
  'Ashley', 'Dorothy', 'Kimberly', 'Emily', 'Donna', 'Michelle', 'Carol',
  'Amanda', 'Melissa', 'Deborah', 'Stephanie', 'Rebecca', 'Sharon', 'Laura'
];

const LAST_NAMES = [
  'Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis',
  'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Gonzalez', 'Wilson', 'Anderson',
  'Thomas', 'Taylor', 'Moore', 'Jackson', 'Martin', 'Lee', 'Perez', 'Thompson',
  'White', 'Harris', 'Sanchez', 'Clark', 'Ramirez', 'Lewis', 'Robinson'
];

const COUNTRIES = [
  'United States', 'United Kingdom', 'Canada', 'Germany', 'France',
  'Netherlands', 'Australia', 'Sweden', 'Denmark', 'Norway',
  'Belgium', 'Switzerland', 'Austria', 'Ireland', 'Finland',
  'Spain', 'Italy', 'Portugal', 'Greece', 'Poland',
  'Romania', 'Czechia', 'Hungary', 'Brazil', 'Mexico'
];

// exact values from WPForms field 5 select options
const DEVICES = ['Android Box', 'Smart TV', 'Fire Tv Stick', 'Apple TV', 'Nvidia Shield', 'Formuler'];
// exact values from WPForms field 9 select options (Xtream Codes apps only)
const APPS = ['Iptv Smarters Pro', 'Tivimate', 'Kodi', 'OTT Player', 'GSE Smart IPTV'];

// ─── helpers ──────────────────────────────────────────────────────

let nextRegistrationTime = null;

function formatBucharestTime(date = new Date()) {
  try {
    return new Intl.DateTimeFormat('hu-HU', {
      timeZone: 'Europe/Bucharest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function httpRequest(url, options = {}) {
  // Cloudflare TLS ujjlenyomat-hamisítás (curl_cffi Chrome 120) az iptvload.org kérésekhez
  if (url.includes('iptvload.org') || options.useTlsClient) {
    return new Promise((resolve) => {
      const scriptPath = path.join(__dirname, 'tls_client.py');
      const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
      const pyProc = spawn(pyCmd, [scriptPath]);
      let stdout = '';
      let stderr = '';
      pyProc.stdout.on('data', d => stdout += d);
      pyProc.stderr.on('data', d => stderr += d);
      pyProc.on('close', () => {
        try {
          const res = JSON.parse(stdout);
          if (res.ok) {
            return resolve({
              status: res.status,
              headers: res.headers || {},
              body: res.body || '',
              cookies: res.cookies || []
            });
          }
        } catch (e) {}
        resolve({ status: 500, headers: {}, body: stdout || stderr, cookies: [] });
      });
      pyProc.on('error', (err) => {
        resolve({ status: 500, headers: {}, body: err.message, cookies: [] });
      });

      const payload = {
        url,
        method: options.method || 'GET',
        headers: options.headers || {},
        data: options.body,
        timeout: Math.floor((options.timeout || 25000) / 1000)
      };
      pyProc.stdin.write(JSON.stringify(payload));
      pyProc.stdin.end();
    });
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      timeout: options.timeout || 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        ...options.headers
      }
    };

    const req = client.request(reqOptions, (res) => {
      let data = '';
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).toString();
        return resolve(httpRequest(redirectUrl, options));
      }
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data, cookies: res.headers['set-cookie'] || [] }));
    });

    req.on('timeout', () => {
      req.destroy(new Error(`request timeout after ${reqOptions.timeout}ms`));
    });

    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ─── Cloudflare Turnstile Token Lekérés (cfsolve Rust / solve_turnstile.py / Env) ───
async function getTurnstileToken(targetUrl = TARGET_URL, sitekey = '0x4AAAAAAGBN3ovuTvtx0lnr', action = null) {
  if (process.env.TURNSTILE_TOKEN && sitekey === '0x4AAAAAAGBN3ovuTvtx0lnr') {
    console.log(`[Turnstile] Kézi token betöltve: ${process.env.TURNSTILE_TOKEN.substring(0, 15)}...`);
    return process.env.TURNSTILE_TOKEN;
  }

  // 1. Rust cfsolve használata (gyors, böngészőmentes, ~1 másodperc)
  const cfsolveBin = path.join(__dirname, 'cfsolve');
  if (fs.existsSync(cfsolveBin)) {
    const profilePath = path.join(__dirname, 'profiles', 'safari-26-ios.json');
    const tmpDir = path.join('/tmp', `cfs_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    console.log(`[*] Turnstile token lekérése (cfsolve Rust solver, sitekey: ${sitekey.substring(0, 12)}...)...`);
    try {
      const token = await new Promise((resolve) => {
        const args = [
          '--page', targetUrl,
          tmpDir,
          '--solve',
          '--sitekey', sitekey,
          '--blank-page',
          '--fingerprint', profilePath
        ];
        if (action) {
          args.push('--action', action);
        }
        execFile(cfsolveBin, args, { timeout: 45000 }, (error, stdout, stderr) => {
          try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
          if (error) {
            console.log(`[-] cfsolve hiba: ${error.message}`);
            if (stderr) console.log(`[-] cfsolve stderr: ${stderr.trim()}`);
            return resolve(null);
          }
          const out = (stdout || '').trim();
          const tokenMatch = out.match(/[0-9]\.[A-Za-z0-9_\-\.]{50,}/);
          if (tokenMatch) {
            console.log(`[+] cfsolve sikeres! Token: ${tokenMatch[0].substring(0, 25)}...`);
            return resolve(tokenMatch[0]);
          }
          if (out.length > 50) {
            console.log(`[+] cfsolve nyers token: ${out.substring(0, 25)}...`);
            return resolve(out);
          }
          console.log(`[-] cfsolve nem adott vissza érvényes tokent: ${out}`);
          resolve(null);
        });
      });
      if (token) return token;
    } catch (err) {
      console.log(`[-] cfsolve kivétel: ${err.message}`);
    }
  }

  // 2. Python fallback (solve_turnstile.py)
  const scriptPath = path.join(__dirname, 'solve_turnstile.py');
  if (fs.existsSync(scriptPath)) {
    try {
      console.log(`[*] Turnstile token lekérése (solve_turnstile.py fallback)...`);
      const token = await new Promise((resolve) => {
        const pyCmd = process.platform === 'win32' ? 'python' : 'python3';
        execFile(pyCmd, [scriptPath, targetUrl], { timeout: 120000 }, (error, stdout, stderr) => {
          if (error) {
            console.log(`[-] Python solver: ${error.message}`);
            return resolve(null);
          }
          try {
            const lines = (stdout || '').split('\n');
            let jsonLine = lines.find(l => l.includes('__TURNSTILE_JSON__:'));
            if (jsonLine) {
              jsonLine = jsonLine.substring(jsonLine.indexOf('__TURNSTILE_JSON__:') + '__TURNSTILE_JSON__:'.length).trim();
              const parsed = JSON.parse(jsonLine);
              if (parsed.ok && parsed.token) return resolve(parsed.token);
            }
          } catch (e) {}
          resolve(null);
        });
      });
      if (token) return token;
    } catch (e) {}
  }

  return null;
}

// ─── Gyors HTTP + TLS Ujjlenyomat Regisztráció (Böngészőmentes) ───
async function doHttpRegistration(mailAccount, firstName, lastName, country, device, iptv_app) {
  const email = mailAccount.address;
  const fullName = `${firstName} ${lastName}`;

  // Süti-kezelő (session megtartása az összes kérésen keresztül)
  const cookieJar = {};
  const updateJar = (cookiesList) => {
    if (!cookiesList || !Array.isArray(cookiesList)) return;
    for (const c of cookiesList) {
      const part = c.split(';')[0].trim();
      const eq = part.indexOf('=');
      if (eq > 0) {
        cookieJar[part.substring(0, eq).trim()] = part.substring(eq + 1).trim();
      }
    }
  };
  const getCookieHeader = () => Object.entries(cookieJar).map(([k, v]) => `${k}=${v}`).join('; ');

  console.log(`[*] Cloudflare Turnstile token keresése...`);
  const turnstileToken = await getTurnstileToken();

  const randomClientIp = `${Math.floor(Math.random() * 150 + 50)}.${Math.floor(Math.random() * 250 + 2)}.${Math.floor(Math.random() * 250 + 2)}.${Math.floor(Math.random() * 250 + 2)}`;

  console.log(`[*] Megerősítő email kód kérése (POST /wp-json/ivl/v1/send, spoofed IP: ${randomClientIp})...`);
  const sendHeaders = {
    'Content-Type': 'application/json',
    'Origin': 'https://iptvload.org',
    'Referer': TARGET_URL,
    'X-Forwarded-For': randomClientIp,
    'X-Real-IP': randomClientIp,
    'Client-IP': randomClientIp
  };
  if (turnstileToken) {
    sendHeaders['X-IVL-TS'] = turnstileToken;
    console.log(`[+] X-IVL-TS (Turnstile token) csatolva.`);
  }

  let sendRes = await httpRequest('https://iptvload.org/wp-json/ivl/v1/send', {
    method: 'POST',
    headers: sendHeaders,
    body: JSON.stringify({ email: email })
  });
  updateJar(sendRes.cookies);

  let sendData = {};
  try { sendData = JSON.parse(sendRes.body); } catch {}
  console.log(`[*] Send válasz: ${JSON.stringify(sendData)}`);

  if (!sendData.ok) {
    console.log(`[-] Send sikertelen (${sendData.code || sendRes.status}): ${sendData.message || 'unknown error'}`);
    return { success: false, code: sendData.code };
  }

  let ivlToken = null;
  if (sendData.bypass || sendData.token || sendData.code === 'bypass') {
    ivlToken = sendData.token;
    console.log(`[+] Email megerősítés átugorva! Token: ${(ivlToken || '').substring(0, 20)}...`);
  } else {
    console.log(`[+] Megerősítő kód kiküldve: ${email}!`);
    let verificationCode = null;
    const maxWaitMs = 90000;
    const pollIntervalMs = 5000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      console.log(`[*] Email fiók ellenőrzése... (${Math.round((Date.now() - startTime) / 1000)}s)`);
      await sleep(pollIntervalMs);

      try {
        const messages = await checkInbox(mailAccount);
        for (const msg of messages) {
          const subject = msg.subject || '';
          const subjectMatch = subject.match(/\b(\d{6})\b/);
          if (subjectMatch) {
            verificationCode = subjectMatch[1];
            console.log(`[+] MEGERŐSÍTŐ KÓD TÁRGYBÓL: ${verificationCode}`);
            break;
          }
          const full = await readMessage(mailAccount, msg.id);
          const bodyText = full.body || '';
          const codeMatch = bodyText.match(/\b(\d{6})\b/);
          if (codeMatch) {
            verificationCode = codeMatch[1];
            console.log(`[+] MEGERŐSÍTŐ KÓD TÖRZSBŐL: ${verificationCode}`);
            break;
          }
        }
      } catch (err) {
        console.log(`[-] Inbox hiba: ${err.message}`);
      }
      if (verificationCode) break;
    }

    if (!verificationCode) {
      console.error(`[-] Nem érkezett meg a kód a megadott időn belül.`);
      return { success: false };
    }

    console.log(`[*] Kód ellenőrzése: ${verificationCode}...`);
    const verifyHeaders = {
      'Content-Type': 'application/json',
      'Origin': 'https://iptvload.org',
      'Referer': TARGET_URL
    };
    const cHead = getCookieHeader();
    if (cHead) verifyHeaders['Cookie'] = cHead;

    const verifyRes = await httpRequest('https://iptvload.org/wp-json/ivl/v1/verify', {
      method: 'POST',
      headers: verifyHeaders,
      body: JSON.stringify({ form_id: 1019, email: email, code: verificationCode })
    });
    updateJar(verifyRes.cookies);

    let verifyData = {};
    try { verifyData = JSON.parse(verifyRes.body); } catch {}
    console.log(`[*] Verify válasz: ${JSON.stringify(verifyData)}`);

    if (!verifyData.ok || !verifyData.token) {
      console.error(`[-] Nem sikerült az ellenőrzés: ${verifyData.message || verifyData.code}`);
      return { success: false };
    }

    ivlToken = verifyData.token;
    console.log(`[+] Sikeres email megerősítés! ivl_token: ${ivlToken.substring(0, 20)}...`);
  }

  console.log(`[*] Oldal lekérése és form tokenek kinyerése...`);
  const pageHeaders = {};
  const cHeadPage = getCookieHeader();
  if (cHeadPage) pageHeaders['Cookie'] = cHeadPage;

  const pageRes = await httpRequest(TARGET_URL, { headers: pageHeaders });
  updateJar(pageRes.cookies);

  const timeTokenMatch = (pageRes.body || '').match(/name="wpforms\[time_token\]"\s+value="([^"]+)"/);
  const timeToken = timeTokenMatch ? timeTokenMatch[1] : '';

  const bodyParams = new URLSearchParams();
  bodyParams.append('wpforms[fields][1]', fullName);
  bodyParams.append('wpforms[fields][1][first]', firstName);
  bodyParams.append('wpforms[fields][1][last]', lastName);
  bodyParams.append('wpforms[fields][36]', country);
  bodyParams.append('wpforms[fields][2]', email);
  bodyParams.append('wpforms[fields][3]', '');
  bodyParams.append('wpforms[fields][5]', device);
  bodyParams.append('wpforms[fields][9]', iptv_app);
  bodyParams.append('wpforms[fields][23]', 'I would like to try your IPTV service please. Thank you!');
  bodyParams.append('wpforms[id]', '1019');
  bodyParams.append('wpforms[post_id]', '1321');
  if (timeToken) bodyParams.append('wpforms[time_token]', timeToken);
  bodyParams.append('wpforms[hp]', '');
  bodyParams.append('page_title', 'Free IPTV Trial');
  bodyParams.append('page_url', TARGET_URL);
  bodyParams.append('page_id', '1321');
  bodyParams.append('action', 'wpforms_submit');
  bodyParams.append('ivl_token', ivlToken);
  if (turnstileToken) {
    bodyParams.append('cf-turnstile-response', turnstileToken);
  }

  console.log(`[*] WPForms elküldése (POST /wp-admin/admin-ajax.php)...`);
  const submitUrl = 'https://iptvload.org/wp-admin/admin-ajax.php';
  const submitHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Referer': TARGET_URL,
    'Origin': 'https://iptvload.org',
    'X-Requested-With': 'XMLHttpRequest',
    'X-Forwarded-For': randomClientIp,
    'X-Real-IP': randomClientIp,
    'Client-IP': randomClientIp
  };
  const cHeadSubmit = getCookieHeader();
  if (cHeadSubmit) submitHeaders['Cookie'] = cHeadSubmit;

  const submitRes = await httpRequest(submitUrl, {
    method: 'POST',
    headers: submitHeaders,
    body: bodyParams.toString()
  });
  updateJar(submitRes.cookies);

  console.log(`[*] Submit státusz: ${submitRes.status}`);
  console.log(`[*] Submit válasz body: ${(submitRes.body || '').substring(0, 300)}`);
  console.log(`[*] Submit sütik: ${getCookieHeader()}`);

  let formSuccess = false;
  try {
    const result = JSON.parse(submitRes.body);
    if (result.success || (result.data && !result.data.errors)) {
      console.log(`[+] ŰRLAP SIKERESEN ELKÜLDVE!`);
      formSuccess = true;
    }
  } catch (e) {
    if (submitRes.body && (submitRes.body.includes('Thank you') || submitRes.body.includes('successful'))) {
      formSuccess = true;
    }
  }

  return { success: formSuccess, cookieHeader: getCookieHeader(), submitBody: submitRes.body };
}

// ─── Natív Teljes Böngészős Regisztráció (Playwright Stealth + Turnstile + WPForms) ───
async function doFullRegistrationViaBrowser(mailAccount, firstName, lastName, country, device, iptv_app) {
  const email = mailAccount.address;
  const fullName = `${firstName} ${lastName}`;
  console.log(`[*] Teljes natív böngészős regisztráció indítása: ${email} (${fullName}, ${country}, ${device}, ${iptv_app})...`);

  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        '--mute-audio',
        '--window-size=1280,800'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'Europe/Berlin'
    });

    await context.addInitScript(() => {
      // Automation and webdriver masking
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        delete Object.getPrototypeOf(navigator).webdriver;
      } catch (e) {}

      try {
        window.chrome = {
          runtime: {},
          loadTimes: function() {},
          csi: function() {},
          app: {}
        };
      } catch (e) {}

      // Google referrer spoofing (matches Botasaurus / ScrapeOps best practice)
      try {
        Object.defineProperty(document, 'referrer', { get: () => 'https://www.google.com/' });
      } catch (e) {}

      // Hardware and memory spoofing
      try {
        Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
        Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      } catch (e) {}

      // WebGL vendor & renderer spoofing (NVIDIA instead of SwiftShader)
      try {
        const spoofWebGL = (proto) => {
          if (!proto) return;
          const orig = proto.getParameter;
          proto.getParameter = function(param) {
            if (param === 37445) return 'Google Inc. (NVIDIA)';
            if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)';
            return orig.apply(this, arguments);
          };
        };
        if (typeof WebGLRenderingContext !== 'undefined') spoofWebGL(WebGLRenderingContext.prototype);
        if (typeof WebGL2RenderingContext !== 'undefined') spoofWebGL(WebGL2RenderingContext.prototype);
      } catch (e) {}

      // Anti-collapse CSS to guarantee non-zero height and visibility for Turnstile widget
      try {
        const style = document.createElement('style');
        style.textContent = `
          #ivl-ts-box {
            min-height: 70px !important;
            height: 70px !important;
            width: 305px !important;
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
            margin: 15px auto !important;
          }
          #ivl-ts-box iframe {
            min-height: 65px !important;
            height: 65px !important;
            width: 300px !important;
            display: block !important;
            visibility: visible !important;
            opacity: 1 !important;
          }
        `;
        (document.head || document.documentElement).appendChild(style);
      } catch (e) {}

      // Safe postMessage wrapper to prevent Cloudflare Turnstile target origin mismatch crash
      try {
        const origPM = window.postMessage;
        if (typeof origPM === 'function') {
          window.postMessage = function(message, targetOrigin, transfer) {
            if (typeof targetOrigin === 'string' && targetOrigin.includes('challenges.cloudflare.com')) {
              targetOrigin = '*';
            }
            try {
              return origPM.call(this, message, targetOrigin, transfer);
            } catch (err) {
              if (err && err.message && err.message.includes('target origin provided')) {
                return;
              }
              throw err;
            }
          };
        }
      } catch (e) {}

      // Hook attachShadow to force open mode and collect all shadow roots
      try {
        const origAttachShadow = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
          const shadow = origAttachShadow.call(this, { mode: 'open', delegatesFocus: init && init.delegatesFocus });
          if (!window.__cfShadowRoots) window.__cfShadowRoots = [];
          window.__cfShadowRoots.push(shadow);
          window.__cfShadowRoot = shadow;
          console.log('[attachShadow Hook] Attached open shadow root');
          return shadow;
        };
        Element.prototype.attachShadow.toString = () => 'function attachShadow() { [native code] }';
      } catch (e) {}

      // Clean Turnstile Interceptor without duplicate triggers
      window.__cfTurnstileToken = null;
      window.__cfTurnstileWidgetId = null;

      function wrapTurnstile(tsObj) {
        if (!tsObj || tsObj._wrapped) return tsObj;
        tsObj._wrapped = true;
        console.log('[wrapTurnstile] Hooking turnstile methods');
        const origRender = tsObj.render;
        if (typeof origRender === 'function') {
          tsObj.render = function(container, params) {
            console.log('[Turnstile Render] Intercepted render call, original params:', JSON.stringify(params));
            const p = Object.assign({}, params, { appearance: 'always' });
            const origCb = p.callback;
            p.callback = function(tok) {
              console.log('[Turnstile Hook] Got token:', tok ? tok.substring(0, 15) + '...' : 'empty');
              window.__cfTurnstileToken = tok;
              try {
                let inp = document.querySelector('input[name="cf-turnstile-response"]');
                if (!inp) {
                  inp = document.createElement('input');
                  inp.type = 'hidden';
                  inp.name = 'cf-turnstile-response';
                  (document.querySelector('form.wpforms-form') || document.body).appendChild(inp);
                }
                inp.value = tok;
              } catch (e) {}
              if (origCb) {
                try { origCb(tok); } catch(e) {}
              }
            };
            const origErr = p['error-callback'];
            p['error-callback'] = function(err) {
              console.log('[Turnstile Hook] Error code:', err);
              if (origErr) {
                try { origErr(err); } catch(e) {}
              }
            };
            const wid = origRender.call(this, container, p);
            window.__cfTurnstileWidgetId = wid;
            return wid;
          };
        }
        return tsObj;
      }

      // Intercept window.ivlTsReady
      let _origTsReady = undefined;
      try {
        Object.defineProperty(window, 'ivlTsReady', {
          configurable: true,
          enumerable: true,
          get() { return _origTsReady; },
          set(fn) {
            console.log('[Hook] window.ivlTsReady registered');
            _origTsReady = function() {
              console.log('[Hook] window.ivlTsReady executing');
              if (window.turnstile) wrapTurnstile(window.turnstile);
              return fn.apply(this, arguments);
            };
          }
        });
      } catch (e) {}

      // Fetch interceptor to ensure X-IVL-TS is present
      const origFetch = window.fetch;
      window.fetch = async function(input, init) {
        const url = typeof input === 'string' ? input : ((input && input.url) || '');
        if (url.includes('/wp-json/ivl/v1/send')) {
          console.log('[Fetch Intercept] /wp-json/ivl/v1/send captured');
          init = init || {};
          init.headers = Object.assign({}, init.headers);

          if (!init.headers['X-IVL-TS']) {
            let t = window.__cfTurnstileToken;
            if (!t) {
              const inp = document.querySelector('input[name="cf-turnstile-response"]');
              if (inp && inp.value) t = inp.value;
            }
            if (!t && window.turnstile && typeof window.turnstile.getResponse === 'function') {
              try { t = window.turnstile.getResponse(window.__cfTurnstileWidgetId); } catch(e) {}
            }
            if (t) {
              init.headers['X-IVL-TS'] = t;
              console.log('[Fetch Intercept] Attached X-IVL-TS token to send request!');
            } else {
              console.log('[Fetch Intercept] WARNING: No token available for /send request');
            }
          }
        }
        return origFetch.call(this, input, init);
      };
    });

    const page = await context.newPage();
    page.on('console', msg => console.log(`[Browser] ${msg.text()}`));
    page.on('pageerror', err => console.log(`[Browser Error] ${err.message}`));

    page.on('response', async (response) => {
      const u = response.url();
      if (u.includes('/wp-json/ivl/v1/send')) {
        const text = await response.text().catch(() => '');
        console.log(`[API Response] /ivl/v1/send (${response.status()}): ${text}`);
      }
      if (u.includes('/wp-json/ivl/v1/verify')) {
        const text = await response.text().catch(() => '');
        console.log(`[API Response] /ivl/v1/verify (${response.status()}): ${text}`);
      }
    });

    console.log(`[*] Navigálás a céloldalra: ${TARGET_URL} (Google Referrer)...`);
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 35000, referer: 'https://www.google.com/' });
    await sleep(2000);

    // Görgetés le az űrlaphoz (hogy a Seraph-Accel aktiválja az űrlap scripteket)
    await page.evaluate(() => {
      window.scrollTo(0, 1000);
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('mousemove'));
    });
    await sleep(1500);

    // 1. Kitöltjük a mezőket
    console.log(`[*] Űrlapmezők kitöltése a böngészőben...`);
    const nameInput = page.locator('input[name="wpforms[fields][1]"]').first();
    await nameInput.fill(fullName);

    const emailInput = page.locator('input[name="wpforms[fields][2]"]').first();
    await emailInput.fill(email);

    // Ország kiválasztása
    try {
      await page.locator('select[name="wpforms[fields][36]"]').first().selectOption({ label: country });
    } catch {
      try { await page.locator('select[name="wpforms[fields][36]"]').first().selectOption({ index: 1 }); } catch {}
    }

    // Eszköz kiválasztása (Smart TV)
    try {
      await page.locator('select[name="wpforms[fields][5]"]').first().selectOption({ value: 'Smart TV' });
    } catch {}

    // App kiválasztása (Iptv Smarters Pro)
    try {
      await page.locator('select[name="wpforms[fields][9]"]').first().selectOption({ value: 'Iptv Smarters Pro' });
    } catch {}

    await sleep(1000);

    // 2. Turnstile előzetes ellenőrzés és feloldás a beküldés előtt
    console.log(`[*] Turnstile token előkészítése / feloldása a submit előtt...`);
    let turnstileToken = null;
    let clickedTurnstile = false;

    for (let s = 0; s < 45; s++) {
      turnstileToken = await page.evaluate(() => {
        if (window.__cfTurnstileToken) return window.__cfTurnstileToken;

        // A) Keresés light DOM input/textarea elemekben
        const inp = document.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
        if (inp && inp.value && inp.value.length > 10) return inp.value;

        // B) Keresés az összes elkapott shadow root input/textarea elemében
        if (window.__cfShadowRoots && Array.isArray(window.__cfShadowRoots)) {
          for (const sr of window.__cfShadowRoots) {
            try {
              const sinp = sr.querySelector('input[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]');
              if (sinp && sinp.value && sinp.value.length > 10) return sinp.value;
            } catch (e) {}
          }
        }

        // C) Keresés a turnstile API getResponse metódusán keresztül
        if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
          try {
            const r1 = window.turnstile.getResponse();
            if (r1 && r1.length > 10) return r1;
            if (window.__cfTurnstileWidgetId !== null && window.__cfTurnstileWidgetId !== undefined) {
              const r2 = window.turnstile.getResponse(window.__cfTurnstileWidgetId);
              if (r2 && r2.length > 10) return r2;
            }
          } catch (e) {}
        }
        return null;
      }).catch(() => null);

      if (turnstileToken) {
        console.log(`[+] Turnstile token sikeresen megszerezve (${s}s): ${turnstileToken.substring(0, 25)}...`);
        await page.evaluate(t => { window.__cfTurnstileToken = t; }, turnstileToken).catch(() => {});
        break;
      }

      // Görgetés a Turnstile dobozhoz és stílusának megerősítése
      try {
        await page.evaluate(() => {
          const box = document.getElementById('ivl-ts-box');
          if (box) {
            box.style.minHeight = '70px';
            box.style.height = '70px';
            box.style.display = 'block';
            box.style.visibility = 'visible';
            box.scrollIntoView({ behavior: 'instant', block: 'center' });
          }
        }).catch(() => {});
      } catch (e) {}

      // Diagnosztika: shadowIframes részletes állapotának és koordinátáinak naplózása
      if (s % 5 === 0) {
        const diag = await page.evaluate(() => {
          const box = document.getElementById('ivl-ts-box');
          const r = box ? box.getBoundingClientRect() : null;
          let shadowIframes = [];
          if (window.__cfShadowRoots && Array.isArray(window.__cfShadowRoots)) {
            for (let i = 0; i < window.__cfShadowRoots.length; i++) {
              try {
                const ifrs = Array.from(window.__cfShadowRoots[i].querySelectorAll('iframe')).map(f => {
                  const fr = f.getBoundingClientRect();
                  return {
                    srIdx: i,
                    src: (f.src || '').substring(0, 45),
                    rect: { x: Math.round(fr.x), y: Math.round(fr.y), w: Math.round(fr.width), h: Math.round(fr.height) }
                  };
                });
                shadowIframes.push(...ifrs);
              } catch (e) {}
            }
          }
          let tokenVal = null;
          const inp = document.querySelector('input[name="cf-turnstile-response"]');
          if (inp && inp.value) tokenVal = inp.value.substring(0, 15);
          return {
            hasBox: !!box,
            rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
            shadowIframes,
            tokenVal,
            hasTsObj: !!window.turnstile,
            widgetId: window.__cfTurnstileWidgetId,
            cfToken: (window.__cfTurnstileToken || '').substring(0, 15)
          };
        }).catch(() => null);
        if (diag) {
          console.log(`[Diag ${s}s] box: ${JSON.stringify(diag.rect)}, iframes: ${JSON.stringify(diag.shadowIframes)}, token: ${diag.cfToken || diag.tokenVal || 'none'}, wId: ${diag.widgetId}`);
        }
      }

      // Hiteles Turnstile kattintás (EzSolver kétlépcsős természetes egérmozgással)
      if (!clickedTurnstile && s >= 2) {
        try {
          let box = null;
          let targetName = '';

          const elementData = await page.evaluate(() => {
            try {
              // A) Keresés az összes elmentett shadow root-ban található iframe-ek között
              if (window.__cfShadowRoots && Array.isArray(window.__cfShadowRoots)) {
                for (const sr of window.__cfShadowRoots) {
                  try {
                    const ifrs = Array.from(sr.querySelectorAll('iframe'));
                    for (const ifr of ifrs) {
                      const r = ifr.getBoundingClientRect();
                      if (r.width > 50 && r.height > 20) {
                        return { isIframe: true, x: r.x, y: r.y, width: r.width, height: r.height };
                      }
                    }
                  } catch (e) {}
                }
              }

              // B) Keresés a normál DOM-ban lévő iframe-ek között
              const normalIframes = Array.from(document.querySelectorAll('#ivl-ts-box iframe, iframe[src*="cloudflare"], iframe[src*="turnstile"]'));
              for (const ifr of normalIframes) {
                const r = ifr.getBoundingClientRect();
                if (r.width > 50 && r.height > 20) {
                  return { isIframe: true, x: r.x, y: r.y, width: r.width, height: r.height };
                }
              }

              // C) Ha az iframe mérete még nem elérhető, az #ivl-ts-box konténerre támaszkodunk
              const b = document.getElementById('ivl-ts-box');
              if (b) {
                const r = b.getBoundingClientRect();
                if (r.width > 50 && r.height > 20) {
                  return { isIframe: false, x: r.x, y: r.y, width: r.width, height: r.height };
                }
              }
            } catch(e) {}
            return null;
          }).catch(() => null);

          if (elementData) {
            box = elementData;
            targetName = elementData.isIframe ? 'shadow/dom Iframe' : '#ivl-ts-box fallback';
          }

          if (box && box.width > 20 && box.height > 20) {
            // EzSolver technika: pontos checkbox koordináta és kétlépcsős természetes megközelítés
            const offsetX = (box.isIframe === false && box.width > 320) ? Math.round((box.width - 300) / 2) : 0;
            const cx = box.x + offsetX + 28;
            const cy = box.y + Math.round(box.height / 2);

            console.log(`[Turnstile EzSolver Click] Hiteles kattintás a ${targetName} elemre (${s}s): (${Math.round(cx)}, ${Math.round(cy)}) [méret: ${Math.round(box.width)}x${Math.round(box.height)}]`);
            await page.mouse.move(cx - 60, cy - 20, { steps: 8 });
            await sleep(180);
            await page.mouse.move(cx, cy, { steps: 6 });
            await sleep(120);
            await page.mouse.down();
            await sleep(90);
            await page.mouse.up();

            clickedTurnstile = true;
            console.log(`[Turnstile] Kattintás sikeresen elküldve, várakozás a feloldásra...`);
          }
        } catch (e) {
          console.log(`[Turnstile Native Click Error] ${e.message}`);
        }
      }

      // Újrapróbálás 10s-nél és 22s-nél ha a Turnstile resetelődött vagy még nem adott tokent (min 6s EzSolver intervallum)
      if ((s === 10 || s === 22) && !turnstileToken) {
        console.log(`[Turnstile] Újrapróbálás engedélyezve (${s}s)...`);
        clickedTurnstile = false;
      }

      await sleep(1000);
    }

    if (!turnstileToken) {
      console.error(`[-] Turnstile token nem jött létre a várakozási idő alatt.`);
      await browser.close();
      return { success: false };
    }

    // 3. Submit gombra kattintás (ez aktiválja az ivl-verify kódkérést)
    console.log(`[*] Submit gombra kattintás az ellenőrző kód kiküldéséhez...`);
    const submitBtn = page.locator('#wpforms-submit-1019, button[type="submit"].wpforms-submit').first();
    await submitBtn.click();

    // 4. Submit utáni Turnstile figyelés és esetleges Resend
    for (let s = 0; s < 30; s++) {
      let t = await page.evaluate(() => {
        if (window.__cfTurnstileToken) return window.__cfTurnstileToken;
        const inp = document.querySelector('input[name="cf-turnstile-response"]');
        return (inp && inp.value) ? inp.value : null;
      }).catch(() => null);

      if (t) {
        await page.evaluate(token => { window.__cfTurnstileToken = token; }, t).catch(() => {});
        break;
      }
      await sleep(1000);
    }

    await sleep(2000);
    for (let retry = 0; retry < 5; retry++) {
      const ivlErr = await page.evaluate(() => document.querySelector('.ivl-err')?.textContent || '').catch(() => '');
      if (ivlErr && ivlErr.includes('Security check')) {
        console.log(`[!] IVL hiba észlelve: "${ivlErr}". Várakozás tokenre és Resend gomb...`);
        await sleep(3000);
        const resendBtn = page.locator('button.ivl-resend').first();
        if (await resendBtn.count() > 0 && await resendBtn.isEnabled().catch(() => false)) {
          await resendBtn.click().catch(() => {});
          console.log(`[*] Resend gomb sikeresen megnyomva!`);
          break;
        }
      } else {
        break;
      }
    }

    // 5. Várakozás a megerősítő kódra Emailnatorból
    console.log(`[*] Várakozás a megerősítő email kódra (${email})...`);
    let verificationCode = null;
    const maxWaitMs = 75000;
    const pollIntervalMs = 4000;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      console.log(`[*] Ellenőrizzük az email fiókot... (${Math.round((Date.now() - startTime) / 1000)}s)`);
      await sleep(pollIntervalMs);

      try {
        const messages = await checkInbox(mailAccount);
        for (const msg of messages) {
          const subject = msg.subject || '';
          const subjectMatch = subject.match(/\b(\d{6})\b/);
          if (subjectMatch) {
            verificationCode = subjectMatch[1];
            console.log(`[+] MEGERŐSÍTŐ KÓD TÁRGYBÓL: ${verificationCode}`);
            break;
          }

          const full = await readMessage(mailAccount, msg.id);
          const bodyText = full.body || '';
          const codeMatch = bodyText.match(/\b(\d{6})\b/);
          if (codeMatch) {
            verificationCode = codeMatch[1];
            console.log(`[+] MEGERŐSÍTŐ KÓD TÖRZSBŐL: ${verificationCode}`);
            break;
          }
        }
      } catch (err) {
        console.log(`[-] inbox ellenőrzési hiba: ${err.message}`);
      }

      if (verificationCode) break;
    }

    if (!verificationCode) {
      console.error(`[-] Nem érkezett meg a 6 jegyű kód.`);
      await browser.close();
      return { success: false };
    }

    // 6. Beírjuk a 6 jegyű kódot a weboldal mezőjébe
    console.log(`[*] Megerősítő kód (${verificationCode}) beírása a weboldalon...`);
    const codeInput = page.locator('input.ivl-code, .ivl-box input[type="text"]').first();
    await codeInput.fill(verificationCode);
    await sleep(500);

    const verifyBtn = page.locator('button.ivl-verify').first();
    if (await verifyBtn.count() > 0 && await verifyBtn.isVisible()) {
      await verifyBtn.click();
    }

    // 7. Várakozás a beküldésre és siker visszaigazolásra
    console.log(`[*] Várakozás a végleges WPForms beküldésre...`);
    let formSuccess = false;
    for (let j = 0; j < 25; j++) {
      const confirmationMsg = page.locator('.wpforms-confirmation-container, .ivl-done, div[id*="wpforms-confirmation"]').first();
      if (await confirmationMsg.count() > 0 && await confirmationMsg.isVisible()) {
        const text = await confirmationMsg.textContent().catch(() => '');
        console.log(`[+] SIKERES REGISZTRÁCIÓ! Visszaigazolás: ${text.trim()}`);
        formSuccess = true;
        break;
      }

      const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
      if (bodyText.includes('Thank you') || bodyText.includes('successful') || bodyText.includes('trial request') || bodyText.includes('sent')) {
        console.log(`[+] SIKERES ŰRLAP BEKÜLDÉS ÉSZLELVE!`);
        formSuccess = true;
        break;
      }

      await sleep(1000);
    }

    const browserCookies = await context.cookies();
    const cookieHeader = browserCookies.map(c => `${c.name}=${c.value}`).join('; ');

    await browser.close();
    return { success: formSuccess, cookieHeader };
  } catch (err) {
    console.error(`[-] Hiba a böngészős regisztráció során: ${err.message}`);
    if (browser) {
      try { await browser.close(); } catch {}
    }
    return { success: false };
  }
}

// ─── SmailPro API (valódi Gmail pool, Turnstile x-captcha bypass) ───
const SMAILPRO_SITEKEY = '0x4AAAAAAABIS_gEec2IwOhI';
const SMAILPRO_URL = 'https://smailpro.com/temporary-email';

async function generateSmailProAccount() {
  console.log(`[*] SmailPro Gmail fiók igénylése...`);
  const tsToken = await getTurnstileToken(SMAILPRO_URL, SMAILPRO_SITEKEY, 'smailpro_auto');
  if (!tsToken) {
    console.log(`[-] Nem sikerült Turnstile tokent szerezni a SmailPro-hoz`);
    return null;
  }

  const createUrl = 'https://smailpro.com/app/create?username=random&type=alias&domain=gmail.com&server=1';
  const res = await httpRequest(createUrl, {
    method: 'GET',
    headers: {
      'x-captcha': tsToken,
      'Referer': SMAILPRO_URL,
      'Origin': 'https://smailpro.com',
      'Accept': 'application/json'
    }
  });

  if (res.status === 200) {
    try {
      const data = JSON.parse(res.body);
      const email = data.address || data.email;
      if (email && email.includes('@')) {
        console.log(`[+] SmailPro Gmail sikeresen legenerálva: ${email}`);
        return {
          provider: 'smailpro',
          address: email,
          key: data.key || '',
          createdAt: Date.now(),
          createdAtSeconds: Math.floor(Date.now() / 1000)
        };
      }
      console.log(`[-] SmailPro válasz nem tartalmazott emailt: ${res.body.substring(0, 150)}`);
    } catch (e) {
      console.log(`[-] SmailPro JSON parse hiba: ${e.message}`);
    }
  } else {
    console.log(`[-] SmailPro create HTTP ${res.status}: ${(res.body || '').substring(0, 150)}`);
  }
  return null;
}

async function checkSmailProInbox(account) {
  try {
    const inboxPayloadRes = await httpRequest('https://smailpro.com/app/inbox', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': SMAILPRO_URL,
        'Origin': 'https://smailpro.com'
      },
      body: JSON.stringify([{
        address: account.address,
        timestamp: Math.floor((account.createdAt || Date.now()) / 1000),
        key: account.key || ''
      }])
    });

    if (inboxPayloadRes.status !== 200) {
      return [];
    }

    const payloadData = JSON.parse(inboxPayloadRes.body);
    const item = Array.isArray(payloadData) ? payloadData[0] : payloadData;
    if (!item || !item.payload) {
      return [];
    }

    const mailRes = await httpRequest(`https://api.sonjj.com/v1/temp_gmail/inbox?payload=${encodeURIComponent(item.payload)}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Referer': SMAILPRO_URL,
        'Origin': 'https://smailpro.com'
      }
    });

    if (mailRes.status === 200) {
      const data = JSON.parse(mailRes.body);
      const messages = (data.messages || []).map(m => ({
        id: m.mid,
        from: m.textFrom || m.from || '',
        subject: m.textSubject || m.subject || '',
        body: m.body || '',
        date: m.date
      }));
      return messages;
    }
  } catch (err) {
    console.log(`[-] SmailPro checkInbox hiba: ${err.message}`);
  }
  return [];
}

async function readSmailProMessage(account, msgId) {
  try {
    const payloadRes = await httpRequest('https://smailpro.com/app/payload?url=' + encodeURIComponent('https://api.sonjj.com/v1/temp_gmail/message') + '&email=' + encodeURIComponent(account.address) + '&mid=' + encodeURIComponent(msgId), {
      method: 'GET',
      headers: {
        'Referer': SMAILPRO_URL,
        'Origin': 'https://smailpro.com'
      }
    });
    if (payloadRes.status === 200 && payloadRes.body) {
      const msgRes = await httpRequest('https://api.sonjj.com/v1/temp_gmail/message?payload=' + encodeURIComponent(payloadRes.body.trim()), {
        method: 'GET',
        headers: {
          'Referer': SMAILPRO_URL,
          'Origin': 'https://smailpro.com'
        }
      });
      if (msgRes.status === 200) {
        const d = JSON.parse(msgRes.body);
        return {
          from: d.textFrom || d.from || '',
          subject: d.textSubject || d.subject || '',
          body: d.body || d.text || ''
        };
      }
    }
  } catch (e) {}
  return { from: '', subject: '', body: '' };
}

async function deleteSmailProAccount(account) {
  if (!account || !account.address || account.provider !== 'smailpro') return;
  try {
    console.log(`[*] SmailPro cím törlése a szerverről (${account.address})...`);
    await httpRequest('https://smailpro.com/app/delete', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Referer': SMAILPRO_URL,
        'Origin': 'https://smailpro.com'
      },
      body: JSON.stringify({ email: account.address, key: account.key || '' })
    });
    console.log(`[+] SmailPro cím sikeresen törölve.`);
  } catch (e) {
    console.log(`[-] SmailPro törlés hiba: ${e.message}`);
  }
}

// ─── temp email (SmailPro + Emailnator API) ───────────

let emailnatorCycleCount = 0;

async function generateEmailnatorAccount() {
  emailnatorCycleCount++;
  // Cycle 1: [3] -> dot-addressed real @gmail.com (e.g. m.arlon.dio.n29@gmail.com)
  // Cycle 2: [1] -> fresh custom domain (@smartnator.com, @mydefipet.live, etc.)
  // Cycle 3: [3] -> dot-addressed real @gmail.com
  const preferredIds = (emailnatorCycleCount % 2 === 1) ? [3] : [1];

  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const currentIds = attempt === 1 ? preferredIds : (attempt % 2 === 0 ? [3] : [1]);
      console.log(`[*] Emailnator generation attempt ${attempt}/10 (ids: ${JSON.stringify(currentIds)})...`);
      const res = await httpRequest('https://www.emailnator.com/api/generate-email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Origin': 'https://www.emailnator.com',
          'Referer': 'https://www.emailnator.com/'
        },
        body: JSON.stringify({ ids: currentIds })
      });

      if (res.status === 200) {
        const data = JSON.parse(res.body);
        if (data.status === 'success' && data.email && !data.email.includes('+')) {
          console.log(`[+] Emailnator generated: ${data.email}`);
          return {
            provider: 'emailnator',
            address: data.email,
            createdAt: Date.now(),
            createdAtSeconds: Math.floor(Date.now() / 1000)
          };
        }
      }
      console.log(`[-] Emailnator HTTP ${res.status}: ${(res.body || '').substring(0, 100)}`);
    } catch (err) {
      console.log(`[-] Emailnator attempt ${attempt} error: ${err.message}`);
    }
    await sleep(1500);
  }
  return null;
}

async function checkEmailnatorInbox(account) {
  try {
    const res = await httpRequest('https://www.emailnator.com/api/message-list', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Origin': 'https://www.emailnator.com',
        'Referer': 'https://www.emailnator.com/'
      },
      body: JSON.stringify({ email: account.address, limit: 25 })
    });

    if (res.status === 200) {
      const data = JSON.parse(res.body);
      const messages = (data.messages || []).filter(m => {
        return !account.createdAtSeconds || (m.timestamp >= account.createdAtSeconds - 120);
      });
      return messages.map(m => ({
        id: m.id,
        from: m.from || '',
        subject: m.subject || '',
        timestamp: m.timestamp,
        timeAgo: m.time_ago
      }));
    }
  } catch (err) {
    console.log(`[-] Emailnator checkInbox error: ${err.message}`);
  }
  return [];
}

async function readEmailnatorMessage(msgId) {
  try {
    const res = await httpRequest(`https://www.emailnator.com/api/message/${encodeURIComponent(msgId)}`, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Origin': 'https://www.emailnator.com',
        'Referer': 'https://www.emailnator.com/'
      }
    });

    if (res.status === 200) {
      const data = JSON.parse(res.body);
      return {
        from: data.from || '',
        subject: data.subject || '',
        body: data.content || ''
      };
    }
  } catch (err) {
    console.log(`[-] Emailnator readMessage error: ${err.message}`);
  }
  return { from: '', subject: '', body: '' };
}

async function createTempMailAccount() {
  // 1. Elsődleges: SmailPro (valódi, friss Gmail fiókok, nem tiltottak az iptvloadon)
  for (let retry = 1; retry <= 3; retry++) {
    const smailAcc = await generateSmailProAccount();
    if (smailAcc) return smailAcc;
    console.log(`[-] SmailPro próbálkozás retry ${retry}/3...`);
    await sleep(2000 * retry);
  }

  // 2. Tartalék: Emailnator
  console.log(`[*] Váltás Emailnator tartalékra...`);
  for (let retry = 1; retry <= 3; retry++) {
    const emailnatorAcc = await generateEmailnatorAccount();
    if (emailnatorAcc) return emailnatorAcc;
    console.log(`[-] Emailnator generation retry ${retry}/3...`);
    await sleep(2000 * retry);
  }
  return null;
}

async function deleteTempMailAccount(account) {
  if (!account) return;
  if (account.provider === 'smailpro') {
    return await deleteSmailProAccount(account);
  }
  if (!account.aliasId || account.provider !== 'simplelogin') return;
  try {
    const res = await httpRequest(`${SIMPLELOGIN_API}/api/aliases/${account.aliasId}`, {
      method: 'DELETE',
      headers: {
        'Authentication': SIMPLELOGIN_API_KEY
      }
    });
    if (res.status === 200) {
      console.log(`[+] SimpleLogin alias deleted: ${account.address} (ID: ${account.aliasId})`);
    } else {
      console.log(`[-] SimpleLogin delete status ${res.status}: ${res.body}`);
    }
  } catch (err) {
    console.log(`[-] SimpleLogin delete error: ${err.message}`);
  }
}

async function checkInbox(account) {
  if (account && account.provider === 'smailpro') {
    return await checkSmailProInbox(account);
  }
  if (account && account.provider === 'emailnator') {
    return await checkEmailnatorInbox(account);
  }

  const client = new ImapFlow(IMAP_CONFIG);
  const messages = [];

  try {
    await client.connect();
    const boxes = ['[Gmail]/Spam', 'INBOX'];
    for (const box of boxes) {
      try {
        const lock = await client.getMailboxLock(box);
        try {
          const uids = await client.search({ all: true }, { uid: true });
          if (uids && uids.length > 0) {
            const recentUids = uids.slice(-15).reverse();
            for await (const msg of client.fetch(recentUids, { uid: true, envelope: true })) {
              const subject = msg.envelope.subject || '';
              const from = msg.envelope.from?.[0]?.address || '';

              const msgDate = msg.envelope.date ? new Date(msg.envelope.date).getTime() : Date.now();
              const accountCreated = account.createdAt ? new Date(account.createdAt).getTime() : 0;
              if (msgDate >= accountCreated - 60000) {
                messages.push({
                  id: msg.uid,
                  mailbox: box,
                  from: from,
                  subject: subject,
                  date: msg.envelope.date
                });
              }
            }
          }
        } finally {
          lock.release();
        }
      } catch (boxErr) {
        console.log(`[-] error checking mailbox ${box}: ${boxErr.message}`);
      }
    }
    await client.logout();
  } catch (err) {
    console.log(`[-] IMAP checkInbox error: ${err.message}`);
  }

  return messages;
}

async function readMessage(account, msgRef) {
  if (account && account.provider === 'smailpro') {
    const msgId = typeof msgRef === 'object' ? msgRef.id : msgRef;
    return await readSmailProMessage(account, msgId);
  }
  if (account && account.provider === 'emailnator') {
    const msgId = typeof msgRef === 'object' ? msgRef.id : msgRef;
    return await readEmailnatorMessage(msgId);
  }

  const client = new ImapFlow(IMAP_CONFIG);
  let result = { from: '', subject: '', body: '' };

  const msgUid = typeof msgRef === 'object' ? msgRef.id : msgRef;
  const preferredBox = (typeof msgRef === 'object' && msgRef.mailbox) ? msgRef.mailbox : '[Gmail]/Spam';
  const boxes = [preferredBox, preferredBox === 'INBOX' ? '[Gmail]/Spam' : 'INBOX'];

  try {
    await client.connect();
    for (const box of boxes) {
      try {
        const lock = await client.getMailboxLock(box);
        try {
          const msg = await client.fetchOne(String(msgUid), { source: true }, { uid: true });
          if (msg && msg.source) {
            const parsed = await simpleParser(msg.source);
            result = {
              from: parsed.from?.text || '',
              subject: parsed.subject || '',
              body: parsed.text || parsed.html || ''
            };
            lock.release();
            break;
          }
        } finally {
          try { lock.release(); } catch {}
        }
      } catch {}
    }
    await client.logout();
  } catch (err) {
    console.log(`[-] IMAP readMessage error: ${err.message}`);
  }

  return result;
}

// ─── WPForms submission ──────────────────────────────────────────

async function doRegistration() {
  const timestamp = new Date().toISOString();
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[${timestamp}] starting registration...`);

  let mailAccount = null;

  for (let regAttempt = 1; regAttempt <= 8; regAttempt++) {
    try {
      console.log(`\n[*] Registration cycle attempt ${regAttempt}/8...`);
      mailAccount = await createTempMailAccount();
      if (!mailAccount) {
        console.log(`[-] Nem sikerült Emailnator fiókot generálni, újrapróbálás...`);
        await sleep(3000);
        continue;
      }
      let email = mailAccount.address;
      const firstName = pick(FIRST_NAMES);
      const lastName = pick(LAST_NAMES);
      const fullName = `${firstName} ${lastName}`;
      const country = pick(COUNTRIES);
      const device = pick(DEVICES);
      const iptv_app = pick(APPS);

      console.log(`[+] email: ${email}`);
      console.log(`[+] name: ${fullName}`);
      console.log(`[+] country: ${country}`);
      console.log(`[+] device: ${device}`);
      console.log(`[+] app: ${iptv_app}`);

      let regRes = null;
      console.log(`[*] Gyors HTTP + TLS ujjlenyomat (curl_cffi + solve_turnstile.py) regisztráció indítása...`);
      regRes = await doHttpRegistration(mailAccount, firstName, lastName, country, device, iptv_app);

        if (!regRes || !regRes.success) {
        console.log(`[-] Regisztráció nem sikerült ennél a próbálkozásnál (${regRes ? regRes.code : 'unknown'}), új ciklus...`);
        await deleteTempMailAccount(mailAccount);
        await sleep(3000);
        continue;
      }

      console.log(`[+] ŰRLAP SIKERESEN BEKÜLDVE!`);
      const submitCookies = regRes.cookieHeader || '';

      console.log(`[*] waiting for IPTV credentials (checking trial-status API & inbox, up to 2.5 minutes)...`);
      let foundCreds = false;
      let consecutivePending = 0;
      for (let pollAttempt = 1; pollAttempt <= 25; pollAttempt++) {
        await sleep(6000);

        try {
          const trialHeaders = {
            'Accept': 'application/json',
            'Referer': 'https://iptvload.org/thank-you/'
          };
          if (submitCookies) trialHeaders['Cookie'] = submitCookies;
          const trialRes = await httpRequest(`https://iptvload.org/wp-json/iptvload/v1/trial-status?_=${Date.now()}`, {
            method: 'GET',
            headers: trialHeaders
          });
          console.log(`[*] trial-status poll ${pollAttempt}: HTTP ${trialRes.status} -> ${(trialRes.body || '').substring(0, 150)}`);
          if (trialRes.status === 200) {
            const tData = JSON.parse(trialRes.body);
            if (tData.state === 'ready' && tData.details && tData.details.username) {
              console.log(`[+] received credentials directly from iptvload trial-status API!`);
              activeCreds.username = tData.details.username;
              activeCreds.password = tData.details.password;
              const serverList = [];
              const addServer = (u) => {
                if (!u) return;
                const clean = String(u).replace(/\/$/, '').trim();
                if (clean && !clean.includes('trial-onetvup') && !serverList.includes(clean)) {
                  serverList.push(clean);
                }
              };
              addServer('http://cf.iptvload.link');
              addServer('http://pro.loadshow.link');
              addServer(tData.details.server_other);
              addServer(tData.details.server);
              addServer(tData.details.server_uk);
              if (serverList.length === 0) serverList.push('http://cf.iptvload.link', 'http://iptvload.link');
              activeCreds.servers = serverList;
              activeCreds.portalUrl = `${serverList[0]}/get.php?username=${activeCreds.username}&password=${activeCreds.password}&type=m3u_plus&output=ts`;
              activeCreds.registeredAt = new Date().toISOString();
              foundCreds = true;
              break;
            } else if (tData.state === 'pending') {
              consecutivePending++;
              if (consecutivePending >= 20) {
                console.log(`[-] trial-status elérte a 20 pending próbálkozást (~120s). Megszakítás és új generálás...`);
                break;
              }
            }
          }
        } catch (err) {
          console.log(`[-] trial-status poll warning: ${err.message}`);
        }

        if (!foundCreds && (pollAttempt % 2 === 0)) {
          try {
            const messages = await checkInbox(mailAccount);
            console.log(`[*] Inbox ellenőrzése (${mailAccount.address})... levelek száma: ${messages.length}`);
            if (messages && messages.length > 0) {
              for (const msg of messages) {
                if (msg.subject && msg.subject.toLowerCase().includes('verification code')) continue;
                const full = await readMessage(mailAccount, msg.id);
                console.log(`[+] candidate email from: ${full.from || 'unknown'} | subject: ${full.subject}`);
                const bodyText = (full.body || '').replace(/<[^>]+>/g, ' ');

                const creds = extractCredentials(bodyText);
                if (creds.username && creds.password) {
                  activeCreds.username = creds.username;
                  activeCreds.password = creds.password;
                  activeCreds.portalUrl = creds.portalUrl || null;
                  activeCreds.servers = creds.servers || [];
                  activeCreds.registeredAt = new Date().toISOString();
                  foundCreds = true;
                  break;
                }
              }
            }
          } catch (err) {
            console.log(`[-] inbox poll warning: ${err.message}`);
          }
        }


        if (!foundCreds && IMAP_CONFIG.auth.user && mailAccount && mailAccount.provider === 'gmail_imap' && (pollAttempt % 3 === 0)) {
          try {
            const imapMessages = await checkInbox({ provider: 'gmail_imap', createdAt: new Date(Date.now() - 300000) });
            for (const msg of imapMessages) {
              if (msg.subject && msg.subject.toLowerCase().includes('verification code')) continue;
              const full = await readMessage({ provider: 'gmail_imap' }, msg.id);
              const bodyText = (full.body || '').replace(/<[^>]+>/g, ' ');
              const creds = extractCredentials(bodyText);
              if (creds.username && creds.password) {
                activeCreds.username = creds.username;
                activeCreds.password = creds.password;
                activeCreds.portalUrl = creds.portalUrl || null;
                activeCreds.servers = creds.servers || [];
                activeCreds.registeredAt = new Date().toISOString();
                foundCreds = true;
                break;
              }
            }
          } catch {}
        }

        if (foundCreds) {
          try {
            fs.writeFileSync(CREDS_FILE, JSON.stringify(activeCreds, null, 2));
          } catch (e) {
            console.log(`[-] error saving creds to disk: ${e.message}`);
          }

          const nextRun = new Date(Date.now() + REGISTER_INTERVAL_HOURS * 3600000);
          nextRegistrationTime = nextRun;
          refreshEpgCache(true);
          break;
        }
      }

      if (mailAccount) {
        await deleteTempMailAccount(mailAccount);
      }

      if (foundCreds) {
        runtimeLogs.length = 0;
        console.log(`[+] ═══════════════════════════════════════════════════════════════`);
        console.log(`[+] ÚJ IPTV FIÓK SIKERESEN AKTIVÁLVA ÉS HASZNÁLATBA VÉVE:`);
        console.log(`[+]   Felhasználónév:      ${activeCreds.username}`);
        console.log(`[+]   Jelszó:              ${activeCreds.password}`);
        console.log(`[+]   Szerverek:           ${activeCreds.servers.join(', ')}`);
        console.log(`[+]   Portal:              ${activeCreds.portalUrl || 'N/A'}`);
        console.log(`[+]   Regisztrálva:        ${formatBucharestTime(new Date(activeCreds.registeredAt))} (romániai idő)`);
        console.log(`[+]   Hátralévő próbaidő:  ${getRemainingTrialHours().toFixed(2)} óra (24h-ból)`);
        console.log(`[+]   Következő generálás: ${formatBucharestTime(nextRegistrationTime)} (romániai idő, ${REGISTER_INTERVAL_HOURS} óra múlva)`);
        console.log(`[+]   Generálási ciklus:   minden ${REGISTER_INTERVAL_HOURS} órában`);
        console.log(`[+] ═══════════════════════════════════════════════════════════════`);
        console.log(`[+] ACTIVE CREDENTIALS JSON:\n${JSON.stringify(activeCreds, null, 2)}`);
        return true;
      } else {
        console.log(`[-] kísérlet ${regAttempt}/8 nem adott új fiókot (pending maradt vagy nem érkezett adat).`);
        if (regAttempt < 8) {
          console.log(`[*] automatikusan próbálkozunk egy újabb email címmel (kísérlet ${regAttempt + 1}/8)...`);
          await sleep(4000);
          continue;
        }
      }

    } catch (err) {
      console.error(`[-] registration attempt ${regAttempt} error: ${err.message}`);
      if (mailAccount) {
        await deleteTempMailAccount(mailAccount);
      }
      await sleep(4000);
    }
  }

  console.error(`[-] all 8 registration attempts exhausted, keeping active trial`);
  const retryMinutes = 10;
  const retryTime = new Date(Date.now() + retryMinutes * 60000);
  nextRegistrationTime = retryTime;
  console.log(`[*] TOVÁBBRA IS A JELENLEGI AKTÍV FIÓK MARAD ÉRVÉNYBEN:`);
  console.log(`[*]   username:            ${activeCreds.username}`);
  console.log(`[*]   password:            ${activeCreds.password}`);
  console.log(`[*]   servers:             ${(activeCreds.servers || []).join(', ')}`);
  console.log(`[*]   regisztrálva:        ${formatBucharestTime(new Date(activeCreds.registeredAt))} (romániai idő)`);
  console.log(`[*]   újrapróbálás (retry): ${formatBucharestTime(retryTime)} (romániai idő, ${retryMinutes} perc múlva)`);
  console.log(`[${new Date().toISOString()}] registration cycle complete (KEPT CURRENT TRIAL)`);
  setTimeout(() => { runRegistration(); }, retryMinutes * 60000);
  return false;
}

// ─── IPTV proxy config & routes ───────────────────────────────────

const PROXY_USER = process.env.PROXY_USER || 'szaby';
const PROXY_PASS = process.env.PROXY_PASS || '2002';
const CREDS_FILE = path.join(__dirname, 'active_creds.json');

let activeCreds = {
  username: null,
  password: null,
  servers: [],
  portalUrl: null,
  registeredAt: null
};

try {
  if (fs.existsSync(CREDS_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8'));
    if (saved && saved.username && saved.password) {
      activeCreds = saved;
      activeCreds.username = activeCreds.username.replace(/[*]/g, '').trim();
      activeCreds.password = activeCreds.password.replace(/[*]/g, '').replace(/Start.*$/i, '').trim();
      console.log(`[+] loaded saved active credentials: ${activeCreds.username}`);
      console.log(`[+] ACTIVE CREDENTIALS JSON:\n${JSON.stringify(activeCreds, null, 2)}`);
    }
  }
} catch (e) {
  console.log(`[-] error reading saved creds: ${e.message}`);
}

function extractCredentials(bodyText) {
  const creds = {};

  const portalMatch = bodyText.match(/(https?:\/\/[^\s"'<>]+\/get\.php[^\s"'<>]*)/i);
  if (portalMatch) {
    creds.portalUrl = portalMatch[1];
    try {
      const parsed = new URL(creds.portalUrl);
      if (parsed.searchParams.get('username')) creds.username = parsed.searchParams.get('username');
      if (parsed.searchParams.get('password')) creds.password = parsed.searchParams.get('password');
    } catch {}
  }

  if (!creds.username) {
    const userMatch = bodyText.match(/USERNAME\s*:?\s*\*?([a-zA-Z0-9_\-]+)\*?/i);
    if (userMatch) creds.username = userMatch[1].replace(/[*]/g, '').trim();
  }

  if (!creds.password) {
    const passMatch = bodyText.match(/PASSWORD\s*:?\s*\*?([a-zA-Z0-9_\-]+)\*?/i);
    if (passMatch) creds.password = passMatch[1].replace(/[*]/g, '').trim();
  }

  const serverPattern = /(https?:\/\/[^\s"'<>]+(?:\.site|\.link|\.com|\.net|\.org|\.tv|\.stream|\.live)[\/]?)/gi;
  const servers = [];
  let m;
  while ((m = serverPattern.exec(bodyText)) !== null) {
    const url = m[1].replace(/\/$/, '');
    if (!url.includes('iptvload.org') && !url.includes('simplelogin') && !url.includes('get.php') && !url.includes('n8n.io') && !url.includes('mysortqr') && !servers.includes(url)) {
      servers.push(url);
    }
  }
  if (servers.length > 0) creds.servers = servers;

  if (creds.portalUrl) {
    try {
      const parsed = new URL(creds.portalUrl);
      const baseServer = `${parsed.protocol}//${parsed.host}`;
      if (!creds.servers) creds.servers = [];
      if (!creds.servers.includes(baseServer)) creds.servers.unshift(baseServer);
    } catch {}
  }

  return creds;
}

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

function proxyRequest(upstreamUrl, req, res) {
  const parsed = new URL(upstreamUrl);
  const client = parsed.protocol === 'https:' ? https : http;

  const reqHeaders = {
    'User-Agent': req.headers['user-agent'] || 'IPTVSmartersPro/3.1.5',
    'Accept': req.headers['accept'] || '*/*',
    'Accept-Encoding': req.headers['accept-encoding'] || 'gzip, deflate'
  };

  const proxyReq = client.request({
    hostname: parsed.hostname,
    port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
    path: parsed.pathname + parsed.search,
    method: 'GET',
    headers: reqHeaders
  }, (proxyRes) => {
    if ([301, 302, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
      const redirectUrl = new URL(proxyRes.headers.location, upstreamUrl).toString();
      return proxyRequest(redirectUrl, req, res);
    }
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  req.on('close', () => {
    try { proxyReq.destroy(); } catch {}
  });

  proxyReq.on('error', (err) => {
    console.error(`[-] proxy error: ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({ error: 'upstream server error', message: err.message });
    }
  });

  proxyReq.end();
}

function getCredentials(req) {
  let username = req.query.username || (req.body && req.body.username) || '';
  let password = req.query.password || (req.body && req.body.password) || '';
  const action = req.query.action || (req.body && req.body.action) || '';

  if (!username && req.headers.authorization && req.headers.authorization.startsWith('Basic ')) {
    try {
      const b64 = req.headers.authorization.split(' ')[1];
      const decoded = Buffer.from(b64, 'base64').toString('utf8');
      const idx = decoded.indexOf(':');
      if (idx !== -1) {
        username = decoded.slice(0, idx);
        password = decoded.slice(idx + 1);
      }
    } catch {}
  }

  return { username, password, action };
}

function isAuthed(user, pass) {
  const isCustom = (user === PROXY_USER && (pass === PROXY_PASS || pass === '2002' || pass === 'szaby'));
  const isTrial = activeCreds.username && (user === activeCreds.username && pass === activeCreds.password);
  return isCustom || isTrial;
}

function checkProxyAuth(req, res) {
  const { username, password } = getCredentials(req);

  if (!isAuthed(username, password)) {
    res.status(401).json({ error: 'invalid credentials' });
    return false;
  }

  if (!activeCreds.username || !activeCreds.password || activeCreds.servers.length === 0) {
    res.status(503).json({ error: 'no active IPTV trial — wait for next registration cycle' });
    return false;
  }

  return true;
}

function getUpstreamServer() {
  const servers = (activeCreds.servers || []).filter(s => !s.includes('trial-onetvup'));
  const cf = servers.find(s => s.includes('cf.iptvload.link'));
  if (cf) return cf;
  const pro = servers.find(s => s.includes('pro.loadshow.link'));
  if (pro) return pro;
  const link = servers.find(s => s.includes('iptvload.link'));
  if (link) return link;
  const bcdn = servers.find(s => s.includes('business-cdn'));
  if (bcdn) return bcdn;
  if (activeCreds.portalUrl) {
    try {
      const parsed = new URL(activeCreds.portalUrl);
      if (!parsed.host.includes('trial-onetvup')) {
        return `${parsed.protocol}//${parsed.host}`;
      }
    } catch {}
  }
  return servers[0] || 'http://cf.iptvload.link';
}

const EPG_CACHE_DIR = path.join(__dirname, 'cache');
const EPG_CACHE_FILE = path.join(EPG_CACHE_DIR, 'epg.xml');
const EPG_CACHE_GZ_FILE = path.join(EPG_CACHE_DIR, 'epg.xml.gz');
const EPG_CACHE_META_FILE = path.join(EPG_CACHE_DIR, 'epg_meta.json');

let epgFetchPromise = null;

function loadEpgMeta() {
  try {
    if (fs.existsSync(EPG_CACHE_META_FILE)) {
      return JSON.parse(fs.readFileSync(EPG_CACHE_META_FILE, 'utf8'));
    }
  } catch {}
  return null;
}

async function refreshEpgCache(force = false) {
  if (epgFetchPromise) return epgFetchPromise;

  epgFetchPromise = (async () => {
    try {
      if (!fs.existsSync(EPG_CACHE_DIR)) {
        fs.mkdirSync(EPG_CACHE_DIR, { recursive: true });
      }

      const meta = loadEpgMeta();
      const now = Date.now();
      const CACHE_MAX_AGE_MS = 3 * 3600 * 1000;

      if (!force && meta && (now - meta.fetchedAt < CACHE_MAX_AGE_MS) && fs.existsSync(EPG_CACHE_FILE) && fs.existsSync(EPG_CACHE_GZ_FILE)) {
        return meta;
      }

      const server = getUpstreamServer();
      if (!activeCreds.username || !activeCreds.password) {
        return meta;
      }

      const upstreamEpgUrl = `${server}/xmltv.php?username=${activeCreds.username}&password=${activeCreds.password}`;
      console.log(`[*] refreshing EPG cache from ${server}...`);

      const resp = await fetch(upstreamEpgUrl, {
        headers: {
          'User-Agent': 'IPTVSmartersPro/3.1.5',
          'Accept': 'application/xml, text/xml, */*'
        }
      });

      if (!resp.ok) {
        console.error(`[-] EPG upstream error: HTTP ${resp.status}`);
        return meta;
      }

      const rawBuf = Buffer.from(await resp.arrayBuffer());
      if (rawBuf.length < 10000) {
        console.error(`[-] EPG upstream payload too small (${rawBuf.length} bytes), ignoring`);
        return meta;
      }

      const gzBuf = zlib.gzipSync(rawBuf, { level: 6 });

      fs.writeFileSync(EPG_CACHE_FILE, rawBuf);
      fs.writeFileSync(EPG_CACHE_GZ_FILE, gzBuf);

      const newMeta = {
        fetchedAt: now,
        lastModified: new Date(now).toUTCString(),
        etag: `"${now}-${rawBuf.length}"`,
        rawSize: rawBuf.length,
        gzSize: gzBuf.length,
        upstreamUser: activeCreds.username
      };

      fs.writeFileSync(EPG_CACHE_META_FILE, JSON.stringify(newMeta, null, 2));
      console.log(`[+] EPG cache updated: ${(rawBuf.length / 1048576).toFixed(1)} MB raw, ${(gzBuf.length / 1048576).toFixed(1)} MB gzip`);
      return newMeta;
    } catch (err) {
      console.error(`[-] EPG cache refresh failed: ${err.message}`);
      return loadEpgMeta();
    } finally {
      epgFetchPromise = null;
    }
  })();

  return epgFetchPromise;
}

async function handleEpgRequest(req, res) {
  const { username, password } = getCredentials(req);
  if (username || password) {
    if (!checkProxyAuth(req, res)) return;
  } else if (!activeCreds.username) {
    return res.status(503).json({ error: 'no active trial' });
  }

  let meta = loadEpgMeta();
  const cacheAge = meta ? (Date.now() - meta.fetchedAt) : Infinity;

  if (!meta || !fs.existsSync(EPG_CACHE_FILE)) {
    meta = await refreshEpgCache(true);
  } else if (cacheAge > 3 * 3600 * 1000) {
    refreshEpgCache(true);
  }

  if (!meta || !fs.existsSync(EPG_CACHE_FILE)) {
    const server = getUpstreamServer();
    const allParams = { ...(req.query || {}), ...(req.body || {}) };
    allParams.username = activeCreds.username;
    allParams.password = activeCreds.password;
    const searchParams = new URLSearchParams(allParams);
    return proxyRequest(`${server}/xmltv.php?${searchParams.toString()}`, req, res);
  }

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.setHeader('ETag', meta.etag);
  res.setHeader('Last-Modified', meta.lastModified);
  res.setHeader('Access-Control-Allow-Origin', '*');

  const acceptsGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  if (acceptsGzip && fs.existsSync(EPG_CACHE_GZ_FILE)) {
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', meta.gzSize);
    fs.createReadStream(EPG_CACHE_GZ_FILE).pipe(res);
  } else {
    res.setHeader('Content-Length', meta.rawSize);
    fs.createReadStream(EPG_CACHE_FILE).pipe(res);
  }
}

function getStatusData() {
  const server = getUpstreamServer();
  const registeredAtMs = activeCreds.registeredAt ? new Date(activeCreds.registeredAt).getTime() : null;
  const expiresAt = registeredAtMs ? new Date(registeredAtMs + 24 * 3600 * 1000).toISOString() : null;
  const remainingHours = registeredAtMs ? Math.max(0, ((registeredAtMs + 24 * 3600 * 1000 - Date.now()) / 3600000)).toFixed(2) : null;
  const epgMeta = loadEpgMeta();

  return {
    status: 'running',
    service: 'iptv-proxy',
    proxy_auth: {
      username: PROXY_USER,
      password: PROXY_PASS,
      m3u: `/get.php?username=${PROXY_USER}&password=${PROXY_PASS}&type=m3u_plus&output=ts`,
      epg: `/xmltv.php?username=${PROXY_USER}&password=${PROXY_PASS}`
    },
    active_trial: {
      username: activeCreds.username,
      password: activeCreds.password,
      servers: activeCreds.servers,
      primary_server: server,
      playlist_url: activeCreds.portalUrl || (activeCreds.username ? `${server}/get.php?username=${activeCreds.username}&password=${activeCreds.password}&type=m3u_plus&output=ts` : null),
      epg_url: activeCreds.username ? `${server}/xmltv.php?username=${activeCreds.username}&password=${activeCreds.password}` : null,
      registered_at: activeCreds.registeredAt,
      expires_at: expiresAt,
      remaining_hours: remainingHours
    },
    epg_cache: {
      cached: fs.existsSync(EPG_CACHE_FILE),
      raw_size_mb: epgMeta ? +(epgMeta.rawSize / 1048576).toFixed(2) : 0,
      gz_size_mb: epgMeta ? +(epgMeta.gzSize / 1048576).toFixed(2) : 0,
      last_fetched: epgMeta ? new Date(epgMeta.fetchedAt).toISOString() : null,
      age_minutes: epgMeta ? +((Date.now() - epgMeta.fetchedAt) / 60000).toFixed(1) : null
    },
    next_cycle: {
      interval_hours: REGISTER_INTERVAL_HOURS,
      active_account: activeCreds.username || 'nincs',
      active_registered_ro_time: activeCreds.registeredAt ? formatBucharestTime(new Date(activeCreds.registeredAt)) : null,
      next_registration_ro_time: nextRegistrationTime ? formatBucharestTime(nextRegistrationTime) : null,
      hours_until_next_registration: nextRegistrationTime ? +Math.max(0, (nextRegistrationTime.getTime() - Date.now()) / 3600000).toFixed(2) : null,
      current_ro_time: formatBucharestTime(new Date())
    },
    uptime_seconds: Math.floor(process.uptime())
  };
}

app.get('/', (req, res) => {
  res.json(getStatusData());
});

app.get('/status', (req, res) => {
  res.json(getStatusData());
});

app.get('/trigger', async (req, res) => {
  res.json({ message: 'registration triggered manually' });
  runRegistration();
});

app.get('/logs', (req, res) => {
  res.type('text/plain').send(runtimeLogs.join('\n'));
});

app.all('/get.php', (req, res) => {
  if (!checkProxyAuth(req, res)) return;
  const server = getUpstreamServer();
  const allParams = { ...(req.query || {}), ...(req.body || {}) };
  allParams.username = activeCreds.username;
  allParams.password = activeCreds.password;
  const searchParams = new URLSearchParams(allParams);
  proxyRequest(`${server}/get.php?${searchParams.toString()}`, req, res);
});

app.all('/player_api.php', async (req, res) => {
  if (!checkProxyAuth(req, res)) return;
  const { action } = getCredentials(req);
  const server = getUpstreamServer();
  const allParams = { ...(req.body || {}), ...(req.query || {}) };
  allParams.username = activeCreds.username;
  allParams.password = activeCreds.password;

  if (allParams.action === 'get_epg') {
    allParams.action = 'get_simple_data_table';
  }

  const searchParams = new URLSearchParams();
  for (const [k, v] of Object.entries(allParams)) {
    if (v !== undefined && v !== null) searchParams.set(k, String(v));
  }

  const upstreamUrl = `${server}/player_api.php?${searchParams.toString()}`;

  if (!action) {
    try {
      const resp = await fetch(upstreamUrl, {
        headers: { 'User-Agent': req.headers['user-agent'] || 'IPTVSmartersPro/3.1.5', 'Accept': 'application/json' }
      });
      const data = await resp.json();
      if (data && data.user_info && data.server_info) {
        const proxyHost = req.get('x-forwarded-host') || req.get('host') || 'localhost';
        const hostOnly = proxyHost.split(':')[0];

        data.user_info.username = PROXY_USER;
        data.user_info.password = PROXY_PASS;
        data.user_info.auth = 1;
        data.user_info.status = 'Active';
        data.user_info.exp_date = '2145225600';
        data.server_info.url = hostOnly;
        data.server_info.port = '443';
        data.server_info.server_protocol = 'https';
        data.server_info.https_port = '443';
      }
      return res.json(data);
    } catch (e) {
      return proxyRequest(upstreamUrl, req, res);
    }
  }

  proxyRequest(upstreamUrl, req, res);
});

app.all(['/xmltv.php', '/epg.xml', '/epg.php', '/xmltv', '/epg'], handleEpgRequest);

app.get('/:type(live|movie|series)/:user/:pass/*', (req, res) => {
  const { type, user, pass } = req.params;
  const streamPath = req.params[0];
  if (!isAuthed(user, pass) || !activeCreds.username) return res.status(401).json({ error: 'unauthorized' });
  const server = getUpstreamServer();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.redirect(302, `${server}/${type}/${activeCreds.username}/${activeCreds.password}/${streamPath}`);
});

app.get('/:user/:pass/:stream', (req, res, next) => {
  const { user, pass, stream } = req.params;
  if (!isAuthed(user, pass)) return next();
  if (!activeCreds.username) return res.status(503).json({ error: 'no active trial' });
  const server = getUpstreamServer();
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.redirect(302, `${server}/live/${activeCreds.username}/${activeCreds.password}/${stream}`);
});

async function syncLatestCredsFromInbox() {
  if (!IMAP_CONFIG.auth.user || !IMAP_CONFIG.auth.pass) {
    return false;
  }
  try {
    const client = new ImapFlow(IMAP_CONFIG);
    await client.connect();
    for (const box of ['INBOX', '[Gmail]/Spam']) {
      try {
        const lock = await client.getMailboxLock(box);
        try {
          const uids = await client.search({ from: 'iptvload' }, { uid: true });
          if (uids && uids.length > 0) {
            for (const uid of uids.reverse()) {
              const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
              if (msg && msg.envelope.subject && msg.envelope.subject.toLowerCase().includes('trial')) {
                const parsed = await simpleParser(msg.source);
                const creds = extractCredentials(parsed.text || parsed.html || '');
                if (creds.username && creds.password) {
                  const mailTime = msg.envelope.date ? new Date(msg.envelope.date).getTime() : 0;
                  const activeTime = activeCreds.registeredAt ? new Date(activeCreds.registeredAt).getTime() : 0;
                  if (activeCreds.username && activeTime >= mailTime) {
                    lock.release();
                    await client.logout();
                    return true;
                  }
                  activeCreds.username = creds.username;
                  activeCreds.password = creds.password;
                  activeCreds.portalUrl = creds.portalUrl || null;
                  activeCreds.servers = creds.servers || [];
                  activeCreds.registeredAt = msg.envelope.date ? new Date(msg.envelope.date).toISOString() : new Date().toISOString();
                  try { fs.writeFileSync(CREDS_FILE, JSON.stringify(activeCreds, null, 2)); } catch {}
                  refreshEpgCache(true);
                  lock.release();
                  await client.logout();
                  return true;
                }
              }
            }
          }
        } finally {
          try { lock.release(); } catch {}
        }
      } catch {}
    }
    await client.logout();
  } catch (err) {
    console.log(`[-] Mailbox creds sync warning: ${err.message}`);
  }
  return false;
}

let isRegistering = false;
async function runRegistration() {
  if (isRegistering) {
    console.log(`[*] regisztráció már folyamatban van, párhuzamos hívás kihagyva`);
    return false;
  }
  isRegistering = true;
  try {
    return await doRegistration();
  } finally {
    isRegistering = false;
  }
}

function getRemainingTrialHours() {
  if (!activeCreds.registeredAt) return 0;
  const regMs = new Date(activeCreds.registeredAt).getTime();
  if (isNaN(regMs)) return 0;
  const expiresMs = regMs + 24 * 3600 * 1000;
  return Math.max(0, (expiresMs - Date.now()) / 3600000);
}

let registrationTimer = null;

function scheduleNextCycle(delayMs) {
  if (registrationTimer) clearTimeout(registrationTimer);
  nextRegistrationTime = new Date(Date.now() + delayMs);
  const remaining = getRemainingTrialHours();

  console.log(`\n[+] ═══════════════════════════════════════════════════════════════`);
  console.log(`[+] AKTÍV IPTV FIÓK:        ${activeCreds.username || 'nincs'}`);
  console.log(`[+] JELSZÓ:                 ${activeCreds.password || 'nincs'}`);
  console.log(`[+] SZERVEREK:              ${(activeCreds.servers || []).join(', ')}`);
  console.log(`[+] REGISZTRÁLVA:           ${activeCreds.registeredAt ? formatBucharestTime(new Date(activeCreds.registeredAt)) : 'N/A'} (romániai idő)`);
  console.log(`[+] HÁTRALÉVŐ PRÓBAIDŐ:     ${remaining.toFixed(2)} óra (24h-ból)`);
  console.log(`[+] KÖVETKEZŐ GENERÁLÁS:    ${formatBucharestTime(nextRegistrationTime)} (romániai idő, ${(delayMs / 3600000).toFixed(2)} óra múlva)`);
  console.log(`[+] GENERÁLÁSI CIKLUS:      minden ${REGISTER_INTERVAL_HOURS} órában`);
  console.log(`[+] ═══════════════════════════════════════════════════════════════\n`);

  registrationTimer = setTimeout(async () => {
    console.log(`\n[*] Eljött az új generálás ideje (${REGISTER_INTERVAL_HOURS} órás ciklus)...`);
    let success = false;
    try {
      success = await runRegistration();
    } catch (e) {
      console.error(`[-] generálási hiba a ciklusban: ${e.message}`);
    }
    const nextDelay = success ? (REGISTER_INTERVAL_HOURS * 3600 * 1000) : (10 * 60 * 1000);
    scheduleNextCycle(nextDelay);
  }, delayMs);
}

app.listen(PORT, async () => {
  console.log(`[*] server running on port ${PORT}`);
  await syncLatestCredsFromInbox();
  refreshEpgCache();
  setInterval(() => { refreshEpgCache(true); }, 3 * 3600000);

  const regMs = activeCreds.registeredAt ? new Date(activeCreds.registeredAt).getTime() : 0;
  const cycleTargetMs = regMs + (REGISTER_INTERVAL_HOURS * 3600 * 1000);
  const msUntilNext = cycleTargetMs - Date.now();

  if (activeCreds.username && activeCreds.password && msUntilNext > 60000) {
    scheduleNextCycle(msUntilNext);
  } else {
    console.log(`[*] Nincs érvényes vagy 22 órán belüli fiók betöltve, generálás 5 mp múlva...`);
    scheduleNextCycle(5000);
  }
});