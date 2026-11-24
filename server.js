/**
 * selfbot-vc — backend server
 * Run in Termux: node server.js
 *
 * Install deps first:
 *   npm install discord.js-selfbot-v13 express ws
 */

const { Client } = require('discord.js-selfbot-v13');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static(path.join(__dirname)));

let client = null;
let ws = null;
let currentChannelId = null;
let isMuted = false;
let isDeafened = false;

function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
}

function log(text, level = 'info') {
  console.log(`[${level.toUpperCase()}] ${text}`);
  broadcast('log', { text, level });
}

wss.on('connection', socket => {
  ws = socket;
  log('UI connected', 'info');

  // Send current state on reconnect
  socket.send(JSON.stringify({
    type: 'state',
    connected: client && client.isReady(),
    inVC: !!currentChannelId,
    channelId: currentChannelId,
    muted: isMuted,
    deafened: isDeafened,
    username: client?.user?.tag || null
  }));

  socket.on('message', async raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.action) {
      case 'connect': await connectBot(msg.token); break;
      case 'disconnect': await disconnectBot(); break;
      case 'join': await joinVC(msg.channelId); break;
      case 'leave': await leaveVC(); break;
      case 'rejoin': await rejoinVC(); break;
      case 'move': await moveVC(msg.channelId); break;
      case 'mute': await setMute(msg.value); break;
      case 'deafen': await setDeafen(msg.value); break;
    }
  });
});

async function connectBot(token) {
  if (client) await disconnectBot();

  client = new Client({ checkUpdate: false });

  client.on('ready', () => {
    log(`Logged in as ${client.user.tag}`, 'ok');
    broadcast('state', {
      connected: true,
      inVC: false,
      channelId: null,
      muted: isMuted,
      deafened: isDeafened,
      username: client.user.tag
    });
  });

  client.on('voiceStateUpdate', (oldState, newState) => {
    if (!client.user || oldState.member?.id !== client.user.id) return;
    if (newState.channelId) {
      currentChannelId = newState.channelId;
      broadcast('state', { inVC: true, channelId: currentChannelId });
    } else {
      currentChannelId = null;
      broadcast('state', { inVC: false, channelId: null });
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
    if (currentChannelId) await leaveVC();
    client.destroy();
  } catch {}
  client = null;
  currentChannelId = null;
  isMuted = false;
  isDeafened = false;
  log('Disconnected', 'info');
  broadcast('state', { connected: false, inVC: false, channelId: null, muted: false, deafened: false, username: null });
}

async function joinVC(channelId) {
  if (!client?.isReady()) { log('Not connected', 'error'); return; }
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isVoice()) { log(`Channel ${channelId} not found or not a voice channel`, 'error'); return; }
    await channel.join({ selfMute: isMuted, selfDeaf: isDeafened });
    currentChannelId = channelId;
    log(`Joined ${channel.name} (${channelId})`, 'ok');
    broadcast('state', { inVC: true, channelId });
  } catch (err) {
    log(`Join failed: ${err.message}`, 'error');
  }
}

async function leaveVC() {
  if (!client?.isReady()) { log('Not connected', 'error'); return; }
  try {
    const vc = client.voice?.connection;
    if (vc) vc.disconnect();
    else {
      // Fallback: send voice state update with null channel
      const guilds = client.guilds.cache;
      guilds.forEach(g => {
        const member = g.members.cache.get(client.user.id);
        if (member?.voice?.channelId) member.voice.disconnect();
      });
    }
    currentChannelId = null;
    log('Left voice channel', 'info');
    broadcast('state', { inVC: false, channelId: null });
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
    broadcast('state', { inVC: true, channelId });
  } catch (err) {
    log(`Move failed: ${err.message}`, 'error');
  }
}

async function setMute(value) {
  isMuted = value;
  if (client?.isReady()) {
    try {
      const guilds = client.guilds.cache;
      guilds.forEach(g => {
        const member = g.members.cache.get(client.user.id);
        if (member?.voice?.channelId) member.voice.setSelfMute(isMuted);
      });
    } catch {}
  }
  log(isMuted ? 'Microphone muted' : 'Microphone unmuted', isMuted ? 'warn' : 'ok');
  broadcast('state', { muted: isMuted });
}

async function setDeafen(value) {
  isDeafened = value;
  if (client?.isReady()) {
    try {
      const guilds = client.guilds.cache;
      guilds.forEach(g => {
        const member = g.members.cache.get(client.user.id);
        if (member?.voice?.channelId) member.voice.setSelfDeaf(isDeafened);
      });
    } catch {}
  }
  log(isDeafened ? 'Deafened' : 'Undeafened', isDeafened ? 'warn' : 'ok');
  broadcast('state', { deafened: isDeafened });
}

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔══════════════════════════════════╗`);
  console.log(`║  selfbot-vc server running       ║`);
  console.log(`║  http://localhost:${PORT}            ║`);
  console.log(`╚══════════════════════════════════╝\n`);
});
