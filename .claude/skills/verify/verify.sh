#!/usr/bin/env bash
# Every check that must pass before a change is done. Mirrors .github/workflows/ci.yml.
# VERIFY_REQUIRE_SAM=1 (used by the safe-deploy skill) turns a skipped `sam validate` into a failure.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

failed=()
step() {
  local name="$1"; shift
  echo "==> $name"
  if "$@"; then echo "    ok"; else echo "    FAILED"; failed+=("$name"); fi
}

step "secret scan" scripts/scan-secrets.sh
step "lint" npm run --silent lint
step "tests" npm run --silent test:coverage
# All dependencies, dev included: vitest, eslint and jsdom run on dev machines and in CI.
step "npm audit" npm audit --audit-level=high
if [ -f template.yaml ]; then
  if command -v sam >/dev/null 2>&1; then
    step "sam validate" sam validate --lint
  elif [ "${VERIFY_REQUIRE_SAM:-}" = "1" ]; then
    echo "==> sam validate"; echo "    FAILED (SAM CLI not installed, and VERIFY_REQUIRE_SAM=1)"; failed+=("sam validate")
  else
    echo "==> sam validate"; echo "    SKIPPED (SAM CLI not installed)"
  fi
fi

if [ ${#failed[@]} -eq 0 ]; then
  echo "ALL PASSED"
else
  echo "FAILED: ${failed[*]}"
  exit 1
fi
