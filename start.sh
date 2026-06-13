#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js 18 or newer is required."
  echo "Install it from https://nodejs.org, then run this script again."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm was not found. Reinstall Node.js from https://nodejs.org."
  exit 1
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js 18 or newer is required. Found: $(node -v)"
  exit 1
fi

if [ "${1:-}" = "--clean" ] || [ "${1:-}" = "--fresh" ]; then
  echo "Removing installed dependencies and build output..."
  rm -rf node_modules client/node_modules server/node_modules dist client/dist
  shift
fi

echo "Starting the development server..."
npm run dev "$@"
