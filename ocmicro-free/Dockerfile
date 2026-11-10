# Sandbox for ocmicro-free. The agent runs every command as root with no permission
# checks, so this container is the only boundary between it and your machine.
#
# From the repo root:
#   docker build -t ocmicro-free ocmicro-free
#   docker run --rm -it \
#     -v "$PWD/ocmicro-free/.groq_key:/app/.groq_key:ro" \
#     -v "$PWD/ocmicro-free/workspace:/workspace" \
#     -v "$PWD/ocmicro-free/logs:/app/logs" \
#     ocmicro-free
#
# /workspace is bind-mounted to ocmicro-free/workspace, so files the agent writes show
# up there on the host as they change, and survive the container. Session logs
# go to /app/logs, bind-mounted to ocmicro-free/logs the same way.
FROM alpine:3.22

RUN apk add --no-cache bash python3

COPY main.py system_prompt.py bash_description.py printer.py utils.py html_logger.py tools.py history.py /app/

# Session logs are written here; mount ocmicro-free/logs over it to see them on the host.
ENV OCMICRO_LOG_DIR=/app/logs

WORKDIR /workspace
ENTRYPOINT ["python3", "/app/main.py"]
