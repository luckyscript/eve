#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SDK_DIR="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
export ANDROID_AVD_HOME="$PROJECT_ROOT/.build/android-avd"
export ANDROID_USER_HOME="$PROJECT_ROOT/.build/android-user"
export ANDROID_SDK_ROOT="$SDK_DIR"
AVD_DIR="$ANDROID_AVD_HOME/EveRemoteTest.avd"
IMAGE_DIR="$SDK_DIR/system-images/android-36.1/google_apis_playstore/arm64-v8a"
[ -f "$IMAGE_DIR/system.img" ] || { echo 'Install an API 36.1 Google Play ARM64 image, or create an AVD in Android Studio.' >&2; exit 1; }
mkdir -p "$AVD_DIR" "$ANDROID_USER_HOME"
cat > "$ANDROID_AVD_HOME/EveRemoteTest.ini" <<EOF
avd.ini.encoding=UTF-8
path=$AVD_DIR
target=android-36
EOF
cat > "$AVD_DIR/config.ini" <<EOF
AvdId=EveRemoteTest
avd.ini.encoding=UTF-8
abi.type=arm64-v8a
hw.cpu.arch=arm64
hw.cpu.ncore=2
hw.ramSize=2048
hw.gpu.enabled=yes
hw.gpu.mode=swiftshader_indirect
hw.lcd.width=1080
hw.lcd.height=1920
hw.lcd.density=420
hw.keyboard=yes
hw.mainKeys=no
disk.dataPartition.size=2G
image.sysdir.1=$IMAGE_DIR/
tag.id=google_apis_playstore
tag.display=Google Play
PlayStore.enabled=true
showDeviceFrame=no
fastboot.forceColdBoot=yes
EOF
exec "$SDK_DIR/emulator/emulator" -avd EveRemoteTest -port 5580 -no-window -no-audio -no-boot-anim -no-snapshot -gpu swiftshader_indirect "$@"
