#!/bin/sh
# Install the infer CLI.
#
#   curl -fsSL https://raw.githubusercontent.com/jimzer/infersh/main/install.sh | sh
#
# Override the install directory with INFER_BIN_DIR=/somewhere/bin.
set -eu

REPO="jimzer/infersh"
BIN_DIR="${INFER_BIN_DIR:-$HOME/.local/bin}"
TARGET="${BIN_DIR}/infer"

die() {
	echo "error: $*" >&2
	exit 1
}

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v bun >/dev/null 2>&1 || die "bun is required — install it from https://bun.sh"

# Resolve the newest tag through the API rather than using
# releases/latest/download/infer.js — that redirect is CDN-cached and serves
# the *previous* release's asset for a while after a new one is published.
TAG="${INFER_VERSION:-}"
if [ -z "$TAG" ]; then
	TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" |
		sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' |
		head -1)
	[ -n "$TAG" ] || die "could not determine the latest release of $REPO"
fi
ASSET_URL="https://github.com/${REPO}/releases/download/${TAG}/infer.js"

mkdir -p "$BIN_DIR" || die "could not create $BIN_DIR"

# Download beside the target so the final move is atomic and stays on one
# filesystem, and so a failed download never leaves a broken `infer` behind.
TMP="${BIN_DIR}/.infer.install.$$"
trap 'rm -f "$TMP"' EXIT INT TERM

echo "Downloading infer ${TAG}..."
curl -fsSL "$ASSET_URL" -o "$TMP" || die "download failed from $ASSET_URL"
[ -s "$TMP" ] || die "downloaded an empty file"

chmod +x "$TMP"
mv "$TMP" "$TARGET"
trap - EXIT INT TERM

echo "Installed $("$TARGET" --version 2>/dev/null || echo infer) to $TARGET"

case ":${PATH}:" in
*":${BIN_DIR}:"*) ;;
*)
	echo
	echo "note: $BIN_DIR is not on your PATH. Add it with:"
	echo "  export PATH=\"$BIN_DIR:\$PATH\""
	;;
esac
