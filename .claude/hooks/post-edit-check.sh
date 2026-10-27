#!/usr/bin/env bash
# PostToolUse hook for Edit/Write: lint the changed JS file and run the tests related to it,
# so a broken change is caught right after it's made. Exit 2 sends the failure back to the agent.
input="$(cat)"
path="$(printf '%s' "$input" | /usr/bin/python3 -c 'import json,sys; t=json.load(sys.stdin).get("tool_input",{}); print(t.get("file_path") or "")')"
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

[ -d "$root/node_modules" ] || exit 0
cd "$root" || exit 0

case "$path" in
  */.claude/hooks/*|.claude/hooks/*|*/scripts/*.sh|scripts/*.sh|*/.githooks/*|.githooks/*)
    # The guard rails are pinned by their own tests: a weakened guard fails right away.
    out="$(npx --no-install vitest run tests/hooks --reporter=dot 2>&1)" || {
      printf 'Hook tests failed after editing %s:\n%s\n' "$path" "$(printf '%s' "$out" | tail -40)" >&2
      exit 2
    }
    exit 0
    ;;
  *.js|*.mjs) ;;
  *) exit 0 ;;
esac

out="$(npx --no-install eslint --no-warn-ignored "$path" 2>&1)" || {
  printf 'ESLint failed for %s:\n%s\n' "$path" "$out" >&2
  exit 2
}
out="$(npx --no-install vitest related "$path" --run --passWithNoTests --reporter=dot 2>&1)" || {
  printf 'Tests related to %s failed:\n%s\n' "$path" "$(printf '%s' "$out" | tail -40)" >&2
  exit 2
}
exit 0
