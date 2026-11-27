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

ARG CFSOLVE_COMMIT=3d2f67ed56df29be6ceba1de60b7ab9077e554c8
RUN git clone https://github.com/chris124567/cfsolve.git /build/cfsolve && \
    cd /build/cfsolve && git checkout $CFSOLVE_COMMIT
WORKDIR /build/cfsolve
RUN rm -f rust-toolchain.toml
RUN rustup default stable && cargo build --release --bin challenge

# ── Stage 2: Runtime image (Node.js 20 + Python + curl_cffi + cfsolve) ──
FROM node:20-slim

WORKDIR /app

# Rendszerfüggőségek (Python3, pip, ca-certificates, curl)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# curl_cffi Python modul a TLS ujjlenyomat (Chrome 120) közvetítéshez
RUN pip3 install --no-cache-dir --break-system-packages curl_cffi

# cfsolve Rust bináris átvétele a builder stage-ből
COPY --from=builder /build/cfsolve/target/release/challenge /app/cfsolve
RUN chmod +x /app/cfsolve

# Node.js függőségek telepítése
COPY package*.json ./
RUN npm install --production

# Projektfájlok bemásolása (benne a profiles/ mappa)
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
