@echo off
setlocal

node dist/server/db/migrate.js
if errorlevel 1 exit /b %errorlevel%

node dist/server/index.js
exit /b %errorlevel%
