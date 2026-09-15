# stillos-notary-mcp — MCP stdio server
#
# Glama grades quality by RUNNING the server: it must start and answer an
# introspection request. That is the whole contract this image has to satisfy,
# so it does the least possible to satisfy it.
#
# The package has ZERO required dependencies. `x402-fetch` and `viem` are
# optionalDependencies used only by the paid x402 settlement paths; without
# them the server still starts and every free-tier tool still works, which is
# what introspection exercises. They are installed anyway so the image is the
# real server rather than a reduced one, but the build does not fail if the
# registry is unreachable for them.

FROM node:22-alpine

WORKDIR /app

# Copy the manifest first so dependency resolution is cached independently of
# source edits.
COPY package.json ./

# --omit=dev: no dev deps exist, stated rather than assumed.
# `|| true`: optional deps are optional. A registry hiccup on x402-fetch/viem
# must not turn into a failed build of a server that does not need them.
RUN npm install --omit=dev --no-audit --no-fund || true

# Only the files package.json already declares under "files".
COPY index.cjs mcp.cjs bin.cjs README.md LICENSE ./

ENV NODE_ENV=production

# Run as a non-root user. The server holds no keys and writes nothing to disk;
# there is no reason for it to be root inside the container.
USER node

# stdio MCP server. No port is exposed because there is nothing to expose —
# transport is stdin/stdout.
ENTRYPOINT ["node", "bin.cjs", "mcp"]
