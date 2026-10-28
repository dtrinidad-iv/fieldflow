"""Shared helpers for the guard hooks: shell tokenizing and the secret / protected path rules.

Kept compatible with the macOS system Python (3.9).
"""
import fnmatch
import os
import re
import shlex

# ---------------------------------------------------------------------------
# Shell parsing
# ---------------------------------------------------------------------------
OPERATOR_CHARS = ";&|()<>\n"


class ParseError(Exception):
    pass


def tokenize(command):
    """Split a shell command into words and operator tokens, respecting quotes.

    Operators come back as runs of OPERATOR_CHARS (`&&`, `|`, `>`, `2>&1` gives `2`, `>&`, `1`).
    Raises ParseError when the quoting is unbalanced.
    """
    lexer = shlex.shlex(command, posix=True, punctuation_chars=OPERATOR_CHARS)
    lexer.whitespace = " \t\r"
    lexer.whitespace_split = True
    lexer.commenters = ""
    try:
        return list(lexer)
    except ValueError as err:
        raise ParseError(str(err))


def is_operator(token):
    return bool(token) and all(c in OPERATOR_CHARS for c in token)


def is_redirect(token):
    return is_operator(token) and ("<" in token or ">" in token)


def split_segments(tokens):
    """Split tokens into simple commands. Returns a list of (words, redirects) pairs.

    redirects is a list of (operator, target) pairs, for example ('>', 'out.txt').
    """
    segments = []
    words, redirects = [], []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if is_redirect(tok):
            # `2>` / `2>&1`: the fd number is the word just before the operator.
            if words and words[-1].isdigit():
                words.pop()
            target = tokens[i + 1] if i + 1 < len(tokens) and not is_operator(tokens[i + 1]) else ""
            redirects.append((tok, target))
            i += 2 if target else 1
            continue
        if is_operator(tok):
            if words or redirects:
                segments.append((words, redirects))
            words, redirects = [], []
        else:
            words.append(tok)
        i += 1
    if words or redirects:
        segments.append((words, redirects))
    return segments


HEREDOC = re.compile(r"<<-?[ \t]*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n")


def strip_heredocs(command):
    """Remove here-document bodies.

    Returns (command without bodies, [(body, expands)]). expands is True when the delimiter is
    unquoted, so the shell runs any $(...) inside the body.
    """
    bodies = []
    out = command
    pos = 0
    while True:
        m = HEREDOC.search(out, pos)
        if not m:
            break
        delim = m.group(2)
        end = re.compile(r"(?m)^[ \t]*" + re.escape(delim) + r"[ \t]*$").search(out, m.end())
        body_end = end.start() if end else len(out)
        bodies.append((out[m.end():body_end], not m.group(1)))
        resume = end.end() if end else len(out)
        out = out[:m.end()] + out[resume:]
        pos = m.end()
    return out, bodies


def substitutions(command):
    """Return the inner text of every $(...) and `...` in the command (quoted or not)."""
    found = []
    i = 0
    while i < len(command):
        if command.startswith("$(", i) and not command.startswith("$((", i):
            depth, j = 1, i + 2
            while j < len(command) and depth:
                if command[j] == "(":
                    depth += 1
                elif command[j] == ")":
                    depth -= 1
                j += 1
            found.append(command[i + 2:j - 1])
            i = j
        elif command[i] == "\\":
            i += 2  # an escaped character, e.g. \` inside double quotes, is literal
        elif command[i] == "`":
            j = command.find("`", i + 1)
            while j != -1 and command[j - 1] == "\\":
                j = command.find("`", j + 1)
            if j == -1:
                found.append(command[i + 1:])
                break
            found.append(command[i + 1:j])
            i = j + 1
        else:
            i += 1
    return found


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
SECRET_NAMES = re.compile(
    r"^(\.env(\..+)?|\.envrc|env\.json|locals\.json|\.npmrc|\.netrc|\.pgpass|\.pypirc"
    r"|id_(rsa|dsa|ecdsa|ed25519)(_sk)?|credentials\.json|service-account.*\.json)$"
)
SECRET_EXTENSIONS = (".pem", ".key", ".p12", ".pfx", ".jks", ".keystore")
SECRET_DIRS = re.compile(r"(^|/)(\.aws|\.ssh|\.gnupg|\.docker)(/|$)|(^|/)\.config/gh(/|$)|(^|/)\.kube/config$")
GLOB_SAMPLES = (".env", ".env.local", ".env.production", ".envrc", "env.json", "credentials", "id_rsa", "id_ed25519")


def _norm(path, cwd):
    path = os.path.expanduser(path)
    return os.path.normpath(path if os.path.isabs(path) else os.path.join(cwd, path))


def _candidates(path, cwd):
    """The path as written and with symlinks resolved, lower-cased (macOS is case-insensitive)."""
    abs_path = _norm(path, cwd)
    out = {abs_path.lower()}
    try:
        out.add(os.path.realpath(abs_path).lower())
    except OSError:
        pass
    return out


def _secret_name(name):
    return name != ".env.example" and (SECRET_NAMES.match(name) or name.endswith(SECRET_EXTENSIONS))


def is_secret_path(path, cwd):
    """True for .env files (not .env.example), keys, and credential stores such as ~/.aws."""
    if not path:
        return False
    low = path.lower()
    if any(c in low for c in "*?["):
        base = low.rstrip("/").rsplit("/", 1)[-1]
        if SECRET_DIRS.search(os.path.dirname(os.path.expanduser(low))):
            return True
        if base.startswith(".") or "env" in base or "cred" in base or base.startswith("id_"):
            return any(fnmatch.fnmatchcase(s, base) and _secret_name(s) for s in GLOB_SAMPLES)
        return False
    for cand in _candidates(path, cwd):
        if _secret_name(os.path.basename(cand)) or SECRET_DIRS.search(cand):
            return True
    return False


def is_git_internal(path, cwd):
    return any(".git" in cand.split("/") for cand in _candidates(path, cwd))


# Files that hold the guard rails themselves. Agents may not change them from the shell;
# edit tools ask the user first.
PROTECTED = re.compile(
    r"(^|/)(\.githooks|\.claude/hooks|\.claude/agents|\.claude/skills/verify|tests/hooks)(/|$)"
    r"|(^|/)(\.claude|\.claude/settings(\.local)?\.json|scripts/scan-secrets\.sh|tests/setup\.js"
    r"|tests/infra/stateful-resources\.json)$"
)


def is_protected_path(path, cwd):
    return any(PROTECTED.search(cand) for cand in _candidates(path, cwd))
