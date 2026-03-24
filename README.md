# 🫧 Talkity

A Frutiger Aero real-time messenger built with Electron + Socket.io.

[![GitHub release](https://img.shields.io/github/v/release/YOUR_USERNAME/talkity)](https://github.com/YOUR_USERNAME/talkity/releases)

---

## ✨ Features

- Real-time messaging with typing indicators
- Bold / italic formatting
- Image sharing
- Message reactions, edit & delete
- Nudge system
- Host a server directly from the app (LAN or via ngrok tunnel)
- Auto-updates via GitHub Releases
- Native notifications & taskbar icon states

---

## 🚀 Running in development

```bash
# 1. Install all dependencies
bash setup.sh

# 2. Run server + app together
npm run dev

# OR run separately:
npm run server   # Terminal 1 — starts the chat server on :3747
npm start        # Terminal 2 — launches the Electron app
```

---

## 📦 Building the installer

### Prerequisites

- Node.js 18+
- For Windows `.exe`: run on Windows or use the CI workflow
- For macOS `.dmg`: run on macOS (Apple Silicon or Intel)
- For Linux `.AppImage`: run on Linux or use the CI workflow

### One-time setup

```bash
npm install          # install root deps (electron-builder, etc.)
cd server && npm install && cd ..   # install server deps (bundled into the app)
```

### Build commands

```bash
npm run build:win    # → dist/Talkity Setup 1.0.0.exe
npm run build:mac    # → dist/Talkity-1.0.0.dmg
npm run build:linux  # → dist/Talkity-1.0.0.AppImage
npm run build        # builds for your current platform
```

Output goes to the `dist/` folder.

---

## 🔄 Setting up auto-updates (GitHub Releases)

Auto-updates work via `electron-updater` and GitHub Releases.
Users get a dialog prompt when a new version is available and can install it in one click.

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR_USERNAME/talkity.git
git push -u origin main
```

### Step 2 — Add your GitHub token as a secret

The CI workflow uses `GITHUB_TOKEN` (automatically available) to upload release assets.
No extra secret setup needed for basic usage.

For **private repos**, generate a Personal Access Token with `repo` scope and add it as `GH_TOKEN` in:
`Settings → Secrets and variables → Actions → New repository secret`

### Step 3 — Tag a release

```bash
# Bump version in package.json first, then:
git add package.json
git commit -m "chore: bump version to 1.1.0"
git tag v1.1.0
git push origin main --tags
```

This triggers the GitHub Actions workflow which:
1. Builds `.exe`, `.dmg`, and `.AppImage` in parallel
2. Creates a GitHub Release automatically
3. Uploads all installers as release assets
4. The next time any installed copy of Talkity starts up, it finds the new release and prompts the user to update

### Step 4 — Update `package.json` publish config

Open `package.json` and update the `build.publish` section:

```json
"publish": {
  "provider": "github",
  "owner": "YOUR_GITHUB_USERNAME",
  "repo": "talkity",
  "releaseType": "release"
}
```

---

## 🏗️ Project structure

```
talkity/
├── app/                  ← Electron frontend
│   ├── main.js           ← Main process (window, IPC, server spawn, updater)
│   ├── preload.js        ← Context bridge (exposes APIs to renderer)
│   ├── renderer.js       ← All UI logic
│   ├── index.html
│   ├── style.css
│   ├── icon.png          ← Normal tray/taskbar icon
│   ├── icon_unread.png   ← Unread-state icon
│   ├── icon.ico          ← Windows icon (convert from icon.png)
│   └── icon.icns         ← macOS icon (convert from icon.png)
│
├── server/               ← Chat server (bundled as extraResource)
│   ├── index.js          ← Express + Socket.io server
│   └── package.json
│
├── build/                ← electron-builder assets
│   ├── installer.nsh     ← NSIS hooks (Windows)
│   └── entitlements.mac.plist
│
├── .github/
│   └── workflows/
│       └── release.yml   ← CI: build + publish on git tag
│
├── package.json          ← Root: electron-builder config lives here
├── setup.sh
└── README.md
```

---

## 🎨 Icon files

You need these icon formats for all platforms:

| File | Platform | Size |
|------|----------|------|
| `app/icon.png` | Linux, fallback | 512×512 |
| `app/icon.ico` | Windows | Multi-size ICO |
| `app/icon.icns` | macOS | Multi-size ICNS |

**Quick conversion (macOS):**
```bash
# Install imagemagick first: brew install imagemagick
convert icon.png -define icon:auto-resize=256,128,64,48,32,16 icon.ico
```

**For ICNS (macOS):**
```bash
mkdir icon.iconset
sips -z 512 512 icon.png --out icon.iconset/icon_512x512.png
iconutil -c icns icon.iconset
```

Or use an online converter like [icoconvert.com](https://icoconvert.com).

---

## 🌐 Hosting the server for friends

### LAN (same network)
1. Open the **Host Server** panel in the app sidebar
2. Click **▶ Start Server**
3. Share your LAN address with friends on the same WiFi

### Internet (anyone)
1. Install ngrok: https://ngrok.com/download
2. Log in: `ngrok config add-authtoken YOUR_TOKEN`
3. In the app, switch to **🌐 Internet** mode and start the server
4. Share the ngrok URL with friends anywhere

### Self-hosted (permanent)
Deploy `server/index.js` to any Node.js host:
- [Railway](https://railway.app) — free tier, one-click deploy
- [Render](https://render.com) — free tier
- [Fly.io](https://fly.io) — free tier

---

## 📝 Releasing a new version checklist

1. Update `"version"` in `package.json`
2. Commit: `git commit -am "chore: v1.x.x"`
3. Tag: `git tag v1.x.x`
4. Push: `git push origin main --tags`
5. GitHub Actions builds and publishes automatically
6. Installed copies will auto-update within ~24 hours (or on next launch)
