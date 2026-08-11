#!/bin/bash
# Double-click launcher (macOS). Starts the Suikoden IV editor and opens the browser.
cd "$(dirname "$0")/Editor" || exit 1
exec python3 s4editor.py "../Base ISO/Suikoden IV (USA).iso"
