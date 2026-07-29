#!/bin/sh
# Install the infer CLI.
#
#   curl -fsSL https://raw.githubusercontent.com/jimzer/infersh/main/install.sh | sh
#
# Override the install directory with INFER_BIN_DIR=/somewhere/bin.
set -eu

REPO="jimzer/infersh"
ASSET_URL="https://github.com/${REPO}/releases/latest/download/infer.js"
BIN_DIR="${INFER_BIN_DIR:-$HOME/.local/bin}"
TARGET="${BIN_DIR}/infer"

die() {
	echo "error: $*" >&2
	exit 1
}

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v bun >/dev/null 2>&1 || die "bun is required — install it from https://bun.sh"

mkdir -p "$BIN_DIR" || die "could not create $BIN_DIR"

# Download beside the target so the final move is atomic and stays on one
# filesystem, and so a failed download never leaves a broken `infer` behind.
TMP="${BIN_DIR}/.infer.install.$$"
trap 'rm -f "$TMP"' EXIT INT TERM

echo "Downloading infer..."
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
