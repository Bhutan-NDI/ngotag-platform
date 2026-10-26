#!/usr/bin/env bash

# Runs the release's database migration step as one standalone ECS task, before
# any service changes. Application images never migrate at startup.
#
#   MODE=status  service releases: read-only `prisma migrate status` from the
#                released service image. Fails when that image carries migrations
#                the database has not applied, histories diverge, or a migration
#                failed (or the check itself fails), so a service never runs ahead
#                of the schema. A database ahead of an older image passes (Prisma
#                5.22 exits 0: "Database schema is up to date!").
#   MODE=deploy  `make <environment>-migrate` only: `prisma migrate deploy` then
#                `migrate status`, from the API gateway image. Requires every
#                writer service (the API gateway and seed) to be stopped at 0/0.
#
# The task is a copy of the template service's (API gateway's) current task
# definition, for its environment file, roles and network, in its own family,
# with only the image replaced by the released one and the CPU architecture pinned.
# The family's latest revision is reused when it is already exactly that.
#
# Nothing starts unless the task's timeout and the service rollout that follows
# both fit before ROLLOUT_DEADLINE, so the job is never cancelled between an
# applied migration and the rollout. A task whose container never ran (image
# pull, network or capacity failure) is reported as not run: the database was
# not touched. It runs on on-demand Fargate, never
# Spot. Its output can contain connection details, so it is not printed here;
# read it in the task's CloudWatch log.
#
# Environment:
#   CLUSTER, IMAGE (the released image), TEMPLATE_FILE (the template service's
#   manifest entry: {name, service, container, task_definition_family}),
#   MIGRATION_FAMILY, WRITERS_FILE (JSON array of ECS service names), MODE,
#   COMMAND (shell command run in the container), CPU_ARCHITECTURE,
#   MIGRATION_TIMEOUT (seconds, default 3600), POLL_SECONDS (default 15),
#   ROLLOUT_DEADLINE (optional epoch seconds), ROLLOUT_RESERVE (seconds kept for the
#   rollout, default 1260, as deploy-services.sh), RESULT_FILE (optional; receives
#   the migration task definition ARN)

set -euo pipefail

: "${CLUSTER:?}" "${IMAGE:?}" "${TEMPLATE_FILE:?}" "${MIGRATION_FAMILY:?}" \
  "${WRITERS_FILE:?}" "${MODE:?}" "${COMMAND:?}" "${CPU_ARCHITECTURE:?}"
timeout_seconds=${MIGRATION_TIMEOUT:-3600}
poll_seconds=${POLL_SECONDS:-15}
rollout_deadline=${ROLLOUT_DEADLINE:-}
rollout_reserve=${ROLLOUT_RESERVE:-1260}
script_dir=$(cd "$(dirname "$0")" && pwd)
case "$MODE" in status | deploy) ;; *) echo "unknown migration mode $MODE" >&2; exit 2 ;; esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

service=$(jq -er '.service' "$TEMPLATE_FILE")
container=$(jq -er '.container' "$TEMPLATE_FILE")
family=$(jq -er '.task_definition_family' "$TEMPLATE_FILE")

if [ -n "$rollout_deadline" ] &&
  [ "$(($(date +%s) + timeout_seconds + rollout_reserve))" -gt "$rollout_deadline" ]; then
  echo "not enough time left in this job for the migration $MODE task and the rollout; nothing was started." >&2
  echo "Run the release again." >&2
  exit 1
fi

running=$(aws ecs list-tasks --cluster "$CLUSTER" --family "$MIGRATION_FAMILY" --desired-status RUNNING \
  --query 'length(taskArns)' --output text)
test "$running" = 0 || { echo "a migration task is already running; never start a second one" >&2; exit 1; }

if [ "$MODE" = deploy ]; then
  while IFS= read -r writer; do
    aws ecs describe-services --cluster "$CLUSTER" --services "$writer" \
      --query 'services[0]' --output json > "$work/writer.json"
    jq -e '.status == "ACTIVE" and .desiredCount == 0 and .runningCount == 0 and .pendingCount == 0' \
      "$work/writer.json" >/dev/null || {
      echo "every writer service must be stopped (0/0) before a migration; one is not" >&2
      exit 1
    }
  done < <(jq -r '.[]' "$WRITERS_FILE")
  echo "Writer services are stopped"
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
# (for example a retried release), instead of registering a duplicate.
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

overrides=$(jq -cn --arg container "$container" --arg command "$COMMAND" \
  '{containerOverrides: [{name: $container, command: ["sh", "-ec", $command]}]}')
aws ecs run-task --cluster "$CLUSTER" --task-definition "$task_definition" --count 1 \
  --launch-type FARGATE --started-by platform-release \
  --network-configuration "$network" --overrides "$overrides" --output json > "$work/started.json"
jq -e '(.failures | length) == 0 and (.tasks | length) == 1' "$work/started.json" >/dev/null || {
  echo "the migration task did not start; nothing was migrated" >&2
  exit 1
}
task=$(jq -r '.tasks[0].taskArn' "$work/started.json")
echo "Migration $MODE task started; nothing else starts until it stops"

begun=$(date +%s)
while :; do
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --query 'tasks[0]' --output json > "$work/task.json"
  [ "$(jq -r '.lastStatus' "$work/task.json")" = STOPPED ] && break
  if [ "$(($(date +%s) - begun))" -gt "$timeout_seconds" ]; then
    echo "the migration task did not stop in ${timeout_seconds}s; do not start another one; inspect it in ECS" >&2
    exit 1
  fi
  sleep "$poll_seconds"
done

exit_code=$(jq -r --arg container "$container" '.containers[] | select(.name == $container) | .exitCode // "none"' "$work/task.json")
elapsed=$(($(date +%s) - begun))
if [ "$exit_code" = none ]; then
  # Only the stop code: the stopped reason can name registries and accounts.
  echo "the migration $MODE task stopped before its container ran ($(jq -r '.stopCode // "unknown"' "$work/task.json"));" >&2
  echo "the database was not touched and nothing was deployed. Fix the cause and run the release again." >&2
  exit 1
fi
if [ "$exit_code" != 0 ]; then
  if [ "$MODE" = status ]; then
    echo "the database lacks migrations this image carries (migrate status exit $exit_code). Nothing was deployed." >&2
    echo "Apply them first: stop the writer services and run make <environment>-migrate." >&2
  else
    echo "MIGRATION FAILED (exit $exit_code). Nothing was deployed. Do not retry; recover from the database backups." >&2
  fi
  echo "The task output is in its CloudWatch log." >&2
  exit 1
fi
if [ "$MODE" = status ]; then
  echo "The database schema is up to date for this release (${elapsed}s)"
else
  echo "Migrations applied and verified (${elapsed}s)"
fi
