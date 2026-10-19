FROM dhi.io/node:24-alpine-dev AS frontend-build

WORKDIR /app/frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
RUN npm run build

FROM dhi.io/rust:1-dev AS rust-build
WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release

FROM dhi.io/rust:1
WORKDIR /app

COPY --from=rust-build /app/target/release/project ./project
COPY --from=frontend-build /app/frontend/dist ./frontend/dist
COPY migrations ./migrations

EXPOSE 8080
CMD ["./project"]