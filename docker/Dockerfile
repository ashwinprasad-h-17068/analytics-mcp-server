FROM python:3.13-slim AS base

WORKDIR /app

COPY ./requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ./src/ ./src/

# stdio image
FROM base AS stdio
ENTRYPOINT ["python", "-m", "src.stdio"]

# http image
FROM base AS http
ENTRYPOINT ["python", "-m", "src.http_server"]