#!/usr/bin/env python3
"""PreToolUse hook for the file tools (Read, Edit, Write, MultiEdit, NotebookEdit, Grep, Glob).

- Secrets (.env files except .env.example, env.json, keys, ~/.aws, ~/.ssh, ...) are never read,
  searched or written.
- .git/ internals are never edited by hand, and package-lock.json changes only through npm.
- samconfig.toml must keep confirm_changeset = true in every deploy section. The edit is applied
  to the current file first and the result is checked.
- The guard rails themselves (.claude/hooks, .claude/agents, .claude/settings*.json, .githooks,
  the verify skill, the secret scan, tests/setup.js, tests/hooks) can be edited only after the
  user approves.
Paths are matched case-insensitively (macOS) and with symlinks resolved.

Exit 2 blocks the call and shows the message to the agent.
"""
import fnmatch
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guard_common import GLOB_SAMPLES, is_git_internal, is_protected_path, is_secret_path  # noqa: E402

data = json.load(sys.stdin)
tool = data.get("tool_name", "")
tool_input = data.get("tool_input") or {}
root = os.environ.get("CLAUDE_PROJECT_DIR") or data.get("cwd") or os.getcwd()
WRITE_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")


def block(reason, path):
    print(f"Blocked ({tool} {path}): {reason}", file=sys.stderr)
    sys.exit(2)


def ask(reason):
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "ask",
            "permissionDecisionReason": reason,
        }
    }))
    sys.exit(0)


def abs_path(path):
    path = os.path.expanduser(path)
    return os.path.normpath(path if os.path.isabs(path) else os.path.join(root, path))


def result_text(path):
    """The file's text as it would be after this tool call."""
    if tool == "Write":
        return tool_input.get("content") or ""
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        text = ""
    edits = tool_input.get("edits") if tool == "MultiEdit" else [tool_input]
    for edit in edits or []:
        old, new = edit.get("old_string") or "", edit.get("new_string") or ""
        if old:
            text = text.replace(old, new) if edit.get("replace_all") else text.replace(old, new, 1)
        else:
            text = new
    return text


def changeset_problem(text):
    if re.search(r"(?mi)^\s*(no_confirm_changeset|confirm_changeset\s*=\s*false|force_upload\s*=\s*true)", text):
        return "deploys must keep confirm_changeset = true (and no force_upload)."
    for section in re.split(r"(?m)^\s*\[", text)[1:]:
        header = section.split("]", 1)[0]
        if header.strip().endswith("deploy.parameters") and not re.search(r"(?mi)^\s*confirm_changeset\s*=\s*true\b", section):
            return f"[{header}] needs confirm_changeset = true; without it SAM deploys without showing the changeset."
    return None


paths = [p for p in (tool_input.get("file_path"), tool_input.get("notebook_path"), tool_input.get("path")) if p]
for path in paths:
    if is_secret_path(path, root):
        block("this holds secrets. Add new keys to .env.example with a comment; the user fills in .env.", path)

# Grep's glob and Glob's pattern can name secret files without a path.
for pattern in (tool_input.get("glob"), tool_input.get("pattern") if tool == "Glob" else None):
    if pattern:
        base = pattern.lower().rstrip("/").rsplit("/", 1)[-1]
        if any(fnmatch.fnmatchcase(s, base) for s in GLOB_SAMPLES if s != ".env.example") and (
                base.startswith(".") or "env" in base or "cred" in base or base.startswith("id_")):
            block("this pattern matches secret files such as .env.", pattern)
        if is_secret_path(pattern, root):
            block("this pattern matches secret files or credential stores.", pattern)

if tool in WRITE_TOOLS:
    for path in paths:
        full = abs_path(path)
        if is_git_internal(path, root):
            block("git internals are managed by git, not edited by hand.", path)
        name = os.path.basename(full).lower()
        if name == "package-lock.json":
            block("change dependencies with npm install, not by editing the lockfile.", path)
        if name == "samconfig.toml":
            new_texts = [e.get("new_string") or "" for e in tool_input.get("edits") or []]
            new_texts += [tool_input.get("new_string") or ""]
            problem = changeset_problem(result_text(full)) or next(
                (p for p in map(changeset_problem, new_texts) if p and "needs" not in p), None)
            if problem:
                block(problem, path)
        if is_protected_path(path, root):
            ask(f"{path} is part of the guard rails (hooks, settings, git hooks, verify, secret scan, test setup). "
                "Approve only if you asked for this change.")

sys.exit(0)
