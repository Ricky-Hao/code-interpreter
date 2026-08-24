#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

for command in helm kubectl jq; do
    if ! command -v "${command}" >/dev/null 2>&1; then
        echo "missing required command: ${command}" >&2
        exit 1
    fi
done

mkdir "${tmpdir}/chart"
cp "${ROOT_DIR}/helm/codeapi/values.yaml" "${tmpdir}/chart/values.yaml"
cp -R "${ROOT_DIR}/helm/codeapi/templates" "${tmpdir}/chart/templates"
awk '/^dependencies:/{exit} {print}' \
    "${ROOT_DIR}/helm/codeapi/Chart.yaml" > "${tmpdir}/chart/Chart.yaml"

render_policies() {
    local disable_networking="$1"
    local output="$2"

    helm template codeapi "${tmpdir}/chart" \
        --show-only templates/network-policy.yaml \
        --set executionManifest.privateKey=test \
        --set executionManifest.publicKey=test \
        --set "workerSandbox.sandbox.disableNetworking=${disable_networking}" |
        kubectl create --dry-run=client --validate=false -f - -o json > "${output}"
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