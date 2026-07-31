#!/usr/bin/env bash
# Server-side deploy step. Called over SSH by the GitHub Actions workflow.
#
# Contract: run from the app directory. Expects PM2 to already be installed
# globally (`npm i -g pm2`) and the app to have been registered at least once
# (`pm2 start ecosystem.config.js`). Subsequent deploys just `git pull` + reload.
#
# Env expected:
#   APP_DIR       — path to the checked-out repo on the server
#   PM2_APP_NAME  — name from ecosystem.config.js (default: carbon-dashboard)

set -euo pipefail

APP_DIR="${APP_DIR:-$(pwd)}"
PM2_APP_NAME="${PM2_APP_NAME:-carbon-dashboard}"

echo "[deploy] APP_DIR=$APP_DIR PM2_APP_NAME=$PM2_APP_NAME"
cd "$APP_DIR"

echo "[deploy] git fetch + reset to origin/main"
git fetch --prune origin
git reset --hard origin/main

# Sanity: warn early if .env is missing. Without it, DEMO_MODE defaults false,
# TMS token is unset → ETL will loudly fail on every call. Fixing this is a
# one-time server task, not something the deploy should mask.
if [ ! -f .env ]; then
  echo "[deploy] WARNING: .env missing at $APP_DIR/.env — ETL will fail without TMS_AUTH_TOKEN."
fi

echo "[deploy] installing production dependencies"
# --omit=dev skips devDependencies. better-sqlite3's native binding is rebuilt
# here if the platform changed — safe to run on every deploy.
npm ci --omit=dev

mkdir -p logs

if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  echo "[deploy] reloading existing pm2 process ($PM2_APP_NAME)"
  pm2 reload "$PM2_APP_NAME" --update-env
else
  echo "[deploy] first run — starting pm2 process from ecosystem.config.js"
  pm2 start ecosystem.config.js
  # Persist the process list so pm2 resurrects it after a server reboot. This
  # is idempotent — safe on every deploy.
  pm2 save
fi

echo "[deploy] done. current status:"
pm2 status "$PM2_APP_NAME"
