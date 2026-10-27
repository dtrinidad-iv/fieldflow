#!/usr/bin/env python3
"""PreToolUse Bash hook for the test-writer subagent (on top of guard-bash.py).

test-writer only edits files under tests/, so its shell is limited to running tests and reading:
npm test / npx vitest, plus read-only commands (ls, cat, head, tail, grep, rg, wc, find without
-exec/-delete, git status/diff/log/show). Output may be redirected only to /dev/null or between
streams (2>&1).

Exit 2 blocks the call and shows the message to the agent.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guard_common import ParseError, split_segments, strip_heredocs, tokenize  # noqa: E402

READ_ONLY = {"ls", "cat", "head", "tail", "grep", "rg", "wc", "sort", "uniq", "diff", "pwd", "echo", "true", "jq"}
GIT_READ = {"status", "diff", "log", "show", "ls-files"}


def block(reason):
    print(f"Blocked for test-writer: {reason} Run tests with `npm test` or `npx vitest run <file>`; "
          "edit test files with the Edit/Write tools.", file=sys.stderr)
    sys.exit(2)


def allowed(words):
    while words and ("=" in words[0] and not words[0].startswith("-")):
        words = words[1:]  # VAR=value prefixes
    if not words:
        return True
    prog, args = words[0].rsplit("/", 1)[-1], words[1:]
    if prog == "npm":
        return args[:1] == ["test"] or (args[:1] == ["run"] and args[1:2] and args[1].startswith("test"))
    if prog == "npx":
        rest = [a for a in args if a != "--no-install"]
        return rest[:1] == ["vitest"]
    if prog == "vitest":
        return True
    if prog == "git":
        return next((a for a in args if not a.startswith("-")), "") in GIT_READ and not any(a.startswith("--output") for a in args)
    if prog == "find":
        return not any(a in ("-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls") for a in args)
    return prog in READ_ONLY


command = (json.load(sys.stdin).get("tool_input") or {}).get("command") or ""
stripped, bodies = strip_heredocs(command)
if bodies or "$(" in stripped or "`" in stripped:
    block("heredocs and command substitution aren't allowed.")
try:
    segments = split_segments(tokenize(stripped))
except ParseError:
    block("the command couldn't be parsed.")
for words, redirects in segments:
    for op, target in redirects:
        if ">" in op and target not in ("/dev/null", "1", "2", "&1", "&2"):
            block(f"writing files from the shell isn't allowed ({op} {target}).")
    if not allowed(words):
        block(f"`{' '.join(words)[:80]}` isn't a test run or a read-only command.")
sys.exit(0)
