#!/bin/sh

# Prints the digest an ECR image tag points at, or nothing when the tag does not
# exist. Any other error (throttling, permissions, network) fails, so a caller
# never mistakes an unreadable repository for a missing image.

set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <repository> <tag>" >&2
  exit 2
fi

errors=$(mktemp)
trap 'rm -f "$errors"' EXIT HUP INT TERM

if digest=$(aws ecr describe-images --repository-name "$1" --image-ids imageTag="$2" \
  --query 'imageDetails[0].imageDigest' --output text 2>"$errors"); then
  printf '%s' "$digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || {
    echo "unexpected digest for an image tag" >&2
    exit 1
  }
  printf '%s\n' "$digest"
elif grep -q 'ImageNotFoundException' "$errors"; then
  :
else
  # Only the error code: the message can name accounts and repositories.
  code=$(grep -oE 'An error occurred \([A-Za-z]+\)' "$errors" | head -n 1)
  echo "could not read the image repository: ${code:-unknown error}" >&2
  exit 1
fi
