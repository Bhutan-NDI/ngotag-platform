#!/usr/bin/env bash

# Runs one standalone ECS task against the platform database. Application images
# never migrate at startup, and no release ever applies migrations.
#
#   MODE=status  service releases: read-only `prisma migrate status` from the
#                released service image. Fails when that image carries migrations
#                the database has not applied, histories diverge, or a migration
#                failed (or the check itself fails), so a service never runs ahead
#                of the schema. A database ahead of an older image passes (Prisma
#                5.22 exits 0: "Database schema is up to date!").
#   MODE=deploy  `make <environment>-migrate` only: `prisma migrate deploy` then
#                `migrate status`, from the API gateway image. Every other writer
#                (seed) must already be stopped at 0/0; the API gateway is stopped
#                here, right before the task, with its Service Auto Scaling
#                suspended so nothing scales it back up. Both are given back once
#                the migration succeeded, or when the task never ran (the
#                database was not touched). Whenever the migration failed, timed
#                out or its outcome is unknown, both stay as they are.
#
# The task is a copy of the template service's (API gateway's) current task
# definition, for its environment file, roles and network, in its own family,
# with only the image replaced and the CPU architecture pinned. The family's
# latest revision is reused when it is already exactly that. It runs on
# on-demand Fargate, never Spot. Its output can contain connection details, so it
# is not printed here; read it in the task's CloudWatch log.
#
# Nothing starts unless the task's timeout and RESERVE seconds (the rollout of a
# service release, or the gateway's stop and restart for a migration) fit before
# DEADLINE.
#
# Environment:
#   CLUSTER, IMAGE, TEMPLATE_FILE (the template service's manifest entry:
#   {name, service, container, task_definition_family}), MIGRATION_FAMILY,
#   WRITERS_FILE (JSON array of ECS service names), MODE, COMMAND (shell command run
#   in the container), CPU_ARCHITECTURE, MIGRATION_TIMEOUT (seconds, default 3600),
#   POLL_SECONDS (default 15), STOP_TIMEOUT (seconds to wait for the gateway to
#   stop, default 600), DEADLINE (optional epoch seconds), RESERVE (seconds,
#   default 1260), RESULT_FILE (optional; receives the task definition ARN),
#   RESTORE_FILE (optional, deploy mode; after a successful migration receives
#   {service, desired_count, restored}: the gateway's desired count before it was
#   stopped, and whether everything was given back)

set -euo pipefail

: "${CLUSTER:?}" "${IMAGE:?}" "${TEMPLATE_FILE:?}" "${MIGRATION_FAMILY:?}" \
  "${WRITERS_FILE:?}" "${MODE:?}" "${COMMAND:?}" "${CPU_ARCHITECTURE:?}"
timeout_seconds=${MIGRATION_TIMEOUT:-3600}
poll_seconds=${POLL_SECONDS:-15}
stop_timeout=${STOP_TIMEOUT:-600}
deadline=${DEADLINE:-}
reserve=${RESERVE:-1260}
script_dir=$(cd "$(dirname "$0")" && pwd)
case "$MODE" in status | deploy) ;; *) echo "unknown migration mode $MODE" >&2; exit 2 ;; esac

work=$(mktemp -d)
service=$(jq -er '.service' "$TEMPLATE_FILE")
container=$(jq -er '.container' "$TEMPLATE_FILE")
family=$(jq -er '.task_definition_family' "$TEMPLATE_FILE")

# Deploy mode: what was changed on the gateway and is still to be given back (its
# desired count before it was stopped, and its scalable target's suspended state
# before scaling was suspended), and whether it must stay that way: from the
# moment the task may run until its outcome is known to be safe.
original_count=
stopped_count=
scaling=
keep_stopped=false
scalable_target="service/$CLUSTER/$service"
give_back_gateway() {
  if [ -n "$stopped_count" ]; then
    aws ecs update-service --cluster "$CLUSTER" --service "$service" --desired-count "$stopped_count" >/dev/null || return 1
    echo "API gateway given back its desired count ($stopped_count)"
    stopped_count=
  fi
  if [ -n "$scaling" ]; then
    aws application-autoscaling register-scalable-target --service-namespace ecs \
      --scalable-dimension ecs:service:DesiredCount --resource-id "$scalable_target" \
      --suspended-state "$scaling" >/dev/null || return 1
    echo "API gateway auto scaling given back its previous state"
    scaling=
  fi
}
left_changed() {
  [ -n "$stopped_count" ] && echo "The API gateway stays stopped; give it back its desired count ($stopped_count) by hand." >&2
  [ -n "$scaling" ] && echo "Its auto scaling stays suspended; give it back its previous state by hand: $scaling" >&2
  return 0
}
# Gives the gateway back, retrying once, and records whether that worked.
settle_gateway() {
  restored=true
  if ! give_back_gateway; then
    sleep "$poll_seconds"
    give_back_gateway || { restored=false; echo "could not give the API gateway back" >&2; left_changed; }
  fi
  if [ -n "${RESTORE_FILE:-}" ]; then
    jq -n --arg service "$service" --argjson count "$original_count" --argjson restored "$restored" \
      '{service: $service, desired_count: $count, restored: $restored}' > "$RESTORE_FILE"
  fi
}
on_exit() {
  status=$?
  if [ -n "$stopped_count$scaling" ]; then
    if [ "$keep_stopped" = true ]; then
      echo "Check the migration task in ECS and the database before giving the API gateway back." >&2
      left_changed
    else
      settle_gateway
    fi
  fi
  rm -rf "$work"
  exit "$status"
}
trap on_exit EXIT

if [ -n "$deadline" ] && [ "$(($(date +%s) + timeout_seconds + reserve))" -gt "$deadline" ]; then
  echo "not enough time left in this job for the $MODE task and what follows it; nothing was started." >&2
  echo "Run it again." >&2
  exit 1
fi

running=$(aws ecs list-tasks --cluster "$CLUSTER" --family "$MIGRATION_FAMILY" --desired-status RUNNING \
  --query 'length(taskArns)' --output text)
test "$running" = 0 || { echo "a migration task is already running; never start a second one" >&2; exit 1; }

# Every writer other than the gateway (seed) must already be, and stay, stopped.
other_writers_stopped() {
  while IFS= read -r writer; do
    [ "$writer" = "$service" ] && continue
    aws ecs describe-services --cluster "$CLUSTER" --services "$writer" \
      --query 'services[0]' --output json > "$work/writer.json"
    jq -e '.status == "ACTIVE" and .desiredCount == 0 and .runningCount == 0 and .pendingCount == 0' \
      "$work/writer.json" >/dev/null || return 1
  done < <(jq -r '.[]' "$WRITERS_FILE")
}
if [ "$MODE" = deploy ]; then
  other_writers_stopped || {
    echo "every writer other than the API gateway (seed) must be stopped (0/0); one is not" >&2
    exit 1
  }
fi

aws ecs describe-services --cluster "$CLUSTER" --services "$service" \
  --query 'services[0]' --output json > "$work/service.json"
current=$(jq -er '.taskDefinition' "$work/service.json")
case "$current" in
  *":task-definition/${family}:"*) ;;
  *) echo "the template service's task definition does not belong to the manifest family" >&2; exit 1 ;;
esac
network=$(jq -ce '.networkConfiguration | select(.awsvpcConfiguration != null)' "$work/service.json") || {
  echo "the template service has no awsvpc network configuration to run the task in" >&2
  exit 1
}

aws ecs describe-task-definition --task-definition "$current" \
  --query taskDefinition --output json > "$work/current.json"
jq --arg container "$container" --arg image "$IMAGE" --arg cpu_architecture "$CPU_ARCHITECTURE" \
  -f "$script_dir/render-task-definition.jq" "$work/current.json" \
  | jq --arg family "$MIGRATION_FAMILY" --arg container "$container" '
      .family = $family
      | .containerDefinitions |= map(if .name == $container then del(.healthCheck) else . end)' \
  > "$work/register.json"
# Reuse the family's latest revision when it is already this exact definition
# (for example a retried run), instead of registering a duplicate.
task_definition=
if aws ecs describe-task-definition --task-definition "$MIGRATION_FAMILY" \
  --query taskDefinition --output json > "$work/latest.json" 2>/dev/null; then
  normalize='del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
    .registeredAt, .registeredBy, .deregisteredAt)'
  if [ "$(jq -cS "$normalize" "$work/latest.json")" = "$(jq -cS "$normalize" "$work/register.json")" ]; then
    task_definition=$(jq -er '.taskDefinitionArn' "$work/latest.json")
    echo "Reusing the identical latest migration task definition revision"
  fi
fi
if [ -z "$task_definition" ]; then
  task_definition=$(aws ecs register-task-definition --cli-input-json "file://$work/register.json" \
    --query taskDefinition.taskDefinitionArn --output text)
fi
if [ -n "${RESULT_FILE:-}" ]; then printf '%s\n' "$task_definition" > "$RESULT_FILE"; fi

# Stop the gateway only now, after every check and the queue, to keep it short.
if [ "$MODE" = deploy ]; then
  jq -e '.status == "ACTIVE" and ([.deployments[] | select(.status == "PRIMARY" and .rolloutState == "COMPLETED")] | length == 1)' \
    "$work/service.json" >/dev/null || {
    echo "the API gateway has a deployment in progress; retry after it completes" >&2
    exit 1
  }
  # Service Auto Scaling would scale a stopped gateway back up to its minimum.
  # Suspend it unless it already is; its previous state is given back with the
  # gateway.
  suspended=$(aws application-autoscaling describe-scalable-targets --service-namespace ecs \
    --scalable-dimension ecs:service:DesiredCount --resource-ids "$scalable_target" \
    --query 'ScalableTargets[0].SuspendedState' --output json)
  if [ "$suspended" != null ] && ! jq -e 'all(.[]; . == true)' <<<"$suspended" >/dev/null; then
    scaling=$(jq -c . <<<"$suspended")
    aws application-autoscaling register-scalable-target --service-namespace ecs \
      --scalable-dimension ecs:service:DesiredCount --resource-id "$scalable_target" \
      --suspended-state '{"DynamicScalingInSuspended":true,"DynamicScalingOutSuspended":true,"ScheduledScalingSuspended":true}' \
      >/dev/null
    echo "API gateway auto scaling suspended"
  fi
  original_count=$(jq -r '.desiredCount' "$work/service.json")
  if [ "$original_count" -gt 0 ]; then
    stopped_count=$original_count
    aws ecs update-service --cluster "$CLUSTER" --service "$service" --desired-count 0 >/dev/null
    echo "API gateway stopping (desired count was $original_count)"
  fi
  stop_begun=$(date +%s)
  while :; do
    aws ecs describe-services --cluster "$CLUSTER" --services "$service" \
      --query 'services[0]' --output json > "$work/state.json"
    jq -e '.desiredCount == 0 and .runningCount == 0 and .pendingCount == 0' "$work/state.json" >/dev/null && break
    if [ "$(($(date +%s) - stop_begun))" -gt "$stop_timeout" ]; then
      echo "the API gateway did not stop in ${stop_timeout}s; nothing was migrated" >&2
      exit 1
    fi
    sleep "$poll_seconds"
  done
  # Seed again, immediately before the task: nothing may have started meanwhile.
  other_writers_stopped || { echo "a writer started while the API gateway was stopping; nothing was migrated" >&2; exit 1; }
  echo "Writer services are stopped"
fi

overrides=$(jq -cn --arg container "$container" --arg command "$COMMAND" \
  '{containerOverrides: [{name: $container, command: ["sh", "-ec", $command]}]}')
# From here the task may be running: any exit not known to be safe leaves the
# gateway as it is.
keep_stopped=true
aws ecs run-task --cluster "$CLUSTER" --task-definition "$task_definition" --count 1 \
  --launch-type FARGATE --started-by platform-release \
  --network-configuration "$network" --overrides "$overrides" --output json > "$work/started.json"
jq -e '(.failures | length) == 0 and (.tasks | length) == 1' "$work/started.json" >/dev/null || {
  keep_stopped=false
  echo "the $MODE task did not start; the database was not touched" >&2
  exit 1
}
task=$(jq -r '.tasks[0].taskArn' "$work/started.json")
echo "Migration $MODE task started; nothing else starts until it stops"

begun=$(date +%s)
while :; do
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --query 'tasks[0]' --output json > "$work/task.json"
  [ "$(jq -r '.lastStatus' "$work/task.json")" = STOPPED ] && break
  if [ "$(($(date +%s) - begun))" -gt "$timeout_seconds" ]; then
    echo "the $MODE task did not stop in ${timeout_seconds}s; do not start another one; inspect it in ECS." >&2
    exit 1
  fi
  # Nothing may start the gateway while the migration runs.
  if [ "$MODE" = deploy ]; then
    aws ecs describe-services --cluster "$CLUSTER" --services "$service" \
      --query 'services[0]' --output json > "$work/state.json"
    if ! jq -e '.desiredCount == 0' "$work/state.json" >/dev/null; then
      echo "the API gateway was started while the migration runs; stopping it again" >&2
      aws ecs update-service --cluster "$CLUSTER" --service "$service" --desired-count 0 >/dev/null
    fi
  fi
  sleep "$poll_seconds"
done

exit_code=$(jq -r --arg container "$container" '.containers[] | select(.name == $container) | .exitCode // "none"' "$work/task.json")
elapsed=$(($(date +%s) - begun))
if [ "$exit_code" = none ]; then
  keep_stopped=false
  # Only the stop code: the stopped reason can name registries and accounts.
  echo "the $MODE task stopped before its container ran ($(jq -r '.stopCode // "unknown"' "$work/task.json"));" >&2
  echo "the database was not touched and nothing was deployed. Fix the cause and run it again." >&2
  exit 1
fi
if [ "$exit_code" != 0 ]; then
  if [ "$MODE" = status ]; then
    echo "the database lacks migrations this image carries (migrate status exit $exit_code). Nothing was deployed." >&2
    echo "Apply them first with make <environment>-migrate." >&2
  else
    echo "MIGRATION FAILED (exit $exit_code). Do not retry; recover from the database backups." >&2
  fi
  echo "The task output is in its CloudWatch log." >&2
  exit 1
fi
if [ "$MODE" = status ]; then
  echo "The database schema is up to date for this release (${elapsed}s)"
else
  echo "Migrations applied and verified (${elapsed}s)"
  # The migration is applied whether or not the gateway comes back, so it is
  # still recorded; the job then fails on a gateway that was not given back.
  keep_stopped=false
  settle_gateway
fi
