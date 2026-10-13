#!/usr/bin/env bash
set -euo pipefail
cd /workspace/aquacard
export npm_config_cache=/tmp/aquacard-npm-cache
npm ci --no-audit --no-fund
npm run build
npm test
