#!/bin/bash
# run_silent.sh - Run a command silently, only showing output on failure

# Usage: ./hack/run_silent.sh "command to run" "description"

COMMAND="$1"
DESCRIPTION="${2:-Running command}"

# Create temp file for output
OUTPUT_FILE=$(mktemp)

echo -n "$DESCRIPTION... "

# Run command and capture output
if eval "$COMMAND" > "$OUTPUT_FILE" 2>&1; then
    echo "OK"
    rm -f "$OUTPUT_FILE"
    exit 0
else
    EXIT_CODE=$?
    echo "FAILED"
    echo ""
    echo "Command: $COMMAND"
    echo "Exit code: $EXIT_CODE"
    echo ""
    echo "Output:"
    cat "$OUTPUT_FILE"
    rm -f "$OUTPUT_FILE"
    exit $EXIT_CODE
fi
