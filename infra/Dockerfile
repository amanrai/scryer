FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://bin.equinox.io/c/ekMN3bCZFUn/forego-stable-linux-amd64.tgz \
    | tar -xz -C /usr/local/bin forego \
    && chmod +x /usr/local/bin/forego

WORKDIR /app

CMD ["forego", "start"]
