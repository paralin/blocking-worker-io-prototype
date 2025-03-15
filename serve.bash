#!/bin/bash

# First build the files
esbuild \
  index.ts \
  worker-host.ts \
  worker-client.ts \
  --bundle \
  --outdir=./dist \
  --format=esm \
  --sourcemap

# Use the Node.js server script to serve with headers
node server.js
