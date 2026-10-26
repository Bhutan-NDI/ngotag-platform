#!/usr/bin/env bash

# Exercises run-migration.sh against a fake aws command.

set -euo pipefail

script=$(pwd)/.github/scripts/run-migration.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

cat > "$work/bin/aws" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
state=$FAKE_STATE
echo "$*" >> "$state/calls"
arg() { local key=$1; shift; while [ "$#" -gt 0 ]; do [ "$1" = "$key" ] && { echo "$2"; return; }; shift; done; }
case "$2" in
  list-tasks) echo "${FAKE_RUNNING_MIGRATIONS:-0}" ;;
  describe-services)
    service=$(arg --services "$@")
    count=2
    if [ "$service" = seed ] || { [ "$service" = gateway-service ] && [ -z "${FAKE_GATEWAY_RUNNING:-}" ]; }; then count=0; fi
    jq -n --argjson count "$count" '{status: "ACTIVE", desiredCount: $count, runningCount: $count, pendingCount: 0,
      taskDefinition: "arn:aws:ecs:region:account:task-definition/GATEWAY_TDF:4",
      networkConfiguration: {awsvpcConfiguration: {subnets: ["subnet-1"], securityGroups: ["sg-1"], assignPublicIp: "DISABLED"}}}'
    ;;
  describe-task-definition)
    jq -n '{taskDefinitionArn: "arn", revision: 4, family: "GATEWAY_TDF", executionRoleArn: "execution-role",
      containerDefinitions: [{name: "gateway", image: "old", healthCheck: {command: ["CMD", "true"]}}]}'
    ;;
  register-task-definition)
    file=$(arg --cli-input-json "$@"); cp "${file#file://}" "$state/registered.json"
    echo "arn:aws:ecs:region:account:task-definition/MIGRATION_TDF:9"
    ;;
  run-task)
    arg --overrides "$@" > "$state/overrides.json"
    arg --network-configuration "$@" > "$state/network.json"
    arg --launch-type "$@" > "$state/launch-type"
    jq -n '{failures: [], tasks: [{taskArn: "arn:aws:ecs:region:account:task/cluster/abc"}]}'
    ;;
  describe-tasks)
    polls=$(( $(cat "$state/polls" 2>/dev/null || echo 0) + 1 )); echo "$polls" > "$state/polls"
    status=RUNNING; [ "$polls" -ge 2 ] && status=STOPPED
    jq -n --arg status "$status" --argjson code "${FAKE_EXIT_CODE:-0}" \
      '{lastStatus: $status, containers: [{name: "gateway", exitCode: $code}]}'
    ;;
  *) echo "unexpected aws call: $*" >&2; exit 1 ;;
esac
FAKE
chmod +x "$work/bin/aws"

jq -n '[
  {name: "user", service: "user-service", container: "user", task_definition_family: "USER_TDF",
   image: "registry/repo:platform-user-aaaaaaaaaaaa", image_digest: "sha256:x"},
  {name: "api-gateway", service: "gateway-service", container: "gateway", task_definition_family: "GATEWAY_TDF",
   image: "registry/repo:platform-api-gateway-aaaaaaaaaaaa", image_digest: "sha256:y"}
]' > "$work/release.json"
printf '["gateway-service", "seed"]\n' > "$work/writers.json"

run() {
  rm -rf "$work/state" && mkdir -p "$work/state"
  PATH="$work/bin:$PATH" FAKE_STATE="$work/state" CLUSTER=cluster RELEASE_FILE="$work/release.json" \
    MIGRATION_SERVICE=api-gateway MIGRATION_FAMILY=MIGRATION_TDF WRITERS_FILE="$work/writers.json" \
    COMMAND="cd libs/prisma-service && npx prisma migrate status" CPU_ARCHITECTURE=ARM64 POLL_SECONDS=0 \
    "$@" bash "$script"
}

fail() { echo "$1" >&2; exit 1; }

# The status check runs from the release image, without touching the writers.
run env MODE=status FAKE_GATEWAY_RUNNING=1 > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "status check failed"; }
grep -q 'schema is up to date' "$work/out" || fail "status success was not reported"
jq -e '.family == "MIGRATION_TDF" and .runtimePlatform.cpuArchitecture == "ARM64"
  and .containerDefinitions[0].image == "registry/repo:platform-api-gateway-aaaaaaaaaaaa"
  and (.containerDefinitions[0] | has("healthCheck") | not) and .executionRoleArn == "execution-role"' \
  "$work/state/registered.json" >/dev/null || fail "unexpected migration task definition"
jq -e '.containerOverrides == [{name: "gateway", command: ["sh", "-ec", "cd libs/prisma-service && npx prisma migrate status"]}]' \
  "$work/state/overrides.json" >/dev/null || fail "unexpected command override"
jq -e '.awsvpcConfiguration.subnets == ["subnet-1"]' "$work/state/network.json" >/dev/null || fail "network not copied"
test "$(cat "$work/state/launch-type")" = FARGATE || fail "migration did not run on on-demand Fargate"

# A behind schema stops the release.
if run env MODE=status FAKE_EXIT_CODE=1 > "$work/out" 2>&1; then fail "a pending migration was accepted"; fi
grep -q 'MIGRATE=true' "$work/out" || fail "pending migration guidance was not reported"

# Applying migrations requires stopped writers and fails closed.
run env MODE=deploy > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "migration failed"; }
grep -q 'Migrations applied' "$work/out" || fail "migration success was not reported"
if run env MODE=deploy FAKE_GATEWAY_RUNNING=1 > "$work/out" 2>&1; then fail "migration ran with a running writer"; fi
grep -q 'run-task\|register-task-definition' "$work/state/calls" && fail "a task started with a running writer"
if run env MODE=deploy FAKE_EXIT_CODE=1 > "$work/out" 2>&1; then fail "a failed migration was accepted"; fi
grep -q 'MIGRATION FAILED' "$work/out" || fail "failed migration was not reported"
if run env MODE=deploy FAKE_RUNNING_MIGRATIONS=1 > "$work/out" 2>&1; then fail "a second migration task was started"; fi
grep -q 'run-task' "$work/state/calls" && fail "a task started while another migration ran"
if run env MODE=other > "$work/out" 2>&1; then fail "an unknown mode was accepted"; fi

echo "run-migration: all tests passed"
