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
    td=$(arg --task-definition "$@")
    if [ "$td" = MIGRATION_TDF ]; then
      [ -f "$state/registered.json" ] || { echo "An error occurred (ClientException)" >&2; exit 254; }
      jq '. + {taskDefinitionArn: "arn:aws:ecs:region:account:task-definition/MIGRATION_TDF:9", revision: 9,
        status: "ACTIVE", registeredAt: "now"}' "$state/registered.json"
    else
      jq -n '{taskDefinitionArn: "arn", revision: 4, family: "GATEWAY_TDF", executionRoleArn: "execution-role",
        containerDefinitions: [{name: "gateway", image: "old", healthCheck: {command: ["CMD", "true"]}}]}'
    fi
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
    if [ "${FAKE_EXIT_CODE:-0}" = none ]; then
      jq -n --arg status "$status" '{lastStatus: $status, stopCode: "TaskFailedToStart", containers: [{name: "gateway"}]}'
    else
      jq -n --arg status "$status" --argjson code "${FAKE_EXIT_CODE:-0}" \
        '{lastStatus: $status, containers: [{name: "gateway", exitCode: $code}]}'
    fi
    ;;
  *) echo "unexpected aws call: $*" >&2; exit 1 ;;
esac
FAKE
chmod +x "$work/bin/aws"

jq -n '{name: "api-gateway", service: "gateway-service", container: "gateway", task_definition_family: "GATEWAY_TDF"}' \
  > "$work/template.json"
printf '["gateway-service", "seed"]\n' > "$work/writers.json"

run() {
  rm -rf "$work/state" && mkdir -p "$work/state"
  run_again "$@"
}

# Keeps the fake AWS state of the previous run.
run_again() {
  rm -f "$work/state/calls" "$work/state/polls"
  PATH="$work/bin:$PATH" FAKE_STATE="$work/state" CLUSTER=cluster IMAGE=registry/repo:platform-user-aaaaaaaaaaaa \
    TEMPLATE_FILE="$work/template.json" MIGRATION_FAMILY=MIGRATION_TDF WRITERS_FILE="$work/writers.json" \
    COMMAND="cd libs/prisma-service && npx prisma migrate status" CPU_ARCHITECTURE=ARM64 POLL_SECONDS=0 \
    "$@" bash "$script"
}

fail() { echo "$1" >&2; exit 1; }

# The status check runs the released image in the template's task, without touching the writers.
run env MODE=status FAKE_GATEWAY_RUNNING=1 > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "status check failed"; }
grep -q 'schema is up to date' "$work/out" || fail "status success was not reported"
jq -e '.family == "MIGRATION_TDF" and .runtimePlatform.cpuArchitecture == "ARM64"
  and .containerDefinitions[0].image == "registry/repo:platform-user-aaaaaaaaaaaa"
  and (.containerDefinitions[0] | has("healthCheck") | not) and .executionRoleArn == "execution-role"' \
  "$work/state/registered.json" >/dev/null || fail "unexpected migration task definition"
jq -e '.containerOverrides == [{name: "gateway", command: ["sh", "-ec", "cd libs/prisma-service && npx prisma migrate status"]}]' \
  "$work/state/overrides.json" >/dev/null || fail "unexpected command override"
jq -e '.awsvpcConfiguration.subnets == ["subnet-1"]' "$work/state/network.json" >/dev/null || fail "network not copied"
test "$(cat "$work/state/launch-type")" = FARGATE || fail "migration did not run on on-demand Fargate"

# A behind schema stops the release.
if run env MODE=status FAKE_EXIT_CODE=1 > "$work/out" 2>&1; then fail "a pending migration was accepted"; fi
grep -q 'make <environment>-migrate' "$work/out" || fail "pending migration guidance was not reported"

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

# A task whose container never ran is not reported as a migration failure.
if run env MODE=deploy FAKE_EXIT_CODE=none > "$work/out" 2>&1; then fail "a task that never ran was accepted"; fi
grep -q 'stopped before its container ran (TaskFailedToStart)' "$work/out" || fail "a task that never ran was not reported"
grep -q 'MIGRATION FAILED' "$work/out" && fail "a task that never ran was reported as a failed migration"

# Nothing starts unless the migration and the rollout both fit before the deadline.
if run env MODE=deploy ROLLOUT_DEADLINE="$(($(date +%s) + 3600))" > "$work/out" 2>&1; then
  fail "a migration that could outlast the deadline was started"
fi
grep -q 'not enough time left' "$work/out" || fail "deadline stop was not reported"
grep -qs 'run-task\|register-task-definition' "$work/state/calls" && fail "something started after the deadline check"
run env MODE=status MIGRATION_TIMEOUT=900 ROLLOUT_DEADLINE="$(($(date +%s) + 2400))" > "$work/out" 2>&1 \
  || { cat "$work/out" >&2; fail "a check that fits before the deadline was refused"; }

# A retry reuses the identical latest revision instead of registering another one.
run env MODE=status RESULT_FILE="$work/result" > "$work/out" 2>&1 || fail "first status check failed"
run_again env MODE=status RESULT_FILE="$work/result" > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "retried status check failed"; }
grep -q 'register-task-definition' "$work/state/calls" && fail "an identical revision was registered again"
grep -q 'Reusing the identical latest' "$work/out" || fail "revision reuse was not reported"
test "$(cat "$work/result")" = "arn:aws:ecs:region:account:task-definition/MIGRATION_TDF:9" || fail "migration revision not recorded"

echo "run-migration: all tests passed"
