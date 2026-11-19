#!/bin/bash
# Build the Android app and install it on the phone plugged in over USB (USB debugging on).
#   ./run.sh         app loads the live site (https://alexknight0.github.io/podcast-player/)
#   ./run.sh local   app loads the Mac's working copy through `adb reverse` (port 8765),
#                    for testing site changes before pushing; serves the repo itself
set -euo pipefail
cd "$(dirname "$0")"
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
ADB="$ANDROID_HOME/platform-tools/adb"
CONFIG=android/app/src/main/assets/capacitor.config.json

npx cap sync android
if [ "${1:-}" = "local" ]; then
  # Rewrite the copied config only (capacitor.config.json stays pointed at the live site).
  python3 - "$CONFIG" <<'EOF'
import json, sys
p = sys.argv[1]; c = json.load(open(p))
c["server"]["url"] = "http://localhost:8765/"
c["server"]["cleartext"] = True
json.dump(c, open(p, "w"), indent=2)
EOF
  "$ADB" reverse tcp:8765 tcp:8765
  if ! curl -s -o /dev/null http://localhost:8765/; then
    python3 -m http.server 8765 -d .. >/dev/null 2>&1 &
    echo "started local server on :8765 (pid $!)"
  fi
fi
(cd android && ./gradlew installDebug --console=plain -q)
"$ADB" shell am start -n io.github.alexknight0.podcastplayer/.MainActivity >/dev/null
echo "installed and launched"
