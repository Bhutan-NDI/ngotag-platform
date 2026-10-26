#!/bin/sh

# Starts the built image on its own platform, without network access, and proves
# that it is usable there before it is pushed: Node runs on the expected
# architecture, the service entry point exists, the Prisma query engine for this
# platform loads, and bcrypt (when present) loads and hashes. The JavaScript is
# platform-independent; these native libraries are not.

set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <image> <expected-node-arch>" >&2
  exit 2
fi

image=$1
expected_arch=$2

entrypoint=$(docker image inspect --format '{{json .Config.Cmd}}' "$image" \
  | jq -er 'if length == 2 and .[0] == "node" then .[1] else empty end') || {
  echo "the image command is not node <entry point>" >&2
  exit 1
}

check="const fs=require('fs'),path=require('path');const v={arch:process.arch};\
v.entry=fs.existsSync(process.argv[1]);\
const client=path.dirname(require.resolve('@prisma/client/package.json'));\
const generated=path.dirname(require.resolve('.prisma/client/package.json',{paths:[client]}));\
v.engines=fs.readdirSync(generated).filter(f=>/^libquery_engine-.*\\.so\\.node$/.test(f)).filter(f=>{\
try{require(path.join(generated,f));return true}catch(e){return false}});\
try{require.resolve('bcrypt');v.bcrypt=require('bcrypt').compareSync('x',require('bcrypt').hashSync('x',4))}\
catch(e){v.bcrypt=e.code==='MODULE_NOT_FOUND'?'absent':String(e.message)}\
console.log(JSON.stringify(v))"

result=$(docker run --rm --network none --memory 1g --entrypoint node "$image" -e "$check" "$entrypoint" | tail -n 1)
printf '%s\n' "$result" | jq -e --arg arch "$expected_arch" '
  .arch == $arch and .entry == true and (.engines | length) > 0 and (.bcrypt == true or .bcrypt == "absent")
' >/dev/null || {
  echo "image check failed: $result" >&2
  exit 1
}
echo "image runs on $expected_arch: $result"
