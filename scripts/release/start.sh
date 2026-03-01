#!/usr/bin/env sh
set -eu

node dist/server/db/migrate.js
exec node dist/server/index.js
