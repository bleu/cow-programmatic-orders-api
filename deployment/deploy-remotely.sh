#!/usr/bin/env bash
set -exo pipefail

REPO_ROOT_DIR=$(git rev-parse --show-toplevel)
APP_REVISION=$(git rev-parse --short HEAD)

DEPLOY_TARGET="${1:-}"
ENV_FILE_PATH="${2:-.env}"

if [[ -z "$DEPLOY_TARGET" ]]; then
    echo "Usage: $0 <deploy_target> [env_file_path]"
    exit 1
fi

if [[ "$DEPLOY_TARGET" == "-" ]]; then
    # Local deployment
    TARGET_DEPLOY_DIR="$REPO_ROOT_DIR"
    APP_DEPLOY_DIR="$TARGET_DEPLOY_DIR/deployment"

    bash "$APP_DEPLOY_DIR/manage.sh" ${MANAGE_CMD_OVERRIDE:-up} \
        --env-file "$ENV_FILE_PATH" \
        --revision "$APP_REVISION"
elif [[ "$DEPLOY_TARGET" =~ ^[^:]+:.+ ]]; then
    # Remote deployment via SSH
    SSH_HOST=$(echo "$DEPLOY_TARGET" | cut -d':' -f1)
    REMOTE_PATH=$(echo "$DEPLOY_TARGET" | cut -d':' -f2-)

    # Sync repository to remote
    # .env is excluded — copied separately via scp to preserve server secrets
    rsync -avz --delete \
        --mkpath \
        --exclude='.git' \
        --exclude='node_modules' \
        --exclude='.env' \
        --exclude='.env.local' \
        --exclude='.vite' \
        --exclude='*.log' \
        --exclude='tmp/' \
        "$REPO_ROOT_DIR/" "$SSH_HOST:$REMOTE_PATH/"

    # Copy .env to deployment directory on remote (separate from rsync)
    REMOTE_ENV_PATH="$REMOTE_PATH/deployment/.env"
    scp "$ENV_FILE_PATH" "$SSH_HOST:$REMOTE_ENV_PATH"

    APP_DEPLOY_DIR="$REMOTE_PATH/deployment"
    MANAGE_CMD="${MANAGE_CMD_OVERRIDE:-up}"

    # Run manage.sh on remote
    ssh "$SSH_HOST" "cd $APP_DEPLOY_DIR && bash manage.sh $MANAGE_CMD --env-file .env --revision $APP_REVISION"
else
    echo "Error: <deploy_target> must be '-' or SSH_HOST:PATH"
    exit 1
fi
