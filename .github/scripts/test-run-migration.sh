#!/usr/bin/env bash

# Exercises run-migration.sh against a fake aws command.

set -euo pipefail

script=$(pwd)/.github/scripts/run-migration.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# The fake keeps the gateway's desired count in $FAKE_STATE/gateway.desired
# (FAKE_GATEWAY_DESIRED at the start). Its tasks follow the desired count unless
# FAKE_GATEWAY_STUCK is set. Seed runs FAKE_SEED_RUNNING tasks (default 0). The
# gateway's scalable target is suspended as FAKE_SCALING says (none if unset);
# its state is kept in $FAKE_STATE/scaling.json.
cat > "$work/bin/aws" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
state=$FAKE_STATE
echo "$*" >> "$state/calls"
arg() { local key=$1; shift; while [ "$#" -gt 0 ]; do [ "$1" = "$key" ] && { echo "$2"; return; }; shift; done; }
[ -f "$state/gateway.desired" ] || echo "${FAKE_GATEWAY_DESIRED:-2}" > "$state/gateway.desired"
[ -f "$state/scaling.json" ] || echo "${FAKE_SCALING:-null}" > "$state/scaling.json"
case "$2" in
  describe-scalable-targets)
    test "$(arg --resource-ids "$@")" = service/cluster/gateway-service || { echo "wrong scalable target" >&2; exit 1; }
    cat "$state/scaling.json"
    ;;
  register-scalable-target)
    arg --suspended-state "$@" | jq -c . > "$state/scaling.json"
    ;;
  list-tasks) echo "${FAKE_RUNNING_MIGRATIONS:-0}" ;;
  describe-services)
    service=$(arg --services "$@")
    if [ "$service" = seed ]; then
      desired=${FAKE_SEED_RUNNING:-0} running=${FAKE_SEED_RUNNING:-0}
    else
      desired=$(cat "$state/gateway.desired") running=$desired
      [ -n "${FAKE_GATEWAY_STUCK:-}" ] && running=1
    fi
    jq -n --argjson desired "$desired" --argjson running "$running" '{status: "ACTIVE",
      desiredCount: $desired, runningCount: $running, pendingCount: 0,
      taskDefinition: "arn:aws:ecs:region:account:task-definition/GATEWAY_TDF:4",
      deployments: [{status: "PRIMARY", rolloutState: "COMPLETED"}],
      networkConfiguration: {awsvpcConfiguration: {subnets: ["subnet-1"], securityGroups: ["sg-1"], assignPublicIp: "DISABLED"}}}'
    ;;
  update-service)
    count=$(arg --desired-count "$@")
    if [ "$count" != 0 ] && [ -n "${FAKE_RESTORE_FAILS:-}" ]; then echo "An error occurred (ThrottlingException)" >&2; exit 254; fi
    [ "$count" = 0 ] && cp "$state/scaling.json" "$state/scaling-at-stop.json"
    echo "$count" > "$state/gateway.desired"
    arg --desired-count "$@" >> "$state/gateway.history"
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
    echo "gateway=$(cat "$state/gateway.desired")" > "$state/at-run-task"
    # Something else starts the gateway once the task runs.
    [ -n "${FAKE_GATEWAY_RESTARTS:-}" ] && echo 1 > "$state/gateway.desired"
    arg --overrides "$@" > "$state/overrides.json"
    arg --network-configuration "$@" > "$state/network.json"
    arg --launch-type "$@" > "$state/launch-type"
    if [ -n "${FAKE_RUN_TASK_FAILS:-}" ]; then
      jq -n '{failures: [{reason: "capacity"}], tasks: []}'
    else
      jq -n '{failures: [], tasks: [{taskArn: "arn:aws:ecs:region:account:task/cluster/abc"}]}'
    fi
    ;;
  describe-tasks)
    polls=$(( $(cat "$state/polls" 2>/dev/null || echo 0) + 1 )); echo "$polls" > "$state/polls"
    if [ -n "${FAKE_DESCRIBE_TASKS_FAILS:-}" ]; then echo "An error occurred (ThrottlingException)" >&2; exit 254; fi
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
  rm -f "$work/state/calls" "$work/state/polls" "$work/state/gateway.history" "$work/state/at-run-task" "$work/restore.json"
  PATH="$work/bin:$PATH" FAKE_STATE="$work/state" CLUSTER=cluster IMAGE=registry/repo@sha256:abc \
    TEMPLATE_FILE="$work/template.json" MIGRATION_FAMILY=MIGRATION_TDF WRITERS_FILE="$work/writers.json" \
    COMMAND="cd libs/prisma-service && npx prisma migrate status" CPU_ARCHITECTURE=ARM64 POLL_SECONDS=0 \
    RESTORE_FILE="$work/restore.json" "$@" bash "$script"
}

fail() { echo "$1" >&2; exit 1; }
history() { tr '\n' ' ' < "$work/state/gateway.history" 2>/dev/null | sed 's/ $//'; }

# The status check runs the image in the template's task and never touches the gateway.
run env MODE=status > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "status check failed"; }
grep -q 'schema is up to date' "$work/out" || fail "status success was not reported"
jq -e '.family == "MIGRATION_TDF" and .runtimePlatform.cpuArchitecture == "ARM64"
  and .containerDefinitions[0].image == "registry/repo@sha256:abc"
  and (.containerDefinitions[0] | has("healthCheck") | not) and .executionRoleArn == "execution-role"' \
  "$work/state/registered.json" >/dev/null || fail "unexpected migration task definition"
jq -e '.containerOverrides == [{name: "gateway", command: ["sh", "-ec", "cd libs/prisma-service && npx prisma migrate status"]}]' \
  "$work/state/overrides.json" >/dev/null || fail "unexpected command override"
jq -e '.awsvpcConfiguration.subnets == ["subnet-1"]' "$work/state/network.json" >/dev/null || fail "network not copied"
test "$(cat "$work/state/launch-type")" = FARGATE || fail "task did not run on on-demand Fargate"
grep -qs 'update-service' "$work/state/calls" && fail "the status check changed the gateway"

# A behind schema stops the release and points to make <environment>-migrate.
if run env MODE=status FAKE_EXIT_CODE=1 > "$work/out" 2>&1; then fail "a pending migration was accepted"; fi
grep -q 'make <environment>-migrate' "$work/out" || fail "pending migration guidance was not reported"

# A migration stops the gateway right before the task and gives it back its count afterwards.
run env MODE=deploy > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "migration failed"; }
grep -q 'Migrations applied' "$work/out" || fail "migration success was not reported"
test "$(cat "$work/state/at-run-task")" = gateway=0 || fail "the gateway was not stopped when the task ran"
test "$(history)" = "0 2" || fail "gateway not stopped then restored: $(history)"
jq -e '. == {service: "gateway-service", desired_count: 2, restored: true}' "$work/restore.json" >/dev/null || fail "restore not recorded"
grep -q 'register-scalable-target' "$work/state/calls" && fail "scaling changed for a gateway without a scalable target"

# A gateway that the operator already stopped is left as it is.
run env MODE=deploy FAKE_GATEWAY_DESIRED=0 > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "migration with a stopped gateway failed"; }
grep -qs 'update-service' "$work/state/calls" && fail "an already stopped gateway was changed"
jq -e '. == {service: "gateway-service", desired_count: 0, restored: true}' "$work/restore.json" >/dev/null \
  || fail "an already stopped gateway was not recorded as such"

# Active auto scaling is suspended before the gateway stops and given back its previous state.
active='{"DynamicScalingInSuspended":false,"DynamicScalingOutSuspended":false,"ScheduledScalingSuspended":true}'
run env MODE=deploy FAKE_SCALING="$active" > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "migration with auto scaling failed"; }
jq -e 'all(.[]; . == true)' "$work/state/scaling-at-stop.json" >/dev/null || fail "auto scaling was not suspended before the stop"
test "$(cat "$work/state/scaling.json")" = "$active" || fail "auto scaling not given back its previous state"
test "$(history)" = "0 2" || fail "gateway not stopped then restored with auto scaling: $(history)"
# Auto scaling that is already suspended is left alone.
run env MODE=deploy FAKE_SCALING='{"DynamicScalingInSuspended":true,"DynamicScalingOutSuspended":true,"ScheduledScalingSuspended":true}' \
  > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "migration with suspended auto scaling failed"; }
grep -q 'register-scalable-target' "$work/state/calls" && fail "already suspended auto scaling was changed"

# A gateway started while the migration runs is stopped again.
run env MODE=deploy FAKE_GATEWAY_RESTARTS=1 > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "migration with a restarted gateway failed"; }
grep -q 'stopping it again' "$work/out" || fail "a restarted gateway was not reported"
test "$(history)" = "0 0 2" || fail "a gateway started during the migration was not stopped again: $(history)"

# An AWS error while the task may be running leaves the gateway and its scaling as they are.
if run env MODE=deploy FAKE_SCALING="$active" FAKE_DESCRIBE_TASKS_FAILS=1 > "$work/out" 2>&1; then fail "a failed poll was accepted"; fi
test "$(history)" = 0 || fail "the gateway was restarted while the migration may run: $(history)"
jq -e 'all(.[]; . == true)' "$work/state/scaling.json" >/dev/null || fail "auto scaling resumed while the migration may run"
grep -q 'give it back its desired count (2) by hand' "$work/out" || fail "the stopped gateway was not reported"
grep -q 'auto scaling stays suspended' "$work/out" || fail "the suspended auto scaling was not reported"

# A gateway that cannot be given back is reported, never as restored; the applied
# migration still succeeds so it is recorded.
run env MODE=deploy FAKE_RESTORE_FAILS=1 > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "an applied migration failed on the restore"; }
grep -q 'given back its desired count' "$work/out" && fail "a failed restore was reported as done"
grep -q 'give it back its desired count (2) by hand' "$work/out" || fail "a failed restore was not reported"
jq -e '.restored == false' "$work/restore.json" >/dev/null || fail "a failed restore was recorded as restored"

# Seed must already be stopped; nothing changes otherwise.
if run env MODE=deploy FAKE_SEED_RUNNING=1 > "$work/out" 2>&1; then fail "migration ran with seed running"; fi
grep -qs 'run-task\|update-service' "$work/state/calls" && fail "something changed while seed was running"

# A failed migration leaves the gateway stopped.
if run env MODE=deploy FAKE_EXIT_CODE=1 > "$work/out" 2>&1; then fail "a failed migration was accepted"; fi
grep -q 'MIGRATION FAILED' "$work/out" || fail "failed migration was not reported"
grep -q 'stays stopped' "$work/out" || fail "the stopped gateway was not reported after a failed migration"
test "$(history)" = 0 || fail "the gateway was restarted after a failed migration: $(history)"

# When the database was not touched, the gateway gets its count back.
if run env MODE=deploy FAKE_EXIT_CODE=none > "$work/out" 2>&1; then fail "a task that never ran was accepted"; fi
grep -q 'stopped before its container ran (TaskFailedToStart)' "$work/out" || fail "a task that never ran was not reported"
grep -q 'MIGRATION FAILED' "$work/out" && fail "a task that never ran was reported as a failed migration"
test "$(history)" = "0 2" || fail "gateway not restored after a task that never ran: $(history)"
if run env MODE=deploy FAKE_RUN_TASK_FAILS=1 > "$work/out" 2>&1; then fail "a task that did not start was accepted"; fi
test "$(history)" = "0 2" || fail "gateway not restored after a task that did not start: $(history)"
if run env MODE=deploy FAKE_GATEWAY_STUCK=1 STOP_TIMEOUT=0 > "$work/out" 2>&1; then fail "migration ran with the gateway running"; fi
grep -qs 'run-task' "$work/state/calls" && fail "the task started while the gateway was running"
test "$(history)" = "0 2" || fail "gateway not restored after it failed to stop: $(history)"

# Other refusals change nothing.
if run env MODE=deploy FAKE_RUNNING_MIGRATIONS=1 > "$work/out" 2>&1; then fail "a second migration task was started"; fi
grep -qs 'run-task\|update-service' "$work/state/calls" && fail "something changed while another migration ran"
if run env MODE=other > "$work/out" 2>&1; then fail "an unknown mode was accepted"; fi

# Nothing starts unless the task and what follows it fit before the deadline.
if run env MODE=deploy RESERVE=900 DEADLINE="$(($(date +%s) + 3600))" > "$work/out" 2>&1; then
  fail "a migration that could outlast the deadline was started"
fi
grep -q 'not enough time left' "$work/out" || fail "deadline stop was not reported"
grep -qs 'run-task\|register-task-definition\|update-service' "$work/state/calls" && fail "something started after the deadline check"
run env MODE=deploy RESERVE=900 DEADLINE="$(($(date +%s) + 3600 + 1000))" > "$work/out" 2>&1 \
  || { cat "$work/out" >&2; fail "a migration that fits before the deadline was refused"; }

# A retry reuses the identical latest revision instead of registering another one.
run env MODE=status RESULT_FILE="$work/result" > "$work/out" 2>&1 || fail "first status check failed"
run_again env MODE=status RESULT_FILE="$work/result" > "$work/out" 2>&1 || { cat "$work/out" >&2; fail "retried status check failed"; }
grep -q 'register-task-definition' "$work/state/calls" && fail "an identical revision was registered again"
grep -q 'Reusing the identical latest' "$work/out" || fail "revision reuse was not reported"
test "$(cat "$work/result")" = "arn:aws:ecs:region:account:task-definition/MIGRATION_TDF:9" || fail "migration revision not recorded"

echo "run-migration: all tests passed"
