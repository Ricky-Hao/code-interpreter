#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

for command in helm python3 jq; do
    if ! command -v "${command}" >/dev/null 2>&1; then
        echo "missing required command: ${command}" >&2
        exit 1
    fi
done
if ! python3 -c 'import yaml' 2>/dev/null; then
    echo "missing required Python module: PyYAML" >&2
    exit 1
fi

mkdir "${tmpdir}/chart"
cp "${ROOT_DIR}/helm/codeapi/values.yaml" "${tmpdir}/chart/values.yaml"
cp -R "${ROOT_DIR}/helm/codeapi/templates" "${tmpdir}/chart/templates"
awk '/^dependencies:/{exit} {print}' \
    "${ROOT_DIR}/helm/codeapi/Chart.yaml" > "${tmpdir}/chart/Chart.yaml"

render_policies() {
    local disable_networking="$1"
    local output="$2"

    local rendered="${tmpdir}/rendered-${disable_networking}.yaml"

    helm template codeapi "${tmpdir}/chart" \
        --show-only templates/network-policy.yaml \
        --set executionManifest.privateKey=test \
        --set executionManifest.publicKey=test \
        --set "workerSandbox.sandbox.disableNetworking=${disable_networking}" \
        > "${rendered}"
    python3 - "${rendered}" > "${output}" <<'PY'
import json
import sys

import yaml

with open(sys.argv[1], encoding="utf-8") as stream:
    for document in yaml.safe_load_all(stream):
        if document is not None:
            print(json.dumps(document))
PY
}

render_policies true "${tmpdir}/disabled.json"
jq -se '
    [ .[] | select(.metadata.name == "codeapi-sandbox-runner") ] as $policies |
    ($policies | length) == 1 and
    ($policies[0].spec.egress | length) >= 2 and
    ($policies[0].spec.egress | all(. != {}))
' "${tmpdir}/disabled.json" >/dev/null

render_policies false "${tmpdir}/enabled.json"
jq -se '
    [ .[] | select(.metadata.name == "codeapi-sandbox-runner") ] as $policies |
    ($policies | length) == 1 and
    $policies[0].spec.egress == [{}]
' "${tmpdir}/enabled.json" >/dev/null

echo "sandbox NetworkPolicy networking checks passed"