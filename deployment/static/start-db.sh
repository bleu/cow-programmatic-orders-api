#!/usr/bin/env bash

POSTGRES_MAX_CONNECTIONS="${POSTGRES_MAX_CONNECTIONS:-100}"

if [ -n "${POSTGRES_MEMORY_LIMIT:-}" ]; then
    LIMIT_BYTES=$(numfmt --from=iec "${POSTGRES_MEMORY_LIMIT}" 2>/dev/null)
    if [ -z "$LIMIT_BYTES" ] || [ "$LIMIT_BYTES" = "0" ]; then
        echo "Error: Invalid POSTGRES_MEMORY_LIMIT value: $POSTGRES_MEMORY_LIMIT" >&2
        exit 1
    fi
    TOTAL_RAM_MB=$((LIMIT_BYTES / 1024 / 1024))
else
    TOTAL_RAM_KB=$(grep MemTotal /proc/meminfo | awk '{print $2}')
    TOTAL_RAM_MB=$((TOTAL_RAM_KB / 1024))
fi

SHARED_BUFFERS_MB=$((TOTAL_RAM_MB * 20 / 100))
MAINTENANCE_WORK_MEM_MB=$((TOTAL_RAM_MB * 5 / 100))
EFFECTIVE_CACHE_SIZE_MB=$((TOTAL_RAM_MB / 2))
WORK_MEM_MB=$(( (TOTAL_RAM_MB * 25 / 100) / POSTGRES_MAX_CONNECTIONS ))

if [ "$WORK_MEM_MB" -lt 1 ]; then WORK_MEM_MB=1; fi
if [ "$SHARED_BUFFERS_MB" -lt 32 ]; then SHARED_BUFFERS_MB=32; fi
if [ "$MAINTENANCE_WORK_MEM_MB" -lt 16 ]; then MAINTENANCE_WORK_MEM_MB=16; fi

set -x
exec docker-entrypoint.sh \
    -c "max_connections=${POSTGRES_MAX_CONNECTIONS}" \
    -c "shared_buffers=${SHARED_BUFFERS_MB}MB" \
    -c "work_mem=${WORK_MEM_MB}MB" \
    -c "maintenance_work_mem=${MAINTENANCE_WORK_MEM_MB}MB" \
    -c "effective_cache_size=${EFFECTIVE_CACHE_SIZE_MB}MB" \
    -c "max_wal_size=1GB" \
    -c "min_wal_size=256MB" \
    -c "checkpoint_completion_target=0.9" \
    -c "wal_buffers=8MB"
