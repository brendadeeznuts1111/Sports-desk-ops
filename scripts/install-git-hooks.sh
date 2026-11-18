#!/bin/sh
# Point git at the tracked .githooks directory. Run once per clone.
set -e
cd "$(dirname "$0")/.."
git config core.hooksPath .githooks
chmod +x .githooks/*
echo "git hooks installed: core.hooksPath=.githooks"
