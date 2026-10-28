#!/usr/bin/env python3
"""PreToolUse hook for every Bash call (subagents included).

Blocks commands that can destroy live data, leak secrets or switch off the guard rails:
- AWS CLI writes and secret reads (only read verbs pass); `sam delete/sync/remote/package/pipeline`
- writes to the live Tadabase REST API (only GET passes) and setting FIELDFLOW_ALLOW_LIVE_WRITES
- destructive git (force push, reset --hard, clean -f, discarding changes, --no-verify, commit -n)
- `rm -r` on anything except build output or the scratchpad; find -delete / -exec rm; xargs rm
- reading secret files or credential stores, dumping the environment
- shell writes to the guard rails (.claude/hooks, settings, .githooks, ...), .git/, the lockfile, samconfig.toml
`sam deploy --no-execute-changeset`, run on its own, asks the user. Any other deploy is blocked.

How it checks: the command is split with a quote-aware tokenizer. Wrappers (sudo, env, timeout,
xargs, ...), `bash -c` and `eval` strings, $(...), backticks and heredocs fed to a shell are
unwrapped and checked too. Inline interpreter code (python -c, node -e, a heredoc into python) is
scanned for the same dangers. A script *file* run by an interpreter is not inspected; the normal
permission prompt covers that. Anything that can't be parsed is blocked, and so is a crash here.

Exit 2 blocks the call and shows the message to the agent.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guard_common import (  # noqa: E402
    ParseError, is_git_internal, is_protected_path, is_secret_path, split_segments,
    strip_heredocs, substitutions, tokenize,
)


class Blocked(Exception):
    pass


def block(reason):
    raise Blocked(reason)


class Context:
    def __init__(self, command, cwd):
        self.full_lower = command.lower()
        self.cwd = cwd
        self.segments = 0
        self.deploy = False


ASSIGNMENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*\+?=")
KEYWORDS = {"!", "{", "}", "then", "do", "else", "elif", "if", "while", "until", "coproc"}
# Wrappers that run another command, with the options that take a value.
WRAPPERS = {
    "sudo": {"-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-U", "-T", "--user", "--group", "--chdir"},
    "env": {"-u", "-C", "-P", "--unset", "--chdir"},
    "exec": {"-a"},
    "command": set(),
    "builtin": set(),
    "time": {"-f", "-o"},
    "nohup": set(),
    "nice": {"-n", "--adjustment"},
    "timeout": {"-s", "-k", "--signal", "--kill-after"},
    "stdbuf": set(),
    "caffeinate": {"-t", "-w"},
    "unbuffer": set(),
    "chronic": set(),
    "noglob": set(),
    "xargs": {"-I", "-n", "-P", "-L", "-s", "-d", "-E", "-a", "-J", "-R", "-S", "--max-args",
              "--max-procs", "--delimiter", "--arg-file", "--max-lines", "--max-chars", "--replace", "--eof"},
    "npx": {"-p", "--package"},
    "watch": {"-n", "--interval"},
}
SHELLS = {"bash", "sh", "zsh", "dash", "ksh", "fish", "csh", "tcsh"}
INTERPRETER = re.compile(r"^(python[0-9.]*|node|nodejs|deno|bun|ruby|perl|php|osascript|lua|pwsh|Rscript)$")
INLINE_FLAGS = {"-c", "-e", "-E", "-p", "-r", "--eval", "--print", "-pe", "-ne", "-Command", "-command"}
INLINE_DANGERS = [
    (re.compile(r"tadabase", re.I), "inline code that talks to Tadabase could write to the live app."),
    (re.compile(r"FIELDFLOW_ALLOW_LIVE_WRITES"), "FIELDFLOW_ALLOW_LIVE_WRITES turns on writes to the live Tadabase app."),
    (re.compile(r"(?<![\w$])\.env\b(?!\.example)|\bdotenv\b|\.aws\b|\.ssh/|\.npmrc|\.netrc", re.I),
     "inline code that reads secret files or credential stores."),
    (re.compile(r"\bprocess\.env\b(?!\.\w|\[)|\bos\.environ\b(?!\s*\[|\.get\b)|%ENV\b"),
     "dumping the environment can print secrets."),
    (re.compile(r"child_process|\bexecSync\b|\bspawnSync\b|\bexecFile|\bsubprocess\b|\bos\.(system|popen|exec\w*|spawn\w*)\b"
                r"|\bshell_exec\b|\bpassthru\b|do shell script|\bpty\.spawn\b"),
     "inline code that runs shell commands can't be checked."),
    (re.compile(r"\brmtree\b|\brmSync\b|\brimraf\b|\bunlinkSync\b|\bfs\.(rm|rmdir|unlink)\b|\bos\.(remove|unlink|rmdir|removedirs)\b"),
     "inline code that deletes files."),
    (re.compile(r"@aws-sdk|\baws-sdk\b|\bboto3\b|\bbotocore\b"), "inline AWS SDK code skips the read-only AWS rule."),
]
PROTECTED_FRAGMENT = re.compile(r"\.claude/|\.githooks|\.git/|package-lock\.json|samconfig|scan-secrets|tests/setup\.js|tests/hooks", re.I)
WRITE_CALL = re.compile(r"write|append|open\([^)]*['\"][wax+]|copyfile|copyFile|rename|chmod|truncate|symlink", re.I)

REBUILDABLE = {"node_modules", ".aws-sam", "coverage", "dist", ".vitest", "test-results"}
SCRATCH_PREFIXES = ("/private/tmp/claude-", "/tmp/claude-")
DELETERS = {"rm", "unlink", "shred", "srm", "rmdir", "trash"}
SECRET_VAR = re.compile(r"\$\{?[A-Z_]*(SECRET|TOKEN|KEY|PASSWORD|CREDENTIAL)[A-Z_]*")

AWS_READ_VERB = re.compile(
    r"^(describe-|get-|list-|ls$|tail$|filter-log-events$|validate-template$|head-object$|wait$)"
)
AWS_FLAGS = {"--debug", "--no-verify-ssl", "--no-paginate", "--no-cli-pager",
             "--cli-auto-prompt", "--no-cli-auto-prompt", "--version", "--help"}
AWS_VALUE_OPTS = {"--profile", "--region", "--output", "--query", "--cli-read-timeout",
                  "--cli-connect-timeout", "--ca-bundle", "--color", "--cli-binary-format"}
# Never needed here, anywhere in the command: --endpoint-url sends the request (and its arguments)
# to any host, and --no-sign-request reaches other people's public buckets.
AWS_BLOCKED_OPTS = {"--endpoint-url", "--no-sign-request"}
AWS_SECRET_READS = {
    ("secretsmanager", "get-secret-value"), ("secretsmanager", "batch-get-secret-value"),
    ("sts", "get-session-token"), ("sts", "get-federation-token"),
    ("ecr", "get-login-password"), ("ecr-public", "get-login-password"),
    ("ecr", "get-authorization-token"), ("ecr-public", "get-authorization-token"),
    ("eks", "get-token"), ("ec2", "get-password-data"), ("lightsail", "get-instance-access-details"),
    ("codeartifact", "get-authorization-token"), ("sso", "get-role-credentials"),
    ("lambda", "get-function"), ("lambda", "get-function-configuration"),
    ("cognito-identity", "get-credentials-for-identity"), ("cognito-identity", "get-open-id-token"),
}
# "get-" commands that write their result to a local file named by an argument: a read verb that
# could overwrite any path, guard rails included. (S3 objects are also invoice PDFs.)
AWS_FILE_OUTPUT = {
    ("s3api", "get-object"), ("s3api", "get-object-torrent"), ("apigateway", "get-export"),
    ("apigateway", "get-sdk"), ("glacier", "get-job-output"), ("mediastore-data", "get-object"),
    ("kinesis-video-media", "get-media"), ("kinesis-video-archived-media", "get-clip"),
}
HTTP_CLIENTS = {"curl", "curlie", "wget", "http", "https", "xh", "xhs"}
CURL_VALUE_SHORT = set("AbcCDeEHmoPruUwxyYzQ")
READ_METHODS = {"GET", "HEAD"}
SAFE_GIT_CONFIG = re.compile(
    r"^(color\.|core\.quotepath=|core\.pager=cat$|user\.(name|email)=|advice\.|init\.defaultbranch=|log\."
    r"|diff\.(renames|algorithm|colormoved)=|merge\.conflictstyle=|safe\.directory=|pager\.[a-z-]+=(false|cat)$"
    r"|commit\.gpgsign=false$|i18n\.)", re.I)
DANGEROUS_GIT_CONFIG = re.compile(r"hookspath|^alias\.|fsmonitor|sshcommand|pager|editor|textconv|credential|gitproxy|^filter\.|^diff\.\w+\.command", re.I)


# ---------------------------------------------------------------------------
# Walking the command
# ---------------------------------------------------------------------------
def check_command(command, ctx, depth=0):
    if depth > 4:
        block("the command nests shells too deeply to check.")
    stripped, bodies = strip_heredocs(command)
    for inner in substitutions(stripped):
        check_command(inner, ctx, depth + 1)
    for body, expands in bodies:
        if expands:
            for inner in substitutions(body):
                check_command(inner, ctx, depth + 1)
    try:
        tokens = tokenize(stripped)
    except ParseError:
        block("the command couldn't be parsed (unbalanced quotes), so it can't be checked.")
    segments = split_segments(tokens)
    ctx.segments += len(segments)
    for words, redirects in segments:
        check_segment(words, redirects, bodies, ctx, depth)


def unwrap(words, ctx, depth):
    """Drop assignments, keywords and wrappers. Returns (words, wrappers seen)."""
    via = set()
    while words:
        first = words[0]
        if ASSIGNMENT.match(first) or first in KEYWORDS:
            words = words[1:]
            continue
        name = first.rsplit("/", 1)[-1]
        if name not in WRAPPERS:
            break
        via.add(name)
        rest = words[1:]
        i = 0
        while i < len(rest) and (rest[i].startswith("-") or (name == "env" and ASSIGNMENT.match(rest[i]))):
            arg = rest[i]
            if arg == "--":
                i += 1
                break
            if name == "env" and (arg in ("-S", "--split-string") or arg.startswith("--split-string=")):
                script = arg.split("=", 1)[1] if "=" in arg else (rest[i + 1] if i + 1 < len(rest) else "")
                check_command(script, ctx, depth + 1)
                return [], via
            i += 2 if arg in WRAPPERS[name] else 1
        rest = rest[i:]
        if name == "timeout" and rest:
            rest = rest[1:]  # the duration
        if name == "watch":
            check_command(" ".join(rest), ctx, depth + 1)
            return [], via
        if name == "env" and not rest:
            block("env without a command prints the environment, which can include secrets.")
        words = rest
    return words, via


def check_segment(words, redirects, bodies, ctx, depth):
    for op, target in redirects:
        if "<<<" in op:
            if SECRET_VAR.search(target):
                block("printing secret variables leaks them into the transcript.")
            continue
        if "<<" in op or not target or target.isdigit() or target == "-":
            continue
        if ">" in op:
            check_write_target(target, ctx)
        elif is_secret_path(target, ctx.cwd):
            block(f"{target} holds secrets; don't read or print it. Use .env.example for the key names.")

    words, via = unwrap(words, ctx, depth)
    if not words:
        return
    if "$" in words[0] or "`" in words[0]:
        block("the program name comes from a variable or substitution, so it can't be checked.")
    prog = words[0].rsplit("/", 1)[-1]
    args = words[1:]

    if prog == "cd":
        target = args[0] if args else "~"
        path = os.path.expanduser(target)
        ctx.cwd = os.path.normpath(path if os.path.isabs(path) else os.path.join(ctx.cwd, path))
        return
    if prog == "eval":
        check_command(" ".join(args), ctx, depth + 1)
        return
    if prog in SHELLS:
        check_shell(args, bodies, ctx, depth)
    if INTERPRETER.match(prog):
        check_interpreter(prog, args, bodies)

    check_aws(prog, args)
    check_sam(prog, args, ctx, depth)
    check_iac(prog, args)
    check_http(prog, args, ctx)
    check_git(prog, args, ctx)
    check_delete(prog, args, via, ctx)
    check_find(prog, args, bodies, ctx, depth)
    check_writes(prog, args, ctx)
    check_secrets(prog, args, ctx)
    check_env_dump(prog, args)
    check_outward(prog, args)


# ---------------------------------------------------------------------------
# Shells and interpreters
# ---------------------------------------------------------------------------
def check_shell(args, bodies, ctx, depth):
    i = 0
    while i < len(args):
        arg = args[i]
        if arg.startswith("-") and not arg.startswith("--") and "c" in arg[1:]:
            check_command(args[i + 1] if i + 1 < len(args) else "", ctx, depth + 1)
            return
        if arg in ("-o", "+o", "--rcfile", "--init-file"):
            i += 2
            continue
        if not arg.startswith(("-", "+")):
            return  # a script file: covered by the permission prompt, not inspected here
        i += 1
    # No script: the shell reads stdin, usually a heredoc.
    for body, _ in bodies:
        check_command(body, ctx, depth + 1)


def check_interpreter(prog, args, bodies):
    code, script = [], None
    i = 0
    while i < len(args):
        arg = args[i]
        if arg in INLINE_FLAGS or (prog in ("perl", "ruby") and re.match(r"^-[a-zA-Z]*[eE]$", arg)):
            if i + 1 < len(args):
                code.append(args[i + 1])
            i += 2
            continue
        if arg.startswith(("--eval=", "--print=")):
            code.append(arg.split("=", 1)[1])
        elif not arg.startswith("-") and script is None and not code:
            script = arg
        i += 1
    if prog == "deno" and args[:1] == ["eval"]:
        code.append(" ".join(args[1:]))
    if not code and script in (None, "-"):
        code = [body for body, _ in bodies]
    for text in code:
        for pattern, reason in INLINE_DANGERS:
            if pattern.search(text):
                block(reason)
        if PROTECTED_FRAGMENT.search(text) and WRITE_CALL.search(text):
            block("inline code that writes to the guard rails, .git/, the lockfile or samconfig.toml.")


# ---------------------------------------------------------------------------
# AWS and infrastructure
# ---------------------------------------------------------------------------
def check_aws(prog, args):
    if prog != "aws":
        return
    blocked = next((a for a in args if a.split("=", 1)[0] in AWS_BLOCKED_OPTS), None)
    if blocked:
        block(f"aws {blocked.split('=', 1)[0]} is not allowed (it can reach other hosts or public buckets).")
    i = 0
    while i < len(args) and args[i].startswith("-"):
        arg = args[i]
        name = arg.split("=", 1)[0]
        if name in AWS_FLAGS:
            i += 1
        elif name in AWS_VALUE_OPTS:
            i += 1 if "=" in arg else 2
        else:
            block(f"unknown aws option {arg} before the command; put options after the service and command.")
    rest = args[i:]
    if not rest or rest[0] == "help":
        return
    service, verb = rest[0], (rest[1] if len(rest) > 1 else "")
    if verb == "help" or (service, verb) == ("sts", "get-caller-identity"):
        return
    if service == "configure":
        block("aws configure reads or changes credentials.")
    if not AWS_READ_VERB.match(verb):
        block(f"`aws {service} {verb}` can change live AWS resources (only read commands are allowed).")
    if (service, verb) in AWS_FILE_OUTPUT:
        block(f"`aws {service} {verb}` writes its result to a local file; ask the user to run it.")
    secret_flag = any(a.startswith(("--with-decryption", "--include-value")) for a in rest)
    if (service, verb) in AWS_SECRET_READS or secret_flag:
        block(f"`aws {service} {verb}` prints secrets or credentials into the transcript.")


def check_sam(prog, args, ctx, depth):
    if prog != "sam":
        return
    sub = next((a for a in args if not a.startswith("-")), "")
    if sub in ("delete", "sync"):
        block(f"`sam {sub}` changes or deletes the deployed stack directly.")
    if sub == "remote":
        block("`sam remote` invokes the deployed functions, which can write to the live app.")
    if sub in ("package", "publish", "pipeline"):
        block(f"`sam {sub}` uploads to or creates AWS resources.")
    if sub == "deploy":
        names = {a.split("=", 1)[0] for a in args}
        if names & {"--no-confirm-changeset", "--force-upload", "--config-file"}:
            block("deploys must show the changeset for review (no --no-confirm-changeset, --force-upload or --config-file).")
        if "--no-execute-changeset" not in names:
            block("`sam deploy` must only create a changeset (--no-execute-changeset); the user executes it. See the safe-deploy skill.")
        if depth > 0:
            block("run `sam deploy` as a plain command, so the approval prompt shows exactly what runs.")
        ctx.deploy = True


def check_iac(prog, args):
    sub = next((a for a in args if not a.startswith("-")), "")
    if prog == "cdk" and sub in ("deploy", "destroy", "bootstrap"):
        block(f"cdk {sub} changes live infrastructure.")
    if prog == "terraform" and sub in ("apply", "destroy", "import", "state", "taint", "untaint", "force-unlock"):
        block(f"terraform {sub} changes live infrastructure or its state.")
    if prog == "pulumi" and sub in ("up", "update", "destroy", "refresh", "import", "state", "cancel"):
        block(f"pulumi {sub} changes live infrastructure or its state.")


# ---------------------------------------------------------------------------
# Live Tadabase API
# ---------------------------------------------------------------------------
def check_http(prog, args, ctx):
    if prog not in HTTP_CLIENTS:
        return
    # A URL hidden in a variable could be the Tadabase API, so treat it like one.
    if "tadabase" not in ctx.full_lower and not any("$" in a for a in args):
        return
    reason = "this can write to the live Tadabase app (only plain GET is allowed). Tests and local runs use the memory adapter."

    def method_ok(method):
        if method.upper() not in READ_METHODS:
            block(reason)

    if prog in ("curl", "curlie"):
        for i, arg in enumerate(args):
            nxt = args[i + 1] if i + 1 < len(args) else ""
            if arg.startswith("--"):
                name, _, value = arg.partition("=")
                if name == "--request":
                    method_ok(value or nxt)
                elif name.startswith(("--data", "--form", "--json", "--upload-file", "--config")) or name == "--url-query":
                    block(reason)
            elif arg.startswith("-") and len(arg) > 1:
                for j, c in enumerate(arg[1:], start=1):
                    if c in "dFTK":
                        block(reason)
                    if c == "X":
                        method_ok(arg[j + 1:] or nxt)
                        break
                    if c in CURL_VALUE_SHORT:
                        break
    elif prog == "wget":
        for i, arg in enumerate(args):
            name, _, value = arg.partition("=")
            if name in ("--post-data", "--post-file", "--body-data", "--body-file", "-e", "--execute"):
                block(reason)
            if name == "--method":
                method_ok(value or (args[i + 1] if i + 1 < len(args) else ""))
    else:  # HTTPie / xh: `http [METHOD] URL [items]`
        if any(a in ("-f", "--form", "--raw", "--multipart") for a in args):
            block(reason)
        positional = [a for a in args if not a.startswith("-")]
        if positional and positional[0].upper() in READ_METHODS | {"POST", "PUT", "PATCH", "DELETE", "OPTIONS"}:
            method_ok(positional[0])
            items = positional[2:]
        else:
            items = positional[1:]
        for item in items:
            # a=b, a:=b, a@file send a body (and imply POST); a==b is a query param, H:v a header.
            if "==" not in item and re.match(r"^[^:=@]*(=|:=|@)", item):
                block(reason)


# ---------------------------------------------------------------------------
# Git
# ---------------------------------------------------------------------------
def short_cluster_has(arg, letters, value_letters=""):
    """True if a short-option cluster like -fu contains one of letters (stopping at a value-taking letter)."""
    if not arg.startswith("-") or arg.startswith("--") or len(arg) < 2:
        return False
    for c in arg[1:]:
        if c in letters:
            return True
        if c in value_letters:
            return False
    return False


def check_git(prog, args, ctx):
    if prog != "git":
        return
    i = 0
    while i < len(args) and args[i].startswith("-"):
        arg = args[i]
        value = None
        if arg in ("-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"):
            value = args[i + 1] if i + 1 < len(args) else ""
            i += 2
        else:
            if arg.startswith("-c") and len(arg) > 2:
                value = arg[2:]
                arg = "-c"
            elif "=" in arg:
                arg, value = arg.split("=", 1)
            i += 1
        if arg == "--config-env":
            block("git --config-env can run commands or switch off the hooks.")
        if arg == "-c" and value is not None and not SAFE_GIT_CONFIG.match(value):
            block(f"git -c {value.split('=', 1)[0]} can run commands or switch off the hooks.")
    sub = args[i] if i < len(args) else ""
    rest = args[i + 1:]

    if "--no-verify" in args:
        block("git hooks (secret scan, lint, tests) must not be skipped or changed.")
    if sub == "commit" and any(short_cluster_has(a, "n", "mFcCt") for a in skip_values(rest, {"-m", "-F", "-c", "-C", "-t", "--author", "--date", "--template", "--fixup", "--squash", "--trailer"})):
        block("git commit -n skips the git hooks (secret scan, lint, tests).")
    if sub == "config":
        check_git_config(rest)
    if sub == "push":
        if any(a in ("--mirror", "--delete", "--prune") or a.startswith("--force") or short_cluster_has(a, "fd", "o")
               for a in rest) or any(a.startswith(("+", ":")) for a in rest if not a.startswith("-")):
            block("force pushes and remote branch deletes rewrite or remove shared history.")
    if sub == "reset" and ("--hard" in rest or "--merge" in rest):
        block("git reset --hard throws away uncommitted work.")
    if sub == "clean" and any(a == "--force" or short_cluster_has(a, "f", "eX") for a in rest):
        block("git clean -f deletes untracked files for good.")
    if sub == "checkout":
        check_git_checkout(rest, ctx)
    if sub == "switch" and any(a in ("--force", "--discard-changes") or short_cluster_has(a, "f", "cC") for a in rest):
        block("git switch --discard-changes / -f discards uncommitted changes.")
    if sub == "restore":
        staged = any(a == "--staged" or short_cluster_has(a, "S", "s") for a in rest)
        worktree = any(a == "--worktree" or short_cluster_has(a, "W", "s") for a in rest)
        if worktree or not staged:
            block("git restore on the working tree discards uncommitted changes.")
    if sub == "rm" and any(a == "--force" or short_cluster_has(a, "f") for a in rest):
        block("git rm -f deletes files with uncommitted changes.")
    if sub == "branch" and any(a in ("--delete", "--force") or short_cluster_has(a, "dDfM", "tu") for a in rest):
        block("deleting or force-moving branches can lose unmerged work.")
    if sub == "stash" and any(a in ("drop", "clear") for a in rest):
        block("git stash drop/clear deletes stashed work.")
    if sub == "worktree" and rest[:1] == ["remove"] and any(a == "--force" or short_cluster_has(a, "f") for a in rest):
        block("git worktree remove --force deletes uncommitted work.")
    if sub in ("filter-branch", "filter-repo", "update-ref", "replace") or (sub == "reflog" and rest[:1] not in ([], ["show"])):
        block(f"git {sub} rewrites history.")
    if sub == "gc" and any(a.startswith("--prune") for a in rest):
        block("git gc --prune deletes unreachable commits that could still be recovered.")
    if sub.startswith("credential"):
        block("git credential prints stored credentials.")
    if sub in ("diff", "log", "show", "range-diff", "whatchanged") and any(a == "--output" or a.startswith("--output=") for a in rest):
        block("git --output writes files without a prompt; redirect with > instead.")


def skip_values(args, value_opts):
    """Drop the values of options that take one, so a message like `-m -n` isn't read as a flag."""
    out, skip = [], False
    for a in args:
        if skip:
            skip = False
            continue
        if a in value_opts:
            skip = True
            continue
        out.append(a)
    return out


def check_git_config(rest):
    flags = [a for a in rest if a.startswith("-")]
    positional = [a for a in rest if not a.startswith("-")]
    if positional[:1] in (["get"], ["list"]) or any(f.startswith(("--get", "--list", "-l", "--show")) for f in flags):
        return
    if positional[:1] in (["set"], ["unset"]):
        positional = positional[1:]
    writes = len(positional) >= 2 or any(f.startswith(("--unset", "--add", "--replace", "--rename", "--remove", "--edit", "-e")) for f in flags)
    if writes and positional and DANGEROUS_GIT_CONFIG.search(positional[0]):
        block(f"git config {positional[0]} can run commands or switch off the hooks (secret scan, lint, tests).")


def check_git_checkout(rest, ctx):
    if any(a in ("--force", "--ours", "--theirs", "--", ".") or short_cluster_has(a, "f", "bB") for a in rest):
        block("git checkout on paths discards uncommitted changes.")
    if any(a in ("-b", "-B", "--orphan", "--detach") for a in rest):
        return
    positional = [a for a in rest if not a.startswith("-")]
    if len(positional) >= 2 or any(os.path.exists(os.path.join(ctx.cwd, p)) for p in positional):
        block("git checkout on paths discards uncommitted changes.")


# ---------------------------------------------------------------------------
# Deleting and writing files
# ---------------------------------------------------------------------------
def removable(target, cwd):
    if ".." in target.split("/") or any(c in target for c in "*?["):
        return False
    path = os.path.normpath(os.path.join(cwd, os.path.expanduser(target)))
    return os.path.basename(path) in REBUILDABLE or path.startswith(SCRATCH_PREFIXES)


def check_delete(prog, args, via, ctx):
    if prog in DELETERS and "xargs" in via:
        block(f"xargs {prog} deletes files the hook can't see.")
    if prog == "rm":
        recursive = any(a == "--recursive" or short_cluster_has(a, "rR") for a in args)
        targets = [a for a in args if not a.startswith("-")]
        if recursive:
            bad = [t for t in targets if not removable(t, ctx.cwd)]
            if bad or not targets:
                block(f"rm -r is only allowed on build output ({', '.join(sorted(REBUILDABLE))}) and the scratchpad; "
                      f"not on: {' '.join(bad) or '(no target)'}.")
    if prog == "rsync" and any(a.startswith(("--delete", "--remove-source-files")) for a in args):
        block("rsync --delete removes files at the destination.")


def check_find(prog, args, bodies, ctx, depth):
    if prog != "find":
        return
    if "-delete" in args:
        block("find -delete can delete many files at once.")
    for i, arg in enumerate(args):
        if arg in ("-exec", "-execdir", "-ok", "-okdir"):
            sub = [a for a in args[i + 1:] if a != "+"]
            if sub and sub[0].rsplit("/", 1)[-1] in DELETERS | {"mv", "truncate"}:
                block("find -exec rm can delete many files at once.")
            check_segment(sub, [], bodies, ctx, depth + 1)


def write_targets(prog, args):
    positional = [a for a in args if not a.startswith("-")]
    if prog == "tee":
        return positional
    if prog in ("sed", "gsed") and any(a.startswith("--in-place") or short_cluster_has(a, "i", "ef") for a in args):
        return positional
    if prog == "perl" and any(short_cluster_has(a, "i", "eE") for a in args):
        return positional
    if prog in ("cp", "install", "ln", "rsync", "scp", "ditto"):
        return positional[-1:]
    if prog in ("mv", "truncate", "chmod", "chown", "chgrp", "chflags", "xattr") or prog in DELETERS:
        return positional
    if prog == "dd":
        return [a[3:] for a in args if a.startswith("of=")]
    if prog in ("curl", "wget"):
        out = []
        for i, a in enumerate(args):
            if a in ("-o", "--output", "-O", "--output-document") and i + 1 < len(args) and not (prog == "curl" and a == "-O"):
                out.append(args[i + 1])
            elif a.startswith(("--output=", "--output-document=")):
                out.append(a.split("=", 1)[1])
        return out
    return []


def check_write_target(target, ctx):
    if target == "/dev/null":
        return
    if is_protected_path(target, ctx.cwd):
        block(f"{target} is part of the guard rails (hooks, settings, git hooks, verify, secret scan, test setup); "
              "change it with the edit tools so the user approves it.")
    if is_git_internal(target, ctx.cwd):
        block("git internals are managed by git, not edited by hand.")
    name = os.path.basename(target).lower()
    if name == "package-lock.json":
        block("change dependencies with npm install, not by editing the lockfile.")
    if name == "samconfig.toml":
        block("edit samconfig.toml with the edit tools, so the changeset check can see the change.")
    if is_secret_path(target, ctx.cwd):
        block(f"{target} holds secrets; don't write it.")


def check_writes(prog, args, ctx):
    for target in write_targets(prog, args):
        check_write_target(target, ctx)


# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------
def check_secrets(prog, args, ctx):
    if prog in ("ls", "test", "[", "stat"):
        return
    if prog == "git":
        sub = next((a for a in args if not a.startswith("-")), "")
        if sub in ("status", "check-ignore", "ls-files") or (sub == "rm" and "--cached" in args):
            return
    for arg in args:
        for cand in [arg] + re.split(r"[=:,]", arg)[1:]:
            if is_secret_path(cand, ctx.cwd):
                block(f"{cand} holds secrets; don't read or print it. Use .env.example for the key names.")
    if prog in ("grep", "egrep", "fgrep") and any(a in ("-r", "-R", "--recursive") or short_cluster_has(a, "rR", "eEfABCm") for a in args):
        if not any(a.startswith("--exclude") and "env" in a for a in args):
            dirs = [a for a in args[1:] if not a.startswith("-") and os.path.isdir(os.path.join(ctx.cwd, os.path.expanduser(a)))] or ["."]
            for d in dirs:
                full = os.path.join(ctx.cwd, os.path.expanduser(d))
                try:
                    names = os.listdir(full)
                except OSError:
                    continue
                if any(is_secret_path(os.path.join(full, n), ctx.cwd) for n in names):
                    block(f"a recursive grep of {d} would read secret files; add --exclude='.env*' (or use rg, which skips ignored files).")
    if prog in ("rg", "ag") and any(a in ("-uu", "-uuu", "--no-ignore", "--unrestricted") for a in args):
        block(f"{prog} without ignore rules reads secret files such as .env.")


def check_env_dump(prog, args):
    reason = "dumping the environment can print secrets."
    if prog == "printenv":
        block(reason)
    if prog == "set" and not args:
        block(reason)
    if prog in ("export", "declare", "typeset", "readonly") and not any(not a.startswith("-") for a in args):
        block(reason)
    if prog == "compgen" and any(a in ("-v", "-e") for a in args):
        block(reason)
    if prog == "ps" and any((not a.startswith("-") and "e" in a) or short_cluster_has(a, "E") for a in args):
        block(reason)
    if prog in ("echo", "printf", "print") and SECRET_VAR.search(" ".join(args)):
        block("printing secret variables leaks them into the transcript.")


# ---------------------------------------------------------------------------
# Outward-facing
# ---------------------------------------------------------------------------
def check_outward(prog, args):
    sub = args[:1]
    if prog == "npm" and sub and sub[0] in ("publish", "unpublish", "deprecate", "dist-tag", "owner", "token", "access"):
        block(f"npm {sub[0]} is outward-facing or prints tokens.")
    if prog == "npm" and any("_auth" in a.lower() for a in args):
        block("npm auth settings hold tokens.")
    if prog != "gh":
        return
    pair = args[:2]
    if pair in (["repo", "delete"], ["repo", "edit"], ["repo", "archive"], ["repo", "rename"], ["release", "delete"],
                ["auth", "token"], ["variable", "set"], ["variable", "delete"]) or args[:1] == ["secret"]:
        block(f"gh {' '.join(pair)} changes the GitHub repo or prints a token.")
    if pair == ["auth", "status"] and any(a in ("-t", "--show-token") for a in args):
        block("gh auth status --show-token prints a token.")
    if args[:1] == ["api"]:
        positional = [a for a in args[1:] if not a.startswith("-")]
        if positional[:1] == ["graphql"]:
            if "mutation" in " ".join(args).lower():
                block("gh api graphql mutations change GitHub data.")
            return
        method = None
        for i, a in enumerate(args):
            if a in ("-X", "--method") and i + 1 < len(args):
                method = args[i + 1].upper()
            elif a.startswith("--method="):
                method = a.split("=", 1)[1].upper()
            elif a.startswith("-X") and len(a) > 2:
                method = a[2:].upper()
        has_fields = any(a in ("-f", "-F", "--field", "--raw-field", "--input") or a.startswith(("--field=", "--raw-field=", "--input=")) for a in args)
        if (method and method not in READ_METHODS) or (has_fields and method != "GET"):
            block("gh api writes change GitHub data.")


# ---------------------------------------------------------------------------
def main():
    data = json.load(sys.stdin)
    command = (data.get("tool_input") or {}).get("command") or ""
    ctx = Context(command, data.get("cwd") or os.getcwd())
    try:
        if re.search(r"FIELDFLOW_ALLOW_LIVE_WRITES\s*=\s*['\"]?[^\s'\"0]", command):
            block("FIELDFLOW_ALLOW_LIVE_WRITES turns on writes to the live Tadabase app.")
        if re.search(r"\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(\S*/)?((ba|z|da|k)?sh|python[0-9.]*|node|perl|ruby)\b", command):
            block("piping a download into a shell runs unreviewed code.")
        check_command(command, ctx)
        if ctx.deploy and ctx.segments > 1:
            block("run `sam deploy` on its own, so the approval prompt shows exactly what runs.")
    except Blocked as err:
        print(f"Blocked: {err} Ask the user to run it themselves if it's really needed.", file=sys.stderr)
        sys.exit(2)
    if ctx.deploy:
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "ask",
                "permissionDecisionReason": "`sam deploy` creates a changeset in live AWS. Approve only as part of the safe-deploy skill.",
            }
        }))
    sys.exit(0)


try:
    main()
except SystemExit:
    raise
except Exception as err:  # fail closed: an unchecked command must not run
    print(f"Blocked: the guard hook crashed ({err!r}), so the command wasn't checked. Ask the user to run it.", file=sys.stderr)
    sys.exit(2)
