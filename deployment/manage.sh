#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<EOF
Usage: $0 <command> [options]

Commands:
  up      Deploy the stack
  down    Tear down the stack

Options:
  -e, --env-file <path>   Path to .env file (required)
  -r, --revision <rev>    Application revision (required for 'up')
  -h, --help              Show this help message
EOF
    exit 1
}

COMMAND="${1:-}"
shift || true

ENV_FILE_PATH=""
APP_REVISION=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        -e|--env-file) ENV_FILE_PATH="$2"; shift 2 ;;
        -r|--revision) APP_REVISION="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) echo "Unknown option: $1"; usage ;;
    esac
done

if [[ -z "$COMMAND" ]]; then echo "Error: command required (up|down)"; usage; fi
if [[ -z "$ENV_FILE_PATH" ]]; then echo "Error: --env-file required"; usage; fi

APP_DEPLOY_DIR="$(dirname "$(realpath "$0")")"
cd "$APP_DEPLOY_DIR"

set -a
source "$ENV_FILE_PATH"
set +a

if [[ -z "${PROJECT_PREFIX:-}" ]]; then
    echo "Error: PROJECT_PREFIX must be set in the env file"
    exit 1
fi

export PROJECT_PREFIX
export APP_REVISION="${APP_REVISION:-latest}"
# Inject schema name: programmatic_orders_<git-sha>
export DATABASE_SCHEMA="programmatic_orders_${APP_REVISION}"

cmd_up() {
    if [[ -z "${APP_REVISION:-}" || "$APP_REVISION" == "latest" ]]; then
        echo "Error: --revision is required for 'up'"
        exit 1
    fi

    echo ">>> Building ponder image..."
    EXTERNAL_RESOURCES=true docker compose \
        -p "${PROJECT_PREFIX}-stack" -f docker-stack.yml \
        build --no-cache --build-arg BUILDKIT_INLINE_CACHE=1

    # Ensure swarm overlay network exists
    NETWORK_NAME="${PROJECT_PREFIX}-default"
    echo ">>> Ensuring swarm network: ${NETWORK_NAME}..."

    NETWORK_SCOPE=$(docker network inspect "$NETWORK_NAME" --format '{{.Scope}}' 2>/dev/null || echo "none")

    if [[ "$NETWORK_SCOPE" == "local" ]]; then
        echo ">>> Migrating local network to overlay..."
        CONTAINERS=$(docker network inspect "$NETWORK_NAME" --format '{{range .Containers}}{{.Name}} {{end}}' 2>/dev/null || echo "")
        for container in $CONTAINERS; do
            docker stop "$container" 2>/dev/null || true
            docker rm "$container" 2>/dev/null || true
        done
        docker compose -p "${PROJECT_PREFIX}" -f docker-compose.yml down --remove-orphans 2>/dev/null || true
        docker network rm "$NETWORK_NAME" 2>/dev/null && NETWORK_SCOPE="none" || true
    fi

    if [[ "$NETWORK_SCOPE" == "none" ]]; then
        docker network create --driver overlay --attachable "$NETWORK_NAME"
    fi

    echo ">>> Starting postgres..."
    docker compose \
        -p "${PROJECT_PREFIX}" -f docker-compose.yml \
        up -d --remove-orphans

    echo ">>> Waiting for postgres to be healthy..."
    sleep 5s

    echo ">>> Deploying stack (DATABASE_SCHEMA=${DATABASE_SCHEMA})..."
    EXTERNAL_RESOURCES=true docker stack deploy \
        --compose-file docker-stack.yml \
        --prune --detach --with-registry-auth --resolve-image never \
        "${PROJECT_PREFIX}"

    echo ">>> Cleaning up old ponder images..."
    IMAGE_NAME="${PROJECT_PREFIX}-ponder"
    OLD_IMAGES=$(docker images --format "{{.Repository}}:{{.Tag}}" "$IMAGE_NAME" | grep -v ":${APP_REVISION}$" || true)
    if [[ -n "$OLD_IMAGES" ]]; then
        echo "$OLD_IMAGES" | xargs -r docker rmi 2>/dev/null || true
    fi
    docker image prune -f 2>/dev/null || true
    docker container prune -f 2>/dev/null || true

    echo ">>> Deploy complete. DATABASE_SCHEMA=${DATABASE_SCHEMA}"
}

cmd_down() {
    echo ">>> Removing stack..."
    EXTERNAL_RESOURCES=true docker stack rm "${PROJECT_PREFIX}" || true

    echo ">>> Stopping postgres..."
    docker compose \
        -p "${PROJECT_PREFIX}" -f docker-compose.yml \
        down -v --remove-orphans || true
}

case "$COMMAND" in
    up) cmd_up ;;
    down) cmd_down ;;
    *) echo "Unknown command: $COMMAND"; usage ;;
esac
