#!/usr/bin/env bash
# Read-only preflight: never rebuild either immutable SHA tag if one exists.
set -euo pipefail
image=${1:?image required}
sha=${2:?full SHA required}
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
error=$(mktemp)
trap 'rm -f "$error"' EXIT
digests=()
for tag in "sha-$sha" "sha-${sha:0:12}"; do
    ref="$image:$tag"
    if manifest=$(docker buildx imagetools inspect "$ref" 2>"$error"); then
        digest=$(awk '$1 == "Digest:" {print $2; exit}' <<<"$manifest")
        [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || exit 1
        revision=$(bash .github/scripts/image-revision.sh "$ref")
        [[ "$revision" == "$sha" ]] || { echo "Revision collision: $ref" >&2; exit 1; }
        digests+=("$digest")
    elif grep -qiE 'manifest_unknown|manifest unknown|: not found$' "$error" && ! grep -qiE 'denied|unauthorized|forbidden|40[13]' "$error"; then
        digests+=('missing')
    else
        cat "$error" >&2
        exit 1
    fi
done
if [[ "${digests[0]}" != "${digests[1]}" ]]; then
    echo 'Immutable tags differ or publication is partial; refusing overwrite' >&2
    exit 1
fi
if [[ "${digests[0]}" == missing ]]; then
    echo 'exists=false' >> "${GITHUB_OUTPUT:?}"
else
    printf 'exists=true\ndigest=%s\n' "${digests[0]}" >> "${GITHUB_OUTPUT:?}"
fi
