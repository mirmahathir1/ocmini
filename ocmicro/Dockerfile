# Sandbox for ocmicro. The agent runs every command as root with no permission
# checks, so this container is the only boundary between it and your machine.
#
# From the repo root:
#   docker build -t ocmicro ocmicro
#   docker run --rm -it \
#     -v "$PWD/ocmicro/.openai_key:/app/.openai_key:ro" \
#     -v "$PWD/ocmicro/workspace:/workspace" \
#     -v "$PWD/ocmicro/logs:/app/logs" \
#     ocmicro
#
# /workspace is bind-mounted to ocmicro/workspace, so files the agent writes show
# up there on the host as they change, and survive the container. Session logs
# go to /app/logs, bind-mounted to ocmicro/logs the same way.
FROM alpine:3.22

RUN apk add --no-cache bash python3

COPY main.py system_prompt.py bash_description.py printer.py utils.py html_logger.py tools.py history.py /app/

# Session logs are written here; mount ocmicro/logs over it to see them on the host.
ENV OCMICRO_LOG_DIR=/app/logs

WORKDIR /workspace
ENTRYPOINT ["python3", "/app/main.py"]
