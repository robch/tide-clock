#!/bin/bash

# Tide Clock - Start HTTP Server
# This script starts a simple Python HTTP server to serve the tide clock application

PORT=8000

echo "Starting Tide Clock HTTP Server on port $PORT..."
echo "Open your browser to: http://localhost:$PORT"
echo ""
echo "Press Ctrl+C to stop the server"
echo ""

# Try python3 first, fall back to python
if command -v python3 &> /dev/null; then
    python3 -m http.server $PORT
elif command -v python &> /dev/null; then
    python -m http.server $PORT
else
    echo "Error: Python is not installed or not in PATH"
    exit 1
fi
