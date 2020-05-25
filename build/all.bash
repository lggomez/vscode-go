#!/bin/bash -e

# Copyright (C) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License. See LICENSE in the project root for license information.

usage() {
  cat <<EOUSAGE
Usage: $0 [subcommand]
Available subcommands:
  help      - display this help message.
  test      - build and test locally. Some tests may fail if vscode is alreay in use.
  testlocal - build and test in a locally built container.
  ci        - build and test with headless vscode. Requires Xvfb.
EOUSAGE
}

# TODO(hyangah): commands for building docker container and running tests locally with docker run.
root_dir() {
  local script_name=$(readlink -f "${0}")
  local script_dir=$(dirname "${script_name}")
  local parent_dir=$(dirname "${script_dir}")
  echo "${parent_dir}"
}

setup_virtual_display() {
  echo "**** Set up virtual display ****"
  # Start xvfb (an in-memory display server for UNIX-like operating system)
  # so we can launch a headless vscode for testing.
  /usr/bin/Xvfb :99 -screen 0 1024x768x24 > /dev/null 2>&1 &
  trap 'kill "$(jobs -p)"' EXIT
  export DISPLAY=:99
  sleep 3  # Wait for xvfb to be up.
}

go_binaries_info() {
  echo "**** Go version ****"
  which go
  go version
  echo "**** Gopls version ****"
  go version -m "$(which gopls)"
}

run_test() {
  echo "**** Run test ****"
  npm ci
  npm run compile
  npm run lint
  npm run unit-test
  npm test --silent
}

run_test_in_docker() {
  echo "**** Building the docker image ***"
  docker build -t vscode-test-env ./build
  docker run --workdir=/workspace -v "$(pwd):/workspace" vscode-test-env ci
}

prepare_nightly() {
  # Version format: YYYY.MM.DDHH based on the latest commit timestamp.
  # e.g. 2020.1.510 is the version built based on a commit that was made
  #      on 2020/01/05 10:00
  local VER=`git log -1 --format=%cd --date="format:%Y.%-m.%-d%H"`
  local COMMIT=`git log -1 --format=%H`
  echo "**** Preparing nightly release : $VER ***"

  # Update package.json
  (cat package.json | jq --arg VER "${VER}" '
.version=$VER |
.preview=true |
.name="go-nightly" |
.displayName="Go Nightly" |
.publisher="golang" |
.description="Rich Go language support for Visual Studio Code (Nightly)" |
.author.name="Go Team at Google" |
.repository.url="https://github.com/golang/vscode-go" |
.bugs.url="https://github.com/golang/vscode-go/issues"
') > /tmp/package.json && mv /tmp/package.json package.json

  # Replace CHANGELOG.md with CHANGELOG.md.nightly + Release commit info.
  printf "**Release ${VER} @ ${COMMIT}** \n\n" | cat - CHANGELOG.md.nightly > /tmp/CHANGELOG.md.new && mv /tmp/CHANGELOG.md.new CHANGELOG.md
  # Replace the heading of README.md with the heading for Go Nightly.
  sed '/^# Go for Visual Studio Code$/d' README.md | cat README.md.nightly - > /tmp/README.md.new && mv /tmp/README.md.new README.md
}

main() {
  cd "$(root_dir)"  # always run from the script root.
  case "$1" in
    "help"|"-h"|"--help")
      usage
      exit 0
      ;;
    "test")
      go_binaries_info
      run_test
      ;;
    "testlocal")
      run_test_in_docker
      ;;
    "ci")
      go_binaries_info
      setup_virtual_display
      run_test
      ;;
    "prepare_nightly")
      prepare_nightly
      ;;
    *)
      usage
      exit 2
  esac
}
main $@
