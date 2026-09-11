FROM mcr.microsoft.com/playwright:v1.62.0-noble

USER root
RUN mkdir -p /browser-profile && chown -R pwuser:pwuser /browser-profile
COPY --chown=pwuser:pwuser docker/chatgpt-web-codex-browser/cdp-proxy.mjs /opt/cdp-proxy.mjs
USER pwuser

EXPOSE 9223

CMD ["/bin/sh", "-lc", "rm -f /tmp/.X99-lock /tmp/.X11-unix/X99; node /opt/cdp-proxy.mjs & Xvfb :99 -screen 0 1920x1080x24 -nolisten tcp & until [ -S /tmp/.X11-unix/X99 ]; do sleep 0.2; done; chrome_path=$(find /ms-playwright -path '*/chrome-linux*/chrome' -type f | head -n 1); test -n \"$chrome_path\"; DISPLAY=:99 exec \"$chrome_path\" --no-sandbox --disable-dev-shm-usage --remote-debugging-port=9222 --user-data-dir=/browser-profile about:blank"]
