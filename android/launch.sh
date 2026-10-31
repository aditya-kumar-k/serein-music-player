#!/bin/bash
cd "$(dirname "$(readlink -f "$0")")" || exit 1
unset ELECTRON_RUN_AS_NODE
exec ./node_modules/.bin/electron . "$@"
