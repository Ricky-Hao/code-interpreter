#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
mkdir "$temp/bin"
cat > "$temp/bin/docker" <<'SH'
#!/usr/bin/env bash
ref=$4
case "$CASE" in
  missing) echo 'manifest unknown' >&2; exit 1 ;;
  denied) echo '403 denied: not found' >&2; exit 1 ;;
  outage) echo 'connection timed out' >&2; exit 1 ;;
  partial) if [[ "$ref" == *"sha-${SHA:0:12}" ]]; then echo 'manifest unknown' >&2; exit 1; fi ;;
esac
if [[ "$*" == *--format* ]]; then
    revision=$SHA
    [[ "$CASE" != collision ]] || revision=wrong
    printf '{"config":{"Labels":{"org.opencontainers.image.revision":"%s"}}}\n' "$revision"
else
    printf 'Digest: sha256:%064d\n' 1
fi
SH
chmod +x "$temp/bin/docker"
export PATH="$temp/bin:$PATH" SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export GITHUB_OUTPUT="$temp/output" IMAGE_REVISION_ATTEMPTS=1
for CASE in missing exists denied outage partial collision; do
    export CASE
    : > "$GITHUB_OUTPUT"
    if bash .github/scripts/fork-image-tags.sh ghcr.io/fixture/image "$SHA" >"$temp/log" 2>&1; then
        case "$CASE" in
          missing) grep -qx 'exists=false' "$GITHUB_OUTPUT" ;;
          exists) grep -qx 'exists=true' "$GITHUB_OUTPUT"; grep -q '^digest=sha256:' "$GITHUB_OUTPUT" ;;
          *) cat "$temp/log"; echo "incorrectly accepted $CASE" >&2; exit 1 ;;
        esac
    else
        case "$CASE" in missing|exists) cat "$temp/log"; exit 1 ;; esac
        test ! -s "$GITHUB_OUTPUT"
    fi
done
echo 'immutable tag checks passed (6 cases, registry commands mocked)'
