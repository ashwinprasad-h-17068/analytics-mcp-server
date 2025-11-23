FROM python:3.13-slim

WORKDIR /app

COPY ./requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY ./src/ .

ARG HOSTED_LOCATION_ARG=LOCAL
ENV HOSTED_LOCATION=${HOSTED_LOCATION_ARG}


ENTRYPOINT ["python", "stdio.py"]