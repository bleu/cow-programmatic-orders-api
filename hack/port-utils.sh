#!/bin/bash
# port-utils.sh - Utilities for managing ports

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if a port is in use
check_port() {
    local port=$1
    if lsof -i ":$port" > /dev/null 2>&1; then
        return 0  # Port is in use
    else
        return 1  # Port is free
    fi
}

# Get process using a port
get_port_process() {
    local port=$1
    lsof -i ":$port" -t 2>/dev/null
}

# Kill process using a port
kill_port() {
    local port=$1
    local pid=$(get_port_process "$port")

    if [ -n "$pid" ]; then
        echo -e "${YELLOW}Killing process $pid on port $port${NC}"
        kill -9 "$pid" 2>/dev/null
        sleep 1

        if check_port "$port"; then
            echo -e "${RED}Failed to kill process on port $port${NC}"
            return 1
        else
            echo -e "${GREEN}Port $port is now free${NC}"
            return 0
        fi
    else
        echo -e "${GREEN}Port $port is already free${NC}"
        return 0
    fi
}

# Wait for a port to become available
wait_for_port() {
    local port=$1
    local timeout=${2:-30}
    local elapsed=0

    echo -n "Waiting for port $port to become available..."

    while check_port "$port"; do
        if [ $elapsed -ge $timeout ]; then
            echo -e " ${RED}TIMEOUT${NC}"
            return 1
        fi
        sleep 1
        elapsed=$((elapsed + 1))
        echo -n "."
    done

    echo -e " ${GREEN}OK${NC}"
    return 0
}

# Wait for a port to be listening (service started)
wait_for_service() {
    local port=$1
    local timeout=${2:-60}
    local elapsed=0

    echo -n "Waiting for service on port $port..."

    while ! check_port "$port"; do
        if [ $elapsed -ge $timeout ]; then
            echo -e " ${RED}TIMEOUT${NC}"
            return 1
        fi
        sleep 1
        elapsed=$((elapsed + 1))
        echo -n "."
    done

    echo -e " ${GREEN}OK${NC}"
    return 0
}

# Show usage if run directly
if [ "${BASH_SOURCE[0]}" == "${0}" ]; then
    case "$1" in
        check)
            if [ -z "$2" ]; then
                echo "Usage: $0 check <port>"
                exit 1
            fi
            if check_port "$2"; then
                echo "Port $2 is in use by PID: $(get_port_process "$2")"
                exit 0
            else
                echo "Port $2 is free"
                exit 1
            fi
            ;;
        kill)
            if [ -z "$2" ]; then
                echo "Usage: $0 kill <port>"
                exit 1
            fi
            kill_port "$2"
            ;;
        wait)
            if [ -z "$2" ]; then
                echo "Usage: $0 wait <port> [timeout]"
                exit 1
            fi
            wait_for_port "$2" "${3:-30}"
            ;;
        wait-service)
            if [ -z "$2" ]; then
                echo "Usage: $0 wait-service <port> [timeout]"
                exit 1
            fi
            wait_for_service "$2" "${3:-60}"
            ;;
        *)
            echo "Usage: $0 {check|kill|wait|wait-service} <port> [timeout]"
            echo ""
            echo "Commands:"
            echo "  check <port>              Check if port is in use"
            echo "  kill <port>               Kill process using port"
            echo "  wait <port> [timeout]     Wait for port to be free"
            echo "  wait-service <port> [timeout]  Wait for service to start"
            exit 1
            ;;
    esac
fi
