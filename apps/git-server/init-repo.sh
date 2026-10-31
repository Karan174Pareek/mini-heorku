#!/bin/sh
set -e

SLUG="$1"
if [ -z "$SLUG" ]; then
  echo "Usage: init-repo.sh <slug>"
  exit 1
fi

REPO_DIR="/repos/${SLUG}.git"
mkdir -p "$REPO_DIR"

if [ ! -f "$REPO_DIR/HEAD" ]; then
  git init --bare "$REPO_DIR"
fi

HOOKS_DIR="$REPO_DIR/hooks"
mkdir -p "$HOOKS_DIR"

cat <<'EOF' > "$HOOKS_DIR/post-receive"
#!/bin/sh
set -e

APP_SLUG="__SLUG__"
API_INTERNAL_URL="${API_INTERNAL_URL:-http://host.k3d.internal:3000}"
PUSHR_INTERNAL_SECRET="${PUSHR_INTERNAL_SECRET:-pushr_internal_shared_secret_2026}"

while read oldrev newrev refname; do
  echo "[Pushr] Received push: $refname ($oldrev -> $newrev)"

  if [ "$refname" != "refs/heads/main" ]; then
    echo "[Pushr] Skipping build: ref '$refname' is not 'refs/heads/main'."
    continue
  fi

  echo "[Pushr] Enqueuing build for app '$APP_SLUG' (commit $newrev)..."

  PAYLOAD="{\"appSlug\":\"$APP_SLUG\",\"commitSha\":\"$newrev\",\"ref\":\"$refname\"}"

  curl -s -m 5 -X POST "$API_INTERNAL_URL/api/internal/releases/build" \
    -H "Content-Type: application/json" \
    -H "X-Pushr-Internal-Secret: $PUSHR_INTERNAL_SECRET" \
    -d "$PAYLOAD" >/dev/null 2>&1 &

  echo "[Pushr] Build queued asynchronously for commit $newrev."
done
EOF

sed -i "s/__SLUG__/$SLUG/g" "$HOOKS_DIR/post-receive"
chmod 755 "$HOOKS_DIR/post-receive"

echo "Repository $REPO_DIR initialized with executable post-receive hook."

