#!/bin/bash
set -euo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"
mkdir -p "$PROJECT_ROOT/dist"
BUILD_ROOT="$(mktemp -d "$PROJECT_ROOT/dist/.eve-build-XXXXXX")"
APP="$BUILD_ROOT/Eve.app"
trap 'rm -rf "$BUILD_ROOT"' EXIT
RUNTIME_NODE=/usr/local/bin/node
[ -x "$RUNTIME_NODE" ] || { echo 'Required Node binary missing: /usr/local/bin/node' >&2; exit 1; }
mkdir -p .eve/runs
swift build --package-path macos --scratch-path .build/macos --configuration release
BIN_DIR="$(swift build --package-path macos --scratch-path .build/macos --configuration release --show-bin-path)"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/bridge" "$APP/Contents/Resources/runtime"
cp "$BIN_DIR/Eve" "$APP/Contents/MacOS/Eve"
# Ship the SwiftPM bundle for relocation; Finder/Dock also need the top-level ICNS.
rm -rf "$APP/Contents/Resources/Eve_Eve.bundle"
cp -R "$BIN_DIR/Eve_Eve.bundle" "$APP/Contents/Resources/Eve_Eve.bundle"
cp macos/Sources/Eve/Resources/Eve.icns "$APP/Contents/Resources/Eve.icns"
# Explicit source allowlist: never copy the workspace, .eve or local config.
rm -rf "$APP/Contents/Resources/src" "$APP/Contents/Resources/bridge/Bridge" "$APP/Contents/Resources/skills"
cp -R macos/Bridge "$APP/Contents/Resources/bridge/Bridge"
cp -R src "$APP/Contents/Resources/src"
cp -R skills "$APP/Contents/Resources/skills"
cp "$RUNTIME_NODE" "$APP/Contents/Resources/runtime/node"
chmod +x "$APP/Contents/MacOS/Eve" "$APP/Contents/Resources/runtime/node"
SOURCE_SHA="$(git rev-parse HEAD)"
# Development builds must not claim to be an exact clean-commit artifact.
if [ -n "$(git status --porcelain --untracked-files=normal)" ]; then
 SOURCE_SHA="${SOURCE_SHA}-dirty"
fi
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Eve</string>
<key>CFBundleIdentifier</key><string>com.luckyscript.eve</string>
<key>CFBundleName</key><string>Eve</string>
<key>CFBundleDisplayName</key><string>Eve</string>
<key>CFBundleIconFile</key><string>Eve.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.3.0</string>
<key>CFBundleVersion</key><string>3</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>EveSourceRevision</key><string>$SOURCE_SHA</string>
<key>NSHumanReadableCopyright</key><string>Eve local native client · ad-hoc signed · not notarized</string>
</dict></plist>
PLIST
printf '%s\n' "$SOURCE_SHA" > "$APP/Contents/Resources/source-revision.txt"
otool -L "$APP/Contents/Resources/runtime/node" > .eve/runs/macos-node-dylibs.txt
if /usr/bin/awk '/compatibility version/ && $1 !~ /^\/System\// && $1 !~ /^\/usr\/lib\// { bad=1 } END { exit !bad }' .eve/runs/macos-node-dylibs.txt; then
 echo 'Node has non-system dylib dependencies; this script does not package those dependencies.' >&2; exit 1
fi
codesign --force --sign - "$APP/Contents/Resources/runtime/node"
codesign --force --sign - "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
plutil -lint "$APP/Contents/Info.plist"
# Never truncate a running executable in-place or leave a half-built application.
if [ -e "$PROJECT_ROOT/dist/Eve.app" ]; then
 mv "$PROJECT_ROOT/dist/Eve.app" "$BUILD_ROOT/Previous.app"
fi
if ! mv "$APP" "$PROJECT_ROOT/dist/Eve.app"; then
 [ ! -e "$BUILD_ROOT/Previous.app" ] || mv "$BUILD_ROOT/Previous.app" "$PROJECT_ROOT/dist/Eve.app"
 exit 1
fi
echo "Built $PROJECT_ROOT/dist/Eve.app (local arm64 client, ad-hoc signed; not notarized)."
