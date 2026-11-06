#!/bin/sh

# Exercises ecr-image-digest.sh against a fake aws command.

set -eu

script=.github/scripts/ecr-image-digest.sh
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -p "$work/bin"
digest=sha256:$(printf 'a%.0s' $(seq 64))

cat > "$work/bin/aws" <<'FAKE'
#!/bin/sh
case "$FAKE_RESULT" in
  found) echo "$FAKE_DIGEST" ;;
  missing) echo "An error occurred (ImageNotFoundException) when calling the DescribeImages operation: The image with imageId {imageTag:'x'} does not exist within the repository with name 'repo' in the registry with id '123456789012'" >&2; exit 254 ;;
  throttled) echo "An error occurred (ThrottlingException) when calling the DescribeImages operation: Rate exceeded" >&2; exit 254 ;;
  denied) echo "An error occurred (AccessDeniedException) when calling the DescribeImages operation: User: arn:aws:sts::123456789012:assumed-role/x is not authorized" >&2; exit 254 ;;
  garbage) echo "None" ;;
esac
FAKE
chmod +x "$work/bin/aws"

run() { PATH="$work/bin:$PATH" FAKE_RESULT=$1 FAKE_DIGEST="$digest" sh "$script" repo tag > "$work/out" 2> "$work/err"; }
fail() { echo "$1" >&2; exit 1; }

run found || fail "an existing image was rejected"
test "$(cat "$work/out")" = "$digest" || fail "the digest was not printed"
run missing || fail "a missing image was treated as an error"
test ! -s "$work/out" || fail "a missing image printed a digest"
run throttled && fail "a throttled request was treated as a missing image"
grep -q 'ThrottlingException' "$work/err" || fail "the error code was not reported"
run denied && fail "a denied request was treated as a missing image"
grep -q '123456789012\|arn:aws' "$work/err" && fail "the error message leaked an account or ARN"
run garbage && fail "a non-digest answer was accepted"
true

echo "ecr-image-digest: all tests passed"
