#!/usr/bin/env bash
# PreToolUse hook for the test-writer subagent: allow file edits only under tests/, and never to the
# test safety net itself (tests/setup.js, tests/hooks/). Symlinks are resolved, so a link under tests/
# can't point at app code. Exit 2 blocks the tool call and shows the message to the agent.
input="$(cat)"
path="$(printf '%s' "$input" | /usr/bin/python3 -c 'import json,sys; t=json.load(sys.stdin).get("tool_input",{}); print(t.get("file_path") or t.get("notebook_path") or "")')"
root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"

case "$path" in
  /*) abs="$path" ;;
  *) abs="$root/$path" ;;
esac
# realpath resolves symlinks in every existing part of the path; lower-case for macOS.
abs="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]).lower())' "$abs")"
tests="$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]).lower())' "$root/tests")"

case "$abs" in
  "$tests"/setup.js|"$tests"/hooks|"$tests"/hooks/*)
    echo "test-writer may not change the test safety net (tests/setup.js, tests/hooks/). Report the problem to the caller instead." >&2
    exit 2
    ;;
  "$tests"/*) exit 0 ;;
  *)
    echo "test-writer may only edit files under tests/ (blocked: $path). Report app-code problems to the caller instead." >&2
    exit 2
    ;;
esac
