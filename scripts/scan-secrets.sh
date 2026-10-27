#!/usr/bin/env bash
# Scan for committed secrets. With --staged (the pre-commit hook) it checks the staged diff;
# otherwise it checks every tracked file plus untracked files that aren't ignored (so it means
# something before the first commit too). Exits 1 and lists the hits, with the values masked.
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 1

patterns=(
  '(AKIA|ASIA)[0-9A-Z]{16}'                                       # AWS access key id (long-term / temporary)
  'aws_secret_access_key["'"'"']?[[:space:]]*[=:][[:space:]]*["'"'"']?[A-Za-z0-9/+]{40}' # AWS secret key (40 chars)
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'                            # private keys
  'X-Tadabase-App-(Key|Secret)["'"'"']?[[:space:]]*[:=,][[:space:]]*["'"'"'][A-Za-z0-9]{12,}'
  # key = value, quoted or not: TADABASE_APP_SECRET=..., "apiKey": "...", TadabaseAppKey: ...
  '(secret|api[_-]?key|app[_-]?key|access[_-]?key|token|password|passwd)[A-Za-z0-9_]*["'"'"'`]?[[:space:]]*[:=][[:space:]]*["'"'"'`]?[A-Za-z0-9/+_=-]{20,}'
  '(sk|rk)_live_[0-9A-Za-z]{10,}'                                 # Stripe live keys
  'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}'       # GitHub tokens
  'npm_[A-Za-z0-9]{36}'                                           # npm tokens
  'xox[abposr]-[A-Za-z0-9-]{10,}'                                 # Slack tokens
  'AIza[0-9A-Za-z_-]{35}'                                         # Google API keys
  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' # JWTs
)
regex="$(IFS='|'; echo "${patterns[*]}")"
env_files='(^|/)(\.env(\..+)?|\.envrc|env\.json|locals\.json)$'
status=0

# Print file:line, then the line with long secret-looking runs cut to their first 4 characters.
mask() {
  local line pre rest
  while IFS= read -r line; do
    if [[ "$line" =~ ^([^:]+:[0-9]+:)(.*)$ ]]; then pre="${BASH_REMATCH[1]}"; rest="${BASH_REMATCH[2]}"; else pre=""; rest="$line"; fi
    printf '%s%s\n' "$pre" "$(printf '%s' "$rest" | sed -E 's/([A-Za-z0-9/+_=-]{4})[A-Za-z0-9/+_=-]{8,}/\1…/g')" | cut -c1-160
  done
}

if [ "${1:-}" = "--staged" ]; then
  # Never commit an env file, whatever it contains.
  envs="$(git diff --cached --name-only --diff-filter=ACMR | grep -Ei "$env_files" | grep -vi '\.env\.example$')"
  if [ -n "$envs" ]; then
    echo "Secret scan: env files are staged:" >&2; echo "$envs" >&2; status=1
  fi
  hits="$(git diff --cached -U0 --diff-filter=ACMR -- . ':!scripts/scan-secrets.sh' | grep -E '^\+' | grep -v '^+++' | grep -Ei -- "$regex")"
else
  hits="$(git ls-files -z -co --exclude-standard -- . ':!scripts/scan-secrets.sh' | xargs -0 grep -HnIEis -- "$regex")"
fi

if [ -n "$hits" ]; then
  echo "Secret scan: possible secrets found (values masked):" >&2
  printf '%s\n' "$hits" | mask >&2
  status=1
fi
[ $status -eq 0 ] && echo "Secret scan: clean"
exit $status
