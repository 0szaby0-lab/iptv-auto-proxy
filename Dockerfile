# ── Stage 1: Build cfsolve Turnstile solver & analysis tools ──
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
RUN rustup default stable && cargo build --release \
    --bin challenge \
    --example check_answers \
    --example rebase_reference \
    --example build_profile \
    --example capture_session \
    --example disassemble

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

# cfsolve Rust bináris és profil-eszközök átvétele a builder stage-ből
COPY --from=builder /build/cfsolve/target/release/challenge /app/cfsolve
COPY --from=builder /build/cfsolve/target/release/examples/check_answers /app/cf_check_answers
COPY --from=builder /build/cfsolve/target/release/examples/rebase_reference /app/cf_rebase_reference
COPY --from=builder /build/cfsolve/target/release/examples/build_profile /app/cf_build_profile
COPY --from=builder /build/cfsolve/target/release/examples/capture_session /app/cf_capture_session
COPY --from=builder /build/cfsolve/target/release/examples/disassemble /app/cf_disassemble
COPY --from=builder /build/cfsolve/src/stage2/reference.json /app/reference.json
COPY --from=builder /build/cfsolve/src/stage2/reference.rs /app/reference.rs
RUN chmod +x /app/cfsolve /app/cf_*

# Node.js függőségek telepítése
COPY package*.json ./
RUN npm install --production

# Projektfájlok bemásolása (benne a profiles/ és captures/ mappa)
COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
