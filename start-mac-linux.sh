#!/usr/bin/env sh
set -e
cd "$(dirname "$0")"
printf 'Open http://localhost:8080 in your browser.\n'
node server.js
