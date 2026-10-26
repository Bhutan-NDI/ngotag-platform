#!/usr/bin/env bash

# Resolves the image each service deploys and proves it is this commit's
# single-platform build for the release platform. Writes the release file read
# by run-migration.sh and deploy-services.sh: the manifest services, each with
# image, image_tag and image_digest added.
#
# Environment:
#   REGISTRY, REPOSITORY      ECR registry host and image repository
#   SERVICES_FILE             the manifest's services (JSON array)
#   IMAGE_TAG_PREFIX          image tag prefix from the release contract
#   IMAGE_TAG_SUFFIX          <commit> (QA, Stage) or <version>-<commit> (Prod)
#   SOURCE_SHA                the release commit
#   PLATFORM_ARCH             Docker architecture (arm64)
#   RELEASE_FILE              output

set -euo pipefail

: "${REGISTRY:?}" "${REPOSITORY:?}" "${SERVICES_FILE:?}" "${IMAGE_TAG_PREFIX:?}" "${IMAGE_TAG_SUFFIX:?}" \
  "${SOURCE_SHA:?}" "${PLATFORM_ARCH:?}" "${RELEASE_FILE:?}"

printf '[]\n' > "$RELEASE_FILE"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

count=$(jq -er 'length' "$SERVICES_FILE")
for ((index = 0; index < count; index++)); do
  name=$(jq -er --argjson index "$index" '.[$index].name' "$SERVICES_FILE")
  tag="${IMAGE_TAG_PREFIX}${name}-${IMAGE_TAG_SUFFIX}"
  image="$REGISTRY/$REPOSITORY:$tag"
  digest=$(aws ecr describe-images --repository-name "$REPOSITORY" --image-ids imageTag="$tag" \
    --query 'imageDetails[0].imageDigest' --output text 2>/dev/null) || digest=
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "service $name: the release image does not exist" >&2; exit 1; }
  media_type=$(docker buildx imagetools inspect --raw "$image" | jq -r '.mediaType // empty')
  case "$media_type" in
    application/vnd.docker.distribution.manifest.v2+json | application/vnd.oci.image.manifest.v1+json) ;;
    *) echo "service $name: expected one single-platform image manifest" >&2; exit 1 ;;
  esac
  docker buildx imagetools inspect --format '{{json .Image}}' "$image" | jq -e \
    --arg arch "$PLATFORM_ARCH" --arg sha "$SOURCE_SHA" '
      .os == "linux" and .architecture == $arch and
      .config.Labels["org.opencontainers.image.revision"] == $sha' >/dev/null || {
    echo "service $name: the release image is not this commit's $PLATFORM_ARCH build" >&2
    exit 1
  }
  jq --argjson index "$index" --arg image "$image" --arg tag "$tag" --arg digest "$digest" \
    --slurpfile services "$SERVICES_FILE" \
    '. + [$services[0][$index] + {image: $image, image_tag: $tag, image_digest: $digest}]' \
    "$RELEASE_FILE" > "$work/release.json"
  mv "$work/release.json" "$RELEASE_FILE"
  echo "service $name: release image verified"
done
