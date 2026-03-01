@echo off
setlocal

rem Check whether better-sqlite3 matches the current Node.js ABI.
node -e "try{require('better-sqlite3');process.exit(0);}catch(err){if(err&&err.code==='ERR_DLOPEN_FAILED'&&String(err.message||'').includes('NODE_MODULE_VERSION')){process.exit(42);}console.error(err);process.exit(1);}"
set "NATIVE_CHECK_CODE=%errorlevel%"

if %NATIVE_CHECK_CODE% EQU 42 (
  echo [metapi] Detected Node.js/native module ABI mismatch. Rebuilding better-sqlite3...
  call npm rebuild better-sqlite3 --no-audit --fund=false
  if errorlevel 1 (
    echo [metapi] npm rebuild failed. Running npm ci --omit=dev as fallback...
    call npm ci --omit=dev --no-audit --fund=false
    if errorlevel 1 exit /b %errorlevel%
  )

  node -e "try{require('better-sqlite3');process.exit(0);}catch(err){console.error(err);process.exit(1);}"
  if errorlevel 1 (
    echo [metapi] better-sqlite3 is still incompatible with current Node.js.
    echo [metapi] Recommended: use Node.js 22 LTS or run Docker image 1467078763/metapi:latest.
    exit /b %errorlevel%
  )
) else if NOT %NATIVE_CHECK_CODE% EQU 0 (
  exit /b %NATIVE_CHECK_CODE%
)

node dist/server/db/migrate.js
if errorlevel 1 exit /b %errorlevel%

node dist/server/index.js
exit /b %errorlevel%
