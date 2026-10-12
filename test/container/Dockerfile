# The e2e's separate environment (PLAN-526): a pinned node and a pinned dsh.
# plumb is mounted at run time (test/e2e-container.sh --plumb), and so is this
# repo, so the image never holds the code under test.
FROM node:22.23.3-bookworm

ARG DSH_VERSION=0.2.0-rc.2
RUN mkdir -p /opt/dsh && cd /opt/dsh \
 && npm init -y > /dev/null \
 && npm install --no-audit --no-fund --loglevel=error "@deepseek-ai/dsh@${DSH_VERSION}"

ENV DSH_PKG=/opt/dsh/node_modules/@deepseek-ai/dsh \
    DSH_BIN=/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
    PLUMB_BIN=/opt/plumb/plumb
