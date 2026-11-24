/**
 * selfbot-vc — backend server
 * Run in Termux: node server.js
 * Install deps: npm install
 */

const djs = require('discord.js-selfbot-v13');
const { Client } = djs;
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { spawn } = require('child_process');
const util = require('util');

/* ── audio kit: prefer the library's own voice re-exports, fall back to @discordjs/voice ── */
function loadVoiceKit() {
  const candidates = [djs];
  try { candidates.push(require('@discordjs/voice')); } catch {}
  for (const c of candidates) {
    if (c && typeof c.createAudioPlayer === 'function' &&
        typeof c.createAudioResource === 'function') return c;
  }
  throw new Error('audio kit missing — run: npm install @discordjs/voice');
}
const voiceKit = loadVoiceKit();
const {
  createAudioPlayer, createAudioResource,
  AudioPlayerStatus, StreamType, NoSubscriberBehavior,
} = voiceKit;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const WWW = path.join(__dirname, 'app/src/main/assets/www');

app.use(express.json());
// serve the UI from the asset folder so WebView edits show up without an APK rebuild
app.use(express.static(WWW));

let client = null;
let currentChannelId = null;
let isMuted = false;
let isDeafened = false;
let startedAt = null;

/* playback */
let player = null;
let resource = null;
let currentTrack = null;
let liveVolume = 2.0;
let ffmpegProc = null;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(msg); });
}

function log(text, level = 'info') {
  console.log(`[${level.toUpperCase()}] ${text}`);
  broadcast('log', { text, level });
}

function statePayload(extra = {}) {
  return {
    connected: !!(client && client.isReady()),
    inVC: !!currentChannelId,
    channelId: currentChannelId,
    muted: isMuted,
    deafened: isDeafened,
    username: client?.user?.tag || null,
    ping: client?.ws?.ping ?? null,
    guilds: client?.guilds?.cache?.size ?? 0,
    uptime: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
    playing: !!player && player.state.status !== 'idle',
    track: currentTrack,
    volume: liveVolume,
    ...extra,
  };
}

function pushState(extra) {
  if (client?.isReady()) broadcast('state', statePayload(extra));
}

/* ── raw REST helper (for onboarding endpoints the library doesn't expose) ── */
async function discordFetch(method, endpoint, body) {
  const res = await fetch(`https://discord.com/api/v10${endpoint}`, {
    method,
    headers: {
      'authorization': client.token,
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'x-discord-locale': 'en-US',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const detail = typeof data === 'object' && data?.message ? data.message : String(text).slice(0, 180);
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return data;
}

/* ── websocket ───────────────────────────────────────── */

wss.on('connection', socket => {
  log('UI connected', 'info');

  socket.send(JSON.stringify({ type: 'state', ...statePayload() }));

  socket.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    try {
      switch (msg.action) {
        case 'connect':    await connectBot(msg.token); break;
        case 'disconnect': await disconnectBot(); break;
        case 'join':       await joinVC(msg.channelId); break;
        case 'leave':      await leaveVC(); break;
        case 'rejoin':     await rejoinVC(); break;
        case 'move':       await moveVC(msg.channelId); break;
        case 'mute':       await setMute(msg.value); break;
        case 'deafen':     await setDeafen(msg.value); break;

        case 'play':
          playAudio(msg).catch(e => log(`Play failed: ${e.message}`, 'error'));
          break;
        case 'stopaudio':
          stopPlayback();
          log('Playback stopped', 'info');
          pushState();
          break;
        case 'volume':
          setLiveVolume(msg.value);
          break;

        case 'joinguild':
          joinGuild(msg.invite).catch(e => log(`Join failed: ${e.message}`, 'error'));
          break;

        case 'spam':
          spamChannel(msg.channelId, msg.message, msg.count, msg.delay)
            .catch(e => log(`Spam failed: ${e.message}`, 'error'));
          break;
        case 'dmspam':
          dmSpam(msg.userIds, msg.message, msg.count, msg.delay)
            .catch(e => log(`DM spam failed: ${e.message}`, 'error'));
          break;

        case 'eval': {
          if (!client?.isReady()) { log('Not connected', 'error'); break; }
          try {
            const out = await runEval(msg.code || '');
            broadcast('eval', { ok: true, out });
          } catch (e) {
            broadcast('eval', { ok: false, out: `${e.name}: ${e.message}` });
          }
          break;
        }

        default:
          log(`Unknown action: ${msg.action}`, 'warn');
      }
    } catch (err) {
      log(`${msg.action} failed: ${err.message}`, 'error');
    }
  });
});

/* ── bot lifecycle ───────────────────────────────────── */

async function connectBot(token) {
  if (client) await disconnectBot();
  client = new Client({ checkUpdate: false });

  client.on('ready', () => {
    startedAt = Date.now();
    log(`Logged in as ${client.user.tag}`, 'ok');
    broadcast('state', statePayload());
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    if (!client.user || oldState.member?.id !== client.user.id) return;
    if (newState.channelId) {
      currentChannelId = newState.channelId;
      broadcast('state', statePayload());
    } else {
      currentChannelId = null;
      broadcast('state', statePayload());
    }
  });

  client.on('error', err => log(`Client error: ${err.message}`, 'error'));

  try {
    await client.login(token);
  } catch (err) {
    log(`Login failed: ${err.message}`, 'error');
    client = null;
    broadcast('state', { connected: false });
  }
}

async function disconnectBot() {
  if (!client) return;
  try {
    stopPlayback();
    if (currentChannelId) await leaveVC();
    client.destroy();
  } catch {}
  client = null;
  currentChannelId = null;
  isMuted = false;
  isDeafened = false;
  startedAt = null;
  log('Disconnected', 'info');
  broadcast('state', statePayload({ connected: false, inVC: false, channelId: null }));
}

/* ── voice channel ───────────────────────────────────── */

async function joinVC(channelId) {
  if (!client?.isReady()) { log('Not connected', 'error'); return; }
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isVoice()) {
      log(`Channel ${channelId} not found or not a voice channel`, 'error');
      return;
    }
    await channel.join({ selfMute: isMuted, selfDeaf: isDeafened });
    currentChannelId = channelId;
    log(`Joined ${channel.name} (${channelId})`, 'ok');
    pushState();
  } catch (err) {
    log(`Join failed: ${err.message}`, 'error');
  }
}

async function leaveVC() {
  if (!client?.isReady()) { log('Not connected', 'error'); return; }
  try {
    stopPlayback();
    const vc = client.voice?.connection;
    if (vc) vc.disconnect();
    else {
      client.guilds.cache.forEach(g => {
        const member = g.members.cache.get(client.user.id);
        if (member?.voice?.channelId) member.voice.disconnect();
      });
    }
    currentChannelId = null;
    log('Left voice channel', 'info');
    pushState();
  } catch (err) {
    log(`Leave failed: ${err.message}`, 'error');
  }
}

async function rejoinVC() {
  if (!currentChannelId) { log('Not in a VC', 'error'); return; }
  const ch = currentChannelId;
  await leaveVC();
  setTimeout(() => joinVC(ch), 800);
}

async function moveVC(channelId) {
  if (!client?.isReady()) { log('Not connected', 'error'); return; }
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isVoice()) { log('Channel not found or not voice', 'error'); return; }
    await channel.join({ selfMute: isMuted, selfDeaf: isDeafened });
    currentChannelId = channelId;
    log(`Moved to ${channel.name} (${channelId})`, 'ok');
    pushState();
  } catch (err) {
    log(`Move failed: ${err.message}`, 'error');
  }
}

async function setMute(value) {
  isMuted = value;
  if (client?.isReady()) {
    try {
      client.guilds.cache.forEach(g => {
        const member = g.members.cache.get(client.user.id);
        if (member?.voice?.channelId) member.voice.setSelfMute(isMuted);
      });
    } catch {}
  }
  log(isMuted ? 'Microphone muted' : 'Microphone unmuted', isMuted ? 'warn' : 'ok');
  pushState();
}

async function setDeafen(value) {
  isDeafened = value;
  if (client?.isReady()) {
    try {
      client.guilds.cache.forEach(g => {
        const member = g.members.cache.get(client.user.id);
        if (member?.voice?.channelId) member.voice.setSelfDeaf(isDeafened);
      });
    } catch {}
  }
  log(isDeafened ? 'Deafened' : 'Undeafened', isDeafened ? 'warn' : 'ok');
  pushState();
}

/* ── playback ────────────────────────────────────────── */

function clampVolume(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 2.0;
  return Math.min(8, Math.max(0.1, n));
}

function stopPlayback() {
  try { if (player) { player.stop(true); } } catch {}
  player = null;
  resource = null;
  currentTrack = null;
  try { if (ffmpegProc) { ffmpegProc.kill('SIGKILL'); } } catch {}
  ffmpegProc = null;
}

async function playAudio({ source, volume, channelId }) {
  if (!client?.isReady()) throw new Error('not logged in');
  if (!source) throw new Error('no source given');

  if (!currentChannelId) {
    if (!channelId) throw new Error('join a voice channel first, or supply a channel ID');
    await joinVC(channelId);
    if (!currentChannelId) throw new Error('could not join voice channel');
  }

  const conn = client.voice?.connection;
  if (!conn) throw new Error('no voice connection');

  stopPlayback();
  liveVolume = clampVolume(volume);

  const isUrl = /^https?:\/\//i.test(source);
  const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';

  const args = ['-nostdin', '-loglevel', 'error'];
  if (isUrl) {
    args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
  }
  args.push(
    '-i', source,
    '-vn',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    'pipe:1'
  );

  ffmpegProc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  ffmpegProc.on('error', err => {
    if (err.code === 'ENOENT') {
      log('ffmpeg not found — run: pkg install ffmpeg', 'error');
    } else {
      log(`ffmpeg: ${err.message}`, 'error');
    }
    stopPlayback();
    pushState();
  });

  let errBuf = '';
  ffmpegProc.stderr.on('data', d => {
    errBuf = (errBuf + d.toString()).slice(-400);
  });
  ffmpegProc.on('exit', code => {
    if (code && code !== 0 && code !== null) log(`ffmpeg exited ${code}: ${errBuf.trim()}`, 'warn');
  });

  const thisPlayer = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });

  resource = createAudioResource(ffmpegProc.stdout, {
    inputType: StreamType.Raw,
    inlineVolume: true,
  });
  if (resource.volume) resource.volume.setVolume(liveVolume);

  player = thisPlayer;
  currentTrack = source;
  thisPlayer.play(resource);
  conn.subscribe(thisPlayer);

  thisPlayer.on(AudioPlayerStatus.Idle, () => {
    if (player !== thisPlayer) return; // superseded by a newer track
    player = null;
    resource = null;
    currentTrack = null;
    try { if (ffmpegProc) ffmpegProc.kill('SIGKILL'); } catch {}
    ffmpegProc = null;
    log('Playback finished', 'info');
    pushState();
  });

  thisPlayer.on('error', err => log(`Player error: ${err.message}`, 'error'));

  log(`Playing ${source} at gain ${liveVolume}`, 'ok');
  pushState();
}

function setLiveVolume(value) {
  liveVolume = clampVolume(value);
  if (resource?.volume) resource.volume.setVolume(liveVolume);
  log(`Volume set to ${liveVolume}`, 'info');
  pushState();
}

/* ── guild join + onboarding bypass ──────────────────── */

async function joinGuild(invite) {
  if (!client?.isReady()) throw new Error('not logged in');

  const code = String(invite).trim()
    .replace(/^https?:\/\/(www\.)?discord\.(gg|com\/invite)\//i, '')
    .split(/[?#]/)[0];

  let inv = null;
  try { inv = await client.fetchInvite(code); } catch (e) {
    throw new Error(`invalid or expired invite (${e.message})`);
  }
  const guildId = inv.guild?.id || null;

  if (typeof client.acceptInvite !== 'function') {
    throw new Error('client.acceptInvite missing — update discord.js-selfbot-v13');
  }
  await client.acceptInvite(code);
  log(`Joined ${inv.guild?.name || guildId}`, 'ok');
  pushState();

  if (guildId) {
    await sleep(1500);
    await completeOnboarding(guildId).catch(e => log(`Onboarding: ${e.message}`, 'warn'));
  }
  return guildId;
}

async function completeOnboarding(guildId) {
  let did = 0;
  did += await submitMemberVerification(guildId);
  did += await submitOnboardingPrompts(guildId);
  if (did === 0) log(`Guild ${guildId}: no screening/onboarding to bypass`, 'info');
}

async function submitMemberVerification(guildId) {
  let data;
  try {
    data = await discordFetch('GET', `/guilds/${guildId}/member-verification`);
  } catch {
    return 0; // guild has no screening
  }
  const fields = data?.form_fields || [];
  if (!fields.length) return 0;

  const answers = [];
  for (const f of fields) {
    const type = f.field_type;
    if (type === 'TERMS') {
      answers.push({ field_type: type, values: ['TERMS'] });
    } else if (type === 'MULTIPLE_CHOICE') {
      const choices = f.field_options?.choices || [];
      const pick = choices[0];
      const value = pick?.value ?? pick?.label;
      if (value) answers.push({ field_type: type, values: [value] });
    } else if (type === 'TEXT_INPUT') {
      answers.push({ field_type: type, values: ['ok'] });
    }
  }
  if (!answers.length) return 0;

  try {
    await discordFetch('PUT', `/guilds/${guildId}/requests/@me`, { form_fields: answers });
    log(`Guild ${guildId}: member screening submitted (${answers.length} fields)`, 'ok');
    return 1;
  } catch (e) {
    log(`Guild ${guildId}: screening rejected — ${e.message}`, 'warn');
    return 0;
  }
}

async function submitOnboardingPrompts(guildId) {
  let data;
  try {
    data = await discordFetch('GET', `/guilds/${guildId}/onboarding`);
  } catch {
    return 0; // guild has no onboarding
  }
  const prompts = data?.prompts || [];
  if (!prompts.length) return 0;

  const responses = [];
  for (const p of prompts) {
    const opts = p.options || [];
    if (!opts.length) continue;
    responses.push({ prompt: String(p.id), options: [String(opts[0].id)] });
  }
  if (!responses.length) return 0;

  try {
    await discordFetch('PUT', `/guilds/${guildId}/onboarding`, { onboarding_responses: responses });
    log(`Guild ${guildId}: onboarding submitted (${responses.length} prompts)`, 'ok');
    return 1;
  } catch (e) {
    log(`Guild ${guildId}: onboarding rejected — ${e.message}`, 'warn');
    return 0;
  }
}

/* ── spam ────────────────────────────────────────────── */

async function spamChannel(channelId, message, count = 10, delay = 0.5) {
  if (!client?.isReady()) throw new Error('not logged in');
  if (!channelId || !message) throw new Error('channel ID and message required');

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isText?.()) throw new Error('channel is not text');

  const total = Math.max(1, parseInt(count) || 1);
  const gap = Math.max(0, Number(delay) || 0) * 1000;

  let sent = 0;
  for (let i = 0; i < total; i++) {
    try {
      await channel.send(message);
      sent++;
    } catch (e) {
      log(`Spam send failed (${e.message}) — backing off`, 'warn');
      await sleep(2000);
    }
    if (i < total - 1) await sleep(gap);
  }
  log(`Spam done: ${sent}/${total} sent to ${channelId}`, 'ok');
  return sent;
}

async function dmSpam(userIds, message, count = 5, delay = 1.0) {
  if (!client?.isReady()) throw new Error('not logged in');
  const ids = (userIds || []).map(String).map(s => s.trim()).filter(Boolean);
  if (!ids.length || !message) throw new Error('user IDs and message required');

  const per = Math.max(1, parseInt(count) || 1);
  const gap = Math.max(0, Number(delay) || 0) * 1000;

  let sent = 0;
  for (const id of ids) {
    try {
      const user = await client.users.fetch(id);
      const dm = user.dmChannel || await user.createDM();
      for (let i = 0; i < per; i++) {
        await dm.send(message);
        sent++;
        await sleep(gap);
      }
      log(`DM spam: ${per}x → ${user.tag || id}`, 'info');
    } catch (e) {
      log(`DM spam: ${id} failed (${e.message})`, 'warn');
      await sleep(1500);
    }
  }
  log(`DM spam done: ${sent} messages across ${ids.length} user(s)`, 'ok');
  return sent;
}

/* ── console ─────────────────────────────────────────── */

async function runEval(code) {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('client', 'discord', 'require', code);
  const result = await fn(client, djs, require);
  return util.inspect(result, { depth: 2, breakLength: 100 });
}

/* ── server ──────────────────────────────────────────── */

// keep ping/uptime/now-playing live in the UI
setInterval(() => {
  if (client?.isReady()) broadcast('state', statePayload());
}, 3000);

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n selfbot-vc server running`);
  console.log(` http://localhost:${PORT}`);
  console.log(` audio kit: ${voiceKit === djs ? 'library re-exports' : '@discordjs/voice'}`);
  console.log(` ffmpeg: ${process.env.FFMPEG_PATH || 'ffmpeg (PATH)'}\n`);
});
