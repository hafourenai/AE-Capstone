#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/sambal-joelid}"
APP_USER="${APP_USER:-sambal}"
SERVICE="${SERVICE:-sambal-joelid-api}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Jalankan script ini sebagai root agar backup dan restart service dapat dilakukan." >&2
  exit 1
fi

echo "[1/7] Memeriksa working tree"
if [[ -n "$(sudo -u "$APP_USER" git -C "$APP_DIR" status --porcelain)" ]]; then
  echo "Deployment dibatalkan: repository VPS memiliki perubahan lokal." >&2
  exit 1
fi

echo "[2/7] Membuat backup SQLite"
bash "$APP_DIR/ops/backup-sqlite.sh"

echo "[3/7] Mengambil source terbaru"
sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only origin main

echo "[4/7] Memasang dependency dan menjalankan native install scripts"
if [[ -d "$APP_DIR/node_modules" ]]; then
  echo "Memastikan ownership node_modules dimiliki $APP_USER"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR/node_modules"
fi
chown "$APP_USER:$APP_USER" "$APP_DIR/package-lock.json"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm ci --foreground-scripts"

echo "[5/7] Memverifikasi binding better-sqlite3"
if ! sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm run verify:native"; then
  echo "Binding belum tersedia; mencoba kompilasi ulang dari source."
  if ! sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm rebuild better-sqlite3 --build-from-source"; then
    echo "Kompilasi gagal. Pastikan build-essential dan python3 terpasang." >&2
    exit 1
  fi
  sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm run verify:native"
fi

echo "[6/7] Menjalankan test"
sudo -u "$APP_USER" bash -lc "cd '$APP_DIR' && npm test"

echo "[7/7] Restart dan health check"
systemctl restart "$SERVICE"
systemctl is-active --quiet "$SERVICE"
curl --fail --silent --show-error http://127.0.0.1:3001/api/v1/health
echo
echo "Deployment berhasil."
