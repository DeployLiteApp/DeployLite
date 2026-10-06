FROM docker.io/library/busybox:1.37.0-musl@sha256:5cec3fc171c87218698e85a52af7087de727372aae264a787b8112901a5b0092 AS fixture

COPY --chmod=0444 healthz /www/healthz
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=1s --timeout=1s --start-period=2s --retries=2 CMD ["/bin/busybox", "wget", "-q", "-T", "1", "-Y", "off", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
CMD ["/bin/busybox", "httpd", "-f", "-p", "8080", "-h", "/www"]

FROM fixture AS a
COPY --chmod=0444 a/version /www/version

FROM fixture AS h
COPY --chmod=0444 h/version /www/version
