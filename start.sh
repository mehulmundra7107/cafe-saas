#!/usr/bin/env bash
set -e

cd "$(dirname "$0")"

echo "============================================"
echo "  CAFE CRAFTED - Starting Server"
echo "============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed."
  echo "Install it from https://nodejs.org and try again."
  echo
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies..."
  npm install
  echo
fi

echo "Server starting at http://localhost:3000"
echo "Admin panel: http://localhost:3000/admin.html"
echo "Admin password: admin123"
echo
echo "Press Ctrl+C to stop the server."
echo "============================================"
echo

sleep 2

if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "http://localhost:3000/" >/dev/null 2>&1 &
  xdg-open "http://localhost:3000/admin.html" >/dev/null 2>&1 &
elif command -v gnome-open >/dev/null 2>&1; then
  gnome-open "http://localhost:3000/" >/dev/null 2>&1 &
  gnome-open "http://localhost:3000/admin.html" >/dev/null 2>&1 &
fi

npm start
