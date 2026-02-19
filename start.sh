#!/bin/bash
# Startup script for Facebook Auto-Reply Bot

cd "$(dirname "$0")"

# Check if config exists
if [ ! -f "data/config.json" ]; then
  echo "⚠️ No config found. Please configure at /dashboard"
fi

# Start the bot
echo "🚀 Starting Facebook Auto-Reply Bot..."
exec node server.js
