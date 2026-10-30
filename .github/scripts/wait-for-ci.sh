#!/bin/sh

# Waits for the CI check of the release contract on one commit. A check that is
# running (pending) is waited for up to PENDING_TIMEOUT seconds (default 45
# minutes: CI builds every service); a check that has not appeared at all is
# given MISSING_TIMEOUT seconds (default 10 minutes) to start.

set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <repository> <source-sha> <release-contract>" >&2
  exit 2
fi

repository=$1
source_sha=$2
contract=$3
state_filter=.github/scripts/select-ci-state.jq
wait_seconds=${WAIT_SECONDS:-5}
pending_timeout=${PENDING_TIMEOUT:-2700}
missing_timeout=${MISSING_TIMEOUT:-600}
# Transient GitHub API errors are retried; persistent ones (e.g. authentication)
# fail after this many consecutive failed requests.
max_api_failures=6
api_failures=0

test -f "$contract" || {
  echo "release contract does not exist: $contract" >&2
  exit 1
}
test -f "$state_filter" || {
  echo "CI state filter does not exist: $state_filter" >&2
  exit 1
}

check_name=$(jq -er '.ci.check_name // empty' "$contract")
app_slug=$(jq -er '.ci.app_slug // empty' "$contract")
started=$(date +%s)

while :; do
  # Slurp pages with jq rather than `gh api --slurp`, which needs gh 2.48+.
  if check_runs=$(gh api --paginate \
    "repos/${repository}/commits/${source_sha}/check-runs?per_page=100"); then
    api_failures=0
    state=$(printf '%s' "$check_runs" | jq -sr \
      --arg check_name "$check_name" \
      --arg app_slug "$app_slug" \
      -f "$state_filter")
  else
    api_failures=$((api_failures + 1))
    if [ "$api_failures" -ge "$max_api_failures" ]; then
      echo "GitHub API failed $api_failures consecutive times while checking CI for $source_sha" >&2
      exit 1
    fi
    echo "warning: GitHub API request failed; retrying ($api_failures/$max_api_failures)" >&2
    state=pending
  fi

  case "$state" in
    success)
      exit 0
      ;;
    failed:*)
      echo "CI did not pass for $source_sha ($state)" >&2
      exit 1
      ;;
    missing)
      if [ "$(($(date +%s) - started))" -ge "$missing_timeout" ]; then
        echo "$check_name never started for $source_sha" >&2
        exit 1
      fi
      ;;
    pending)
      if [ "$(($(date +%s) - started))" -ge "$pending_timeout" ]; then
        echo "timed out waiting for $check_name on $source_sha" >&2
        exit 1
      fi
      ;;
    *)
      echo "unexpected CI state for $source_sha: $state" >&2
      exit 1
      ;;
  esac

  sleep "$wait_seconds"
done
