FROM debian:bookworm-slim

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        icecast2 gettext-base ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

COPY icecast.xml.tpl /etc/icecast2/icecast.xml.tpl
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && mkdir -p /var/log/icecast2 \
    && chown -R icecast2 /var/log/icecast2

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget -qO /dev/null http://127.0.0.1:8000/status-json.xsl || exit 1

USER icecast2
ENTRYPOINT ["/entrypoint.sh"]
