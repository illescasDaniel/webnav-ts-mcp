#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
	cat <<'EOF2'
Check, build and publish this package to npm.

Usage: scripts/publish.sh [options]

Options:
  --build-only    Run the checks and `npm pack` a tarball into dist-pack/, publish nothing
  --dry-run       Run everything `npm publish` does except the upload
  --otp CODE      One-time password for 2FA (otherwise npm prompts)
  --tag TAG       Publish under a dist-tag (e.g. next) instead of latest
  -h, --help      Show this help

You must be logged in (`npm login`). A registry never accepts the same version
twice, so bump it first: `npm version patch|minor|major` (this also commits and
tags). Verify a published version: `npm run test-package`.
EOF2
}

publish_args=()
build_only=false
while [[ $# -gt 0 ]]; do
	case "$1" in
	--build-only)
		build_only=true
		shift
		;;
	--dry-run)
		publish_args+=(--dry-run)
		shift
		;;
	--otp)
		[[ $# -ge 2 ]] || { echo "error: --otp needs a code" >&2; exit 1; }
		publish_args+=(--otp "$2")
		shift 2
		;;
	--tag)
		[[ $# -ge 2 ]] || { echo "error: --tag needs a name" >&2; exit 1; }
		publish_args+=(--tag "$2")
		shift 2
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "error: unknown option: $1" >&2
		usage >&2
		exit 1
		;;
	esac
done

cd "${repo_root}"

read -r name version < <(node -p "const p = require('./package.json'); p.name + ' ' + p.version")

if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then
	echo "warning: working tree has uncommitted changes" >&2
fi

npm run check

if [[ "${build_only}" == "true" ]]; then
	mkdir -p dist-pack
	npm pack --pack-destination dist-pack
	echo "Built (not uploaded): ${repo_root}/dist-pack"
	exit 0
fi

if ! user="$(npm whoami 2>/dev/null)"; then
	echo "error: not logged in to npm; run: npm login" >&2
	exit 1
fi

if npm view "${name}@${version}" version >/dev/null 2>&1; then
	echo "error: ${name}@${version} is already published; bump it with: npm version patch|minor|major" >&2
	exit 1
fi

echo "Publishing ${name}@${version} as ${user}"
npm publish --access public ${publish_args[@]+"${publish_args[@]}"}
