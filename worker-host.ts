// Worker Host - responsible for communication with the client worker

 // Constants
const HOST_MTU = 2048; // Maximum transmission unit
const HOST_HEADER_SIZE = 8; // 4 bytes for flag and 4 bytes for message length
const BUFFER_SIZE = Math.ceil((HOST_MTU + HOST_HEADER_SIZE) / 4) * 4; // Buffer size adjusted to be a multiple of 4

// Types
type MessageCallback = (data: Uint8Array) => void;

// Function to initialize and manage the host worker
function initHostWorker() {
  // State
  let port: MessagePort | null = null;
  let sharedBuffer: SharedArrayBuffer | null = null;
  let sharedArray: Uint8Array | null = null;
  let messageQueue: Uint8Array[] = [];
  let messageCallback: MessageCallback | null = null;

  // Write data to the shared buffer
  function writeToSharedBuffer(data: Uint8Array): void {
    if (!sharedArray || !sharedBuffer) {
      console.error("Shared array not initialized");
      return;
    }

    if (data.length > HOST_MTU) {
      console.error(`Message too large: ${data.length} bytes exceeds MTU of ${HOST_MTU}`);
      return;
    }

    // Write the message length (4 bytes) at byte offset 4
    const dataView = new DataView(sharedBuffer);
    dataView.setUint32(4, data.length, true); // true for little-endian

    // Write the message data
    sharedArray.set(data, HOST_HEADER_SIZE);

    // Notify the client that data is available
    const int32View = new Int32Array(sharedBuffer);
    Atomics.store(int32View, 0, 1);
    Atomics.notify(int32View, 0, 1);
  }

  // Write data to the client
  function writeToClient(data: Uint8Array): void {
    if (!sharedArray) {
      console.error("Shared array not initialized");
      return;
    }

    // Check if the buffer is available for writing
    const int32View = new Int32Array(sharedBuffer!);
    const isAvailable = Atomics.load(int32View, 0) === 0;

    if (!isAvailable) {
      // Buffer is busy, queue the message
      messageQueue.push(data);
      return;
    }

    // Write to the shared buffer
    writeToSharedBuffer(data);
  }

  // Handle messages from the client
  function handleClientMessage(event: MessageEvent): void {
    const { type, data, ack } = event.data;

    if (type === "toHost" && data instanceof Uint8Array) {
      // Forward received message to the main thread
      const messageText = new TextDecoder().decode(data);
      self.postMessage({
        message: `Received ${data.length} bytes: ${messageText}`,
      });

      // If a message callback is registered, call it
      if (messageCallback) {
        messageCallback(data);
      }
    } else if (type === "ack" && ack === true) {
      // Client acknowledged receiving the message, send the next message if any
      if (messageQueue.length > 0) {
        const nextMessage = messageQueue.shift();
        if (nextMessage) {
          writeToSharedBuffer(nextMessage);
        }
      }
    }
  }

  // Register a callback for incoming messages
  function onMessage(callback: MessageCallback): void {
    messageCallback = callback;
  }

  // Initialize the worker
  self.addEventListener("message", (event) => {
    const { type, port: messagePort, data } = event.data;

    if (type === "init" && messagePort) {
      // Store the message port
      port = messagePort;

      // Create a shared array buffer for communication
      sharedBuffer = new SharedArrayBuffer(BUFFER_SIZE);
      sharedArray = new Uint8Array(sharedBuffer);

      // Set the flag int32 to 0 (no data available)
      const int32View = new Int32Array(sharedBuffer);
      Atomics.store(int32View, 0, 0);

      // Listen for messages from the client worker
      port!.addEventListener("message", handleClientMessage);
      port!.start();

      // Send the shared buffer to the client worker
      port!.postMessage({ type: "sharedBuffer", buffer: sharedBuffer });

      // Notify the main thread that initialization is complete
      self.postMessage({ message: "Host worker initialized" });

      // Set up automatic message sending to client every second
      setInterval(() => {
        const timestamp = new Date().toISOString();
        const message = `Hello Client ${timestamp}`;
        const encoder = new TextEncoder();
        const testMessage = encoder.encode(message);

        // Send message directly to client
        writeToClient(testMessage);

        // Notify the main thread about the sent message
        self.postMessage({
          message: `Sent message to client: ${message}`,
        });
      }, 1000);
    } else if (type === "sendToClient" && data instanceof Uint8Array) {
      // Queue the message to be sent to the client
      writeToClient(data);
    }
  });

  // Return the public API
  return {
    writeToClient,
    onMessage,
  };
}

// Export functions for use in the worker scope
Object.assign(self, { onMessage: initHostWorker().onMessage });
