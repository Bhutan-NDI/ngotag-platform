#!/usr/bin/env bash

# Prod never rebuilds. For every Prod service this proves that the matching
# Stage service runs the release candidate image recorded in the Stage ledger,
# then copies that exact image, by digest, into the Prod image repository.
#
# Environment:
#   REGISTRY               ECR registry host
#   SOURCE_CLUSTER         Stage ECS cluster
#   SOURCE_SERVICES_FILE   Stage services (JSON array, as in the manifest)
#   SOURCE_DEPLOYED_FILE   the Stage ledger's .release.deployed.services object
#   SOURCE_REPOSITORY      Stage image repository
#   TARGET_SERVICES_FILE   Prod services (JSON array, as in the manifest)
#   TARGET_REPOSITORY      Prod image repository
#   TARGET_TAG_SUFFIX      appended to the service's image tag prefix for Prod
#                          (<version>-<commit>)
#   IMAGE_TAG_PREFIX       image tag prefix from the release contract

set -euo pipefail

: "${REGISTRY:?}" "${SOURCE_CLUSTER:?}" "${SOURCE_SERVICES_FILE:?}" "${SOURCE_DEPLOYED_FILE:?}" \
  "${SOURCE_REPOSITORY:?}" "${TARGET_SERVICES_FILE:?}" "${TARGET_REPOSITORY:?}" "${TARGET_TAG_SUFFIX:?}" \
  "${IMAGE_TAG_PREFIX:?}"

image_digest() {
  aws ecr describe-images --repository-name "$1" --image-ids imageTag="$2" \
    --query 'imageDetails[0].imageDigest' --output text 2>/dev/null || true
}

mapfile -t names < <(jq -r '.[].name' "$TARGET_SERVICES_FILE")

# Prove everything about Stage before copying anything.
for name in "${names[@]}"; do
  source_tag=$(jq -er --arg name "$name" '.[$name].image_tag // empty' "$SOURCE_DEPLOYED_FILE") || {
    echo "Stage has no released image for $name" >&2
    exit 1
  }
  source_digest=$(jq -er --arg name "$name" '.[$name].image_digest // empty' "$SOURCE_DEPLOYED_FILE")
  [[ "$source_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "invalid Stage image digest for $name" >&2; exit 1; }
  test "$(image_digest "$SOURCE_REPOSITORY" "$source_tag")" = "$source_digest" || {
    echo "the Stage image tag of $name no longer resolves to the digest in the Stage ledger" >&2
    exit 1
  }

  service=$(jq -er --arg name "$name" '.[] | select(.name == $name) | .service' "$SOURCE_SERVICES_FILE") || {
    echo "Stage does not run $name" >&2
    exit 1
  }
  container=$(jq -er --arg name "$name" '.[] | select(.name == $name) | .container' "$SOURCE_SERVICES_FILE")
  service_json=$(aws ecs describe-services --cluster "$SOURCE_CLUSTER" --services "$service" \
    --query 'services[0]' --output json)
  task_definition=$(jq -er '.taskDefinition' <<<"$service_json")
  jq -e --arg task_definition "$task_definition" '
    .status == "ACTIVE" and
    ([.deployments[] | select(.status == "PRIMARY" and .taskDefinition == $task_definition
      and .rolloutState == "COMPLETED")] | length == 1)
  ' <<<"$service_json" >/dev/null || {
    echo "Stage service $name is not settled on one completed deployment" >&2
    exit 1
  }
  aws ecs describe-task-definition --task-definition "$task_definition" \
    --query taskDefinition --output json \
    | jq -e --arg container "$container" --arg image "$REGISTRY/$SOURCE_REPOSITORY:$source_tag" '
        .runtimePlatform.cpuArchitecture == "ARM64" and
        ([.containerDefinitions[] | select(.name == $container and .image == $image)] | length == 1)
      ' >/dev/null || {
    echo "Stage service $name does not run the release candidate image" >&2
    exit 1
  }
  if [ "$(jq -r '.desiredCount' <<<"$service_json")" -eq 0 ]; then
    # A stopped Stage service has no running task to check; its task definition is the proof.
    echo "Stage service $name is stopped; its task definition uses the release candidate image"
    continue
  fi
  mapfile -t tasks < <(aws ecs list-tasks --cluster "$SOURCE_CLUSTER" --service-name "$service" \
    --desired-status RUNNING --query 'taskArns[]' --output text | tr '\t' '\n' | sed '/^$/d;/^None$/d')
  [ "${#tasks[@]}" -gt 0 ] || { echo "Stage service $name has no running tasks" >&2; exit 1; }
  aws ecs describe-tasks --cluster "$SOURCE_CLUSTER" --tasks "${tasks[@]}" --output json \
    | jq -e --arg container "$container" --arg digest "$source_digest" '
        [.tasks[] | .containers[] | select(.name == $container)] as $containers
        | ($containers | length) > 0 and all($containers[]; .imageDigest == $digest)
      ' >/dev/null || {
    echo "Stage service $name has running tasks with a different image digest" >&2
    exit 1
  }
  echo "Stage service $name runs the release candidate"
done

for name in "${names[@]}"; do
  source_digest=$(jq -er --arg name "$name" '.[$name].image_digest' "$SOURCE_DEPLOYED_FILE")
  target_tag="${IMAGE_TAG_PREFIX}${name}-${TARGET_TAG_SUFFIX}"
  existing=$(image_digest "$TARGET_REPOSITORY" "$target_tag")
  case "$existing" in
    "$source_digest")
      echo "The Prod image of $name already exists with the Stage digest (earlier attempt)"
      ;;
    "" | None)
      skopeo copy --preserve-digests --retry-times 3 \
        "docker://$REGISTRY/$SOURCE_REPOSITORY@$source_digest" \
        "docker://$REGISTRY/$TARGET_REPOSITORY:$target_tag" >/dev/null
      ;;
    *)
      echo "the Prod image tag of $name already exists with a different digest; refusing to overwrite it" >&2
      exit 1
      ;;
  esac
  test "$(image_digest "$TARGET_REPOSITORY" "$target_tag")" = "$source_digest" || {
    echo "the Prod image digest of $name differs from the Stage image digest" >&2
    exit 1
  }
  echo "Prod image of $name is byte-identical to the Stage release candidate"
done
