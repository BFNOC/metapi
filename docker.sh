TAG=$(git rev-parse --short HEAD)

  docker buildx build \
    --build-arg CACHE_BUST=$(date +%s) \
    --build-arg BUILD_COMMIT=$TAG \
    --platform linux/amd64 \
    -f docker/Dockerfile \
    -t hfxmci/metapi:$TAG \
    -t hfxmci/metapi:latest \
    -t hfxmci/metapi:1.3.0-fork.9 \
    --push .