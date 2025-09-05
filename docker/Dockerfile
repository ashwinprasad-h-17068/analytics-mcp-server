FROM python:3.11-slim

WORKDIR /app

COPY ./src/ .
COPY ./requirements.txt .

RUN pip install --no-cache-dir -r requirements.txt

ARG QUERY_DATA_TOOL_RESULT_LIMIT=20
ENV QUERY_DATA_TOOL_RESULT_LIMIT=$QUERY_DATA_TOOL_RESULT_LIMIT

ENTRYPOINT ["python", "main.py"]