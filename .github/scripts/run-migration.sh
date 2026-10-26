#!/usr/bin/env bash

# Runs the release's database migration step as one standalone ECS task, before
# any service changes. Application images never migrate at startup.
#
#   MODE=status  `prisma migrate status` from the release image. Fails when the
#                database has migrations this release has not applied (or the
#                check itself fails), so services never run ahead of the schema.
#   MODE=deploy  `prisma migrate deploy` then `migrate status`. Requires every
#                writer service (the API gateway and seed) to be stopped at 0/0.
#
# The task is a copy of the migration service's current task definition (its
# environment file, roles and network) in its own family, with only the image
# replaced and the CPU architecture pinned. It runs on on-demand Fargate, never
# Spot. Its output can contain connection details, so it is not printed here;
# read it in the task's CloudWatch log.
#
# Environment:
#   CLUSTER, RELEASE_FILE (as deploy-services.sh), MIGRATION_SERVICE (service name),
#   MIGRATION_FAMILY, WRITERS_FILE (JSON array of ECS service names), MODE,
#   COMMAND (shell command run in the container), CPU_ARCHITECTURE,
#   MIGRATION_TIMEOUT (seconds, default 3600), POLL_SECONDS (default 15)

set -euo pipefail

: "${CLUSTER:?}" "${RELEASE_FILE:?}" "${MIGRATION_SERVICE:?}" "${MIGRATION_FAMILY:?}" \
  "${WRITERS_FILE:?}" "${MODE:?}" "${COMMAND:?}" "${CPU_ARCHITECTURE:?}"
timeout_seconds=${MIGRATION_TIMEOUT:-3600}
poll_seconds=${POLL_SECONDS:-15}
script_dir=$(cd "$(dirname "$0")" && pwd)
case "$MODE" in status | deploy) ;; *) echo "unknown migration mode $MODE" >&2; exit 2 ;; esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

jq -e --arg name "$MIGRATION_SERVICE" '[.[] | select(.name == $name)] | length == 1' "$RELEASE_FILE" >/dev/null || {
  echo "the release does not contain the migration service $MIGRATION_SERVICE" >&2
  exit 1
}
entry() { jq -er --arg name "$MIGRATION_SERVICE" --arg field "$1" '.[] | select(.name == $name) | .[$field]' "$RELEASE_FILE"; }
service=$(entry service)
container=$(entry container)
family=$(entry task_definition_family)
image=$(entry image)

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
  *) echo "the migration service's task definition does not belong to the manifest family" >&2; exit 1 ;;
esac
network=$(jq -ce '.networkConfiguration | select(.awsvpcConfiguration != null)' "$work/service.json") || {
  echo "the migration service has no awsvpc network configuration to run the task in" >&2
  exit 1
}

aws ecs describe-task-definition --task-definition "$current" \
  --query taskDefinition --output json > "$work/current.json"
jq --arg container "$container" --arg image "$image" --arg cpu_architecture "$CPU_ARCHITECTURE" \
  -f "$script_dir/render-task-definition.jq" "$work/current.json" \
  | jq --arg family "$MIGRATION_FAMILY" --arg container "$container" '
      .family = $family
      | .containerDefinitions |= map(if .name == $container then del(.healthCheck) else . end)' \
  > "$work/register.json"
task_definition=$(aws ecs register-task-definition --cli-input-json "file://$work/register.json" \
  --query taskDefinition.taskDefinitionArn --output text)

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
if [ "$exit_code" != 0 ]; then
  if [ "$MODE" = status ]; then
    echo "the database is not at this release's schema (migrate status exit $exit_code). Nothing was deployed." >&2
    echo "If the release adds migrations, stop the writer services and run make deploy-<environment> MIGRATE=true." >&2
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
