#!/bin/bash

# Exit on error
set -e

# Print commands as they're executed
set -x

# Get the directory where the script is located
SCRIPT_DIR="$(dirname "$0")"

echo "Building atopile_lsp..."
cargo build --release -p atopile_lsp

echo "Copying LSP binary to vscode extension..."
# Ensure the destination directory exists
mkdir -p "$SCRIPT_DIR/vscode/client/lsp"
cp "$SCRIPT_DIR/target/release/atopile_lsp" "$SCRIPT_DIR/vscode/lsp/atopile_lsp"

echo "Installing vscode extension dependencies..."
cd "$SCRIPT_DIR/vscode"
if ! npm install; then
    echo "Failed to install npm dependencies"
    exit 1
fi

echo "Packaging vscode extension..."
if ! npx --yes vsce package; then
    echo "Failed to package vscode extension"
    exit 1
fi

echo "Installing vscode extension..."
if ! code --install-extension atopile-analyzer-*.vsix; then
    echo "Failed to install vscode extension"
    exit 1
fi

echo "Installation complete!"