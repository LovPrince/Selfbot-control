# Selfbot VC — Android App

Voice channel controller for Discord selfbots. Built as a native Android WebView app.

> ⚠️ Selfbots violate Discord's Terms of Service. Use at your own risk.

---

## How it works

The app has two parts:

1. **Android APK** — WebView app you install on your phone. Built by GitHub Actions automatically when you push.
2. **Node.js server** (`server.js`) — runs in Termux on your phone, connects to Discord's gateway.

The app connects to the server over WebSocket on `localhost:3000`.

---

## Step 1 — Push to GitHub (Termux)

```bash
# Install git
pkg install git

# Configure git
git config --global user.email "you@example.com"
git config --global user.name "Your Name"

# Go into the project folder
cd selfbot-vc-app

# Init and push
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOURUSERNAME/selfbot-vc.git
git push -u origin main
```

Create the repo first at https://github.com/new (name it `selfbot-vc`, make it private).

---

## Step 2 — Download the APK

1. Go to your repo on GitHub
2. Click **Actions** tab
3. Wait for the build to finish (~3-5 minutes)
4. Click the latest run → scroll down to **Artifacts**
5. Download **selfbot-vc-debug**
6. Unzip it and install `app-debug.apk` on your phone

> Enable "Install from unknown sources" in Android Settings → Security if needed.

---

## Step 3 — Run the server in Termux

```bash
# Install Node.js
pkg install nodejs

# Go to your project
cd selfbot-vc-app

# Install dependencies
npm install

# Start the server
node server.js
```

Keep Termux open (or use a wake lock app to prevent it from being killed).

---

## Step 4 — Use the app

1. Open the **Selfbot VC** app
2. Tap **Connect** (connects to `ws://localhost:3000`)
3. Paste your Discord user token → tap **Login**
4. Enter a voice channel ID → tap **Join VC**

---

## Getting your Discord token

1. Open `discord.com` in a **desktop browser** (Chrome/Firefox)
2. Press **F12** → go to **Console** tab
3. Paste this and press Enter:

```js
webpackChunkdiscord_app.push([[''],{},e=>{m=[];for(let c in e.c)m.push(e.c[c])}]);m.filter(m=>m?.exports?.default?.getToken).map(m=>m.exports.default.getToken())[0]
```

4. Copy the token string that appears.

---

## Getting a channel ID

1. In Discord, go to **User Settings → Advanced → Enable Developer Mode**
2. Right-click any voice channel → **Copy Channel ID**
# Selfbot-control
