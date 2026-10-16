#!/bin/bash
cd "$(dirname "$(readlink -f "$0")")" || exit 1
unset ELECTRON_RUN_AS_NODE
if [ -x "./node_modules/electron/dist/electron" ]; then
    exec ./node_modules/electron/dist/electron . "$@"
else
    exec ./node_modules/.bin/electron . "$@"
fi
