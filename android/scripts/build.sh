#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
export GRADLE_USER_HOME="$PWD/.gradle-user"
if [[ -z "${JAVA_HOME:-}" || ! -x "$JAVA_HOME/bin/java" ]]; then
 export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi
GRADLE_SCRIPT="${EVE_GRADLE_BIN:-$PWD/gradlew}"
/bin/sh "$GRADLE_SCRIPT" --no-daemon --console=plain --max-workers=2 "$@"
if [[ " $* " == *"assembleDebug"* ]]; then
 mkdir -p ../dist
 cp app/build/outputs/apk/debug/app-debug.apk ../dist/Eve-android-debug.apk
fi
