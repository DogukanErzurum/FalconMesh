FROM python:3.12-alpine

WORKDIR /app

RUN pip install --no-cache-dir requests websocket-client

COPY agent.py /app/agent.py

CMD ["python", "/app/agent.py"]
