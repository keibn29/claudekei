#!/usr/bin/env bash
# Release a new plugin version: bump, check, commit, tag, push, update the local install.
# Usage: scripts/release.sh [patch|minor|major|X.Y.Z] [-m "summary"] [--dry-run]
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

BUMP="patch"
SUMMARY="release"
DRY_RUN=0
while [ $# -gt 0 ]; do
  case "$1" in
    -m|--message)
      [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }
      SUMMARY="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) sed -n '2,3p' "$0"; exit 0 ;;
    -*) echo "error: unknown option $1" >&2; exit 2 ;;
    *) BUMP="$1"; shift ;;
  esac
done

step() { printf '\n==> %s\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

VERSION_FILES=(.claude-plugin/plugin.json package.json)
restore_versions() { git checkout -- "${VERSION_FILES[@]}"; }

step "1/6 Preflight"
[ "$(git rev-parse --abbrev-ref HEAD)" = "main" ] || die "must be on branch main"
git fetch origin --quiet
if [ "$(git rev-list --count HEAD..origin/main)" -gt 0 ]; then
  die "local main is behind origin/main; pull first"
fi

CURRENT="$(node -p 'JSON.parse(require("fs").readFileSync(".claude-plugin/plugin.json", "utf8")).version')"
[[ "$CURRENT" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]] || die "current version '$CURRENT' is not X.Y.Z"
MAJOR="${BASH_REMATCH[1]}"; MINOR="${BASH_REMATCH[2]}"; PATCH="${BASH_REMATCH[3]}"

case "$BUMP" in
  patch) VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
  minor) VERSION="$MAJOR.$((MINOR + 1)).0" ;;
  major) VERSION="$((MAJOR + 1)).0.0" ;;
  *)
    [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "bad bump '$BUMP' (patch|minor|major|X.Y.Z)"
    VERSION="$BUMP" ;;
esac
TAG="v$VERSION"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then die "tag $TAG already exists locally"; fi
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  die "tag $TAG already exists on origin"
fi
echo "$CURRENT -> $VERSION ($TAG)"
[ "$DRY_RUN" -eq 0 ] || echo "dry run: nothing will be committed or pushed"

step "2/6 Bump version"
NEW_VERSION="$VERSION" node -e '
const fs = require("fs");
for (const f of process.argv.slice(1)) {
  const j = JSON.parse(fs.readFileSync(f, "utf8"));
  j.version = process.env.NEW_VERSION;
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
}' "${VERSION_FILES[@]}"

step "3/6 Sync modes"
npm run sync:modes --silent || { restore_versions; die "sync:modes failed"; }

step "4/6 Check"
# Tests run with an empty HOME so a personal ~/.claude/claudekei.jsonc cannot affect them.
# Validation runs with the real HOME because the claude CLI may need its config.
if ! { node scripts/sync-modes.mjs --check \
      && HOME="$(mktemp -d)" node --test 'test/*.test.mjs' \
      && claude plugin validate .; }; then
  restore_versions
  die "check failed; version files restored, nothing committed"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  restore_versions
  echo; echo "dry run done: version files restored ($VERSION not released)"
  exit 0
fi

step "5/6 Commit, tag, push"
git add -A
git commit -q -m "$TAG: $SUMMARY" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git tag "$TAG"
git push origin main
git push origin "$TAG"

step "6/6 Update local plugin"
if command -v claude >/dev/null 2>&1; then
  claude plugin marketplace update claudekei || echo "warning: marketplace update failed"
  claude plugin update claudekei@claudekei || echo "warning: plugin update failed"
else
  echo "warning: claude CLI not found; run the update commands manually"
fi

echo; echo "Released $TAG. Restart running sessions (or run /reload-plugins) to pick it up."
