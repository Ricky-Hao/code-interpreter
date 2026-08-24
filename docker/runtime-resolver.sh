#!/bin/bash

CODEAPI_RESOLVER_MAX_BYTES=16384

codeapi_networking_enabled() {
    local normalized

    normalized=$(printf '%s' "${1:-true}" |
        sed 's/^[[:space:]]*//; s/[[:space:]]*$//' |
        tr '[:upper:]' '[:lower:]')
    case "$normalized" in
        0|false|no|off) return 0 ;;
        *) return 1 ;;
    esac
}

codeapi_validate_resolver_file() {
    local resolver_file="$1"
    local resolver_size

    [ -f "$resolver_file" ] || return 1
    resolver_size=$(wc -c < "$resolver_file")
    [ "$resolver_size" -gt 0 ] 2>/dev/null || return 1
    [ "$resolver_size" -le "$CODEAPI_RESOLVER_MAX_BYTES" ] 2>/dev/null || return 1
    grep -Eq '^[[:space:]]*nameserver[[:space:]]+[^[:space:]#]+' "$resolver_file"
}

codeapi_encode_resolver_file() {
    local resolver_file="$1"

    codeapi_validate_resolver_file "$resolver_file" || return 1
    base64 < "$resolver_file" | tr -d '\n'
}

codeapi_write_runtime_resolver() {
    local encoded_resolver="$1"
    local fallback_resolver="$2"
    local destination="$3"
    local temporary

    temporary=$(mktemp "${destination}.XXXXXX") || return 1
    if [ -n "$encoded_resolver" ]; then
        if ! printf '%s' "$encoded_resolver" | base64 --decode > "$temporary"; then
            rm -f "$temporary"
            return 1
        fi
    elif ! cp "$fallback_resolver" "$temporary"; then
        rm -f "$temporary"
        return 1
    fi

    if ! codeapi_validate_resolver_file "$temporary"; then
        rm -f "$temporary"
        return 1
    fi
    chmod 0444 "$temporary"
    mv -f "$temporary" "$destination"
}