#!/usr/bin/env bash

# Exercises record-deployment.sh against a fake gh command.

set -euo pipefail

script=$(pwd)/.github/scripts/record-deployment.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

cat > "$work/bin/gh" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
if [[ " $* " == *" --method PUT "* ]]; then
  args=("$@")
  for ((i = 0; i < ${#args[@]}; i++)); do
    case "${args[i]}" in
      -F) [[ "${args[i+1]}" == content=@* ]] && base64 --decode < "${args[i+1]#content=@}" > "$FAKE_STATE/written.json" ;;
      -f) [[ "${args[i+1]}" == message=* ]] && printf '%s\n' "${args[i+1]#message=}" > "$FAKE_STATE/message" ;;
    esac
  done
  exit 0
fi
jq -n --arg content "$(base64 -w0 < "$FAKE_STATE/remote.json")" '{sha: "abc", content: $content}'
FAKE
chmod +x "$work/bin/gh"

manifest='{"environment": "stage", "deployment": {"cluster": "c"}, "release": {"next_version": "1.0.0",
  "deployed": {"agent": {"version": "1.0.0-rc.1"}}}}'
printf '%s\n' "$manifest" > "$work/validated.json"

run() {
  mkdir -p "$work/state"; rm -f "$work/state/"*
  printf '%s\n' "${REMOTE:-$manifest}" > "$work/state/remote.json"
  PATH="$work/bin:$PATH" FAKE_STATE="$work/state" RUNNER_TEMP="$work" GH_TOKEN=x CONFIG_REPOSITORY=o/r \
    CONFIG_PATH=platform/environments/stage.json VALIDATED_MANIFEST="$work/validated.json" \
    DEPLOYED_RECORD="$work/record.json" ENVIRONMENT=stage "$@" bash "$script" > "$work/out" 2>&1
}

fail() { echo "$1" >&2; exit 1; }

# A service release is recorded under the service; other records are kept.
echo '{"github_release": "platform/user/v1.0.0-rc.1", "image_tag": "platform-user-aaaaaaaaaaaa"}' > "$work/record.json"
run env SERVICE=user || { cat "$work/out" >&2; fail "service record failed"; }
jq -e '.release.deployed.user.github_release == "platform/user/v1.0.0-rc.1" and .release.deployed.agent.version == "1.0.0-rc.1"' \
  "$work/state/written.json" >/dev/null || fail "service record not written next to the others"
grep -qx 'chore(platform): record stage user platform/user/v1.0.0-rc.1' "$work/state/message" || fail "unexpected service commit message"

# A migration has no GitHub Release; it is recorded under migrate and named by its image.
echo '{"image_tag": "platform-api-gateway-aaaaaaaaaaaa", "image_service": "api-gateway"}' > "$work/record.json"
run env SERVICE=migrate || { cat "$work/out" >&2; fail "migration record failed"; }
jq -e '.release.deployed.migrate.image_service == "api-gateway" and .release.deployed.agent.version == "1.0.0-rc.1"' \
  "$work/state/written.json" >/dev/null || fail "migration record not written"
grep -qx 'chore(platform): record stage migrate platform-api-gateway-aaaaaaaaaaaa' "$work/state/message" \
  || fail "unexpected migration commit message"

# A manifest changed after the operation started is never overwritten.
REMOTE='{"environment": "stage", "deployment": {"cluster": "other"}, "release": {"next_version": "1.0.0", "deployed": {}}}' \
  run env SERVICE=user && fail "a changed manifest was overwritten"
test ! -e "$work/state/written.json" || fail "a changed manifest was written"

echo "record-deployment: all tests passed"
