FROM python:3.13-slim AS base

WORKDIR /app

COPY ./requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ./src/ .

# stdio image
FROM base AS stdio
ENTRYPOINT ["python", "stdio.py"]

# http image
FROM base AS http
ENTRYPOINT ["python", "http.py"]