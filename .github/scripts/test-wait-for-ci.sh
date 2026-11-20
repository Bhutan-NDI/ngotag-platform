#!/bin/sh

# Exercises wait-for-ci.sh against a fake gh command.

set -eu

script=.github/scripts/wait-for-ci.sh
contract=.github/platform-release-contract.json
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -p "$work/bin"

# FAKE_STATES lists the state of each poll (missing, pending, success, failure);
# the last one repeats.
cat > "$work/bin/gh" <<'FAKE'
#!/bin/sh
count=$(( $(cat "$FAKE_COUNT" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$FAKE_COUNT"
state=$(printf '%s\n' $FAKE_STATES | sed -n "${count}p")
[ -n "$state" ] || state=$(printf '%s\n' $FAKE_STATES | tail -n 1)
case "$state" in
  missing) echo '{"check_runs": []}' ;;
  pending) echo '{"check_runs": [{"name": "Validate", "app": {"slug": "github-actions"}, "started_at": "2026-01-01T00:00:00Z", "status": "in_progress", "conclusion": null}]}' ;;
  success) echo '{"check_runs": [{"name": "Validate", "app": {"slug": "github-actions"}, "started_at": "2026-01-01T00:00:00Z", "status": "completed", "conclusion": "success"}]}' ;;
  failure) echo '{"check_runs": [{"name": "Validate", "app": {"slug": "github-actions"}, "started_at": "2026-01-01T00:00:00Z", "status": "completed", "conclusion": "failure"}]}' ;;
esac
FAKE
chmod +x "$work/bin/gh"

run() {
  rm -f "$work/count"
  PATH="$work/bin:$PATH" FAKE_COUNT="$work/count" WAIT_SECONDS=0 FAKE_STATES="$1" \
    PENDING_TIMEOUT="${2:-60}" MISSING_TIMEOUT="${3:-60}" \
    sh "$script" Bhutan-NDI/ngotag-platform aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa "$contract" > "$work/out" 2>&1
}

fail() { echo "$1" >&2; exit 1; }

run "missing pending pending success" || fail "a check that passes after running was rejected"
run "failure" && fail "a failed check was accepted"
grep -q 'did not pass' "$work/out" || fail "a failed check was not reported"
run "missing" 60 0 && fail "a check that never starts was waited for forever"
grep -q 'never started' "$work/out" || fail "a missing check was not reported"
run "pending" 0 60 && fail "a running check was waited for past the pending timeout"
grep -q 'timed out waiting' "$work/out" || fail "a pending timeout was not reported"
# A check that is running is not held to the shorter missing timeout.
run "pending pending success" 60 0 || fail "the missing timeout was applied to a running check"

echo "wait-for-ci: all tests passed"
