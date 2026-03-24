#!/bin/bash
# Talkity Setup Script
set -e

echo ""
echo "  🫧  Setting up Talkity..."
echo ""

# Install Electron app deps
echo "  [1/2] Installing app dependencies (Electron)..."
npm install --prefer-offline 2>&1 | grep -v "^npm warn" | grep -v "^added" || true

# Install server deps
echo "  [2/2] Installing server dependencies..."
cd server && npm install --prefer-offline 2>&1 | grep -v "^npm warn" | grep -v "^added" || true
cd ..

echo ""
echo "  ✅  Done! Here's how to run Talkity:"
echo ""
echo "  OPTION A – One command (runs both server + app):"
echo "    npm run dev"
echo ""
echo "  OPTION B – Separately:"
echo "    Terminal 1:  npm run server    (start the chat server)"
echo "    Terminal 2:  npm start         (launch the desktop app)"
echo ""
echo "  📡 To chat with FRIENDS on the same network:"
echo "    1. Run the server:  npm run server"
echo "    2. Find your IP:    ipconfig (Windows) or ifconfig (Mac/Linux)"
echo "    3. Give friends your IP + port, e.g.:  192.168.1.5:3747"
echo "    4. They enter that address when launching Talkity"
echo ""
echo "  🌐 To chat with friends over the INTERNET:"
echo "    - Deploy server to Railway / Render / Fly.io (all free tier)"
echo "    - Or use ngrok: ngrok http 3747"
echo ""
