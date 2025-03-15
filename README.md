# Worker I/O Prototype

We are designing an approach for communication between two Workers creating a
transport where Uint8Array are queued and transmitted between the two Workers.

## Getting Started

To run this prototype:

```bash
npm run serve
```

This will:

1. Build the TypeScript files with esbuild
2. Start a custom Node.js server with:
   - Security headers for SharedArrayBuffer
   - Custom 404 error handling
   - Proxy to esbuild's development server

## Design

To share memory using SharedArrayBuffer objects from one agent in the cluster to
another (an agent is either the web page's main program or one of its web
workers), postMessage and structured cloning is used.

- We create two WebWorker, the "host" and the "client"
- We create the host WebWorker first, create a MessagePort, and call postMessage
  with "init" passing the MessagePort port1 to the host WebWorker.
- We create the client WebWorker second, and call postMessage with an "init"
  passing the MessagePort port2 to the client WebWorker.
- The host WebWorker should create a SharedArrayBuffer and send it via port1 to
  port2. The client WebWorker should wait for this first message before
  continuing.
- At this point we have the "host" WebWorker with port1 and SharedArrayBuffer
  and the "client" WebWorker with port2 and SharedArrayBuffer.

Requirements:

- The "host" WebWorker can use normal js event handlers, uses onmessage on port1
  for reading, and can only use Atomics functions for writing messages to the
  SharedArrayBuffer. It should queue messages to tx in an array.
- The "client" WebWorker can only use the SharedArrayBuffer and Atomics.wait and
  other Atomics functions for reading and postMessage on port2 for writing.
- We need to create a two-way Uint8Array ordered message stream between the two
  with these primitives.
- Byte at index 0 in the SharedArrayBuffer will signal if data is available to
  read. The client WebWorker MUST not read from the SharedArrayBuffer unless it
  is set to "1" and the host WebWorker MUST not write to the SharedArrayBuffer
  unless it is set to "0".
- We will define a maximum message size of 2048 up-front (the MTU) and messages
  will not exceed that size when passed to the write function.

General approach for writing from host to client:

1. Host: check byte #1 in the SharedArrayBuffer. If it's 1, queue the message
   locally and return. If it's 0, write a 4 byte integer with the message length
   to index 4 and the message contents after it in the SharedArrayBuffer, then
   use Atomics.store to set index 0 to 1.

2. Client: use Atomics.wait in a blocking function to wait for either a timeout
   (third parameter to wait) or for index 0 of the SharedArrayBuffer to be set
   to 1. Read the integer with the message length. Read the message contents to
   a Uint8Array. Set position 0 to 0. Return the uint8array. Send a message with
   postMessage on port2 acking receiving the message.

3. Host: upon receiving the ack, check if there are any messages queued to
   transmit, if so, transmit the next message.

General approach for writing from client to host:

1. Client: call postMessage on port2 with the Uint8Array.
2. Host: handle the incoming Uint8Array with onmessage. Emit it to the message callback.

Review this design proposal, with the following in mind:

- It is necessary to have this asymmetric communication pattern because we can
  leverage the performance of the simple postMessage queuing on the MessagePort
  for client => host, but we MUST use the SharedArrayBuffer approach for host =>
  client since the client is running a WebAssembly process that can only use
  blocking / polling I/O, and can use Atomics.wait to wait for a
  SharedArrayBuffer but cannot use normal js event handlers.
- We don't need a ring buffer here since we are sending only one message at a
  time and removing it from the SharedArrayBuffer once received, and we need
  guaranteed lossless message delivery.

