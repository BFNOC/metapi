#!/usr/bin/env sh
set -eu

# Check whether better-sqlite3 matches the current Node.js ABI.
set +e
node -e "try{require('better-sqlite3');process.exit(0);}catch(err){if(err&&err.code==='ERR_DLOPEN_FAILED'&&String(err.message||'').includes('NODE_MODULE_VERSION')){process.exit(42);}console.error(err);process.exit(1);}"
native_check_code=$?
set -e

if [ "$native_check_code" -eq 42 ]; then
  echo "[metapi] Detected Node.js/native module ABI mismatch. Rebuilding better-sqlite3..."
  if ! npm rebuild better-sqlite3 --no-audit --fund=false; then
    echo "[metapi] npm rebuild failed. Running npm ci --omit=dev as fallback..."
    npm ci --omit=dev --no-audit --fund=false
  fi

  node -e "try{require('better-sqlite3');process.exit(0);}catch(err){console.error(err);process.exit(1);}"
elif [ "$native_check_code" -ne 0 ]; then
  exit "$native_check_code"
fi

node dist/server/db/migrate.js
exec node dist/server/index.js
