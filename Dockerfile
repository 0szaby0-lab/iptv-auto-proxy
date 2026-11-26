# ── Stage 1: Build cfsolve Turnstile solver ──
FROM rust:bookworm AS builder

WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends \
    cmake \
    clang \
    libclang-dev \
    build-essential \
    perl \
    git \
    pkg-config \
    libssl-dev \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN git clone --depth 1 https://github.com/chris124567/cfsolve.git /build/cfsolve
WORKDIR /build/cfsolve
RUN rm -f rust-toolchain.toml
RUN rustup default stable && cargo build --release --bin challenge

# ── Stage 2: Runtime image (Node.js 20 + Python + Chromium + xvfb + DrissionPage) ──
FROM node:20-slim

WORKDIR /app

# Rendszerfüggőségek (Python3, pip, Chromium, xvfb, curl, ca-certificates)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    chromium \
    xvfb \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Python modulok (DrissionPage a Turnstile bypass-hoz, curl_cffi a TLS ujjlenyomathoz)
RUN pip3 install --no-cache-dir --break-system-packages DrissionPage curl_cffi

# cfsolve Rust bináris átvétele a builder stage-ből
COPY --from=builder /build/cfsolve/target/release/challenge /app/cfsolve
RUN chmod +x /app/cfsolve

# Node.js függőségek telepítése
COPY package*.json ./
RUN npm install --production

# Projektfájlok bemásolása
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
