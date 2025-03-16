// Worker Client - responsible for communication with the host worker

// Constants
const CLIENT_MTU = 2048; // Maximum transmission unit
const CLIENT_HEADER_SIZE = 8; // 4 bytes for flag and 4 bytes for message length
const MAX_WAIT_TIME = 10000; // 10 seconds timeout for Atomics.wait

// Function to initialize and manage the client worker
function initClientWorker() {
  // State
  let port: MessagePort | null = null;
  let sharedBuffer: SharedArrayBuffer | null = null;
  let sharedArray: Uint8Array | null = null;
  let int32Array: Int32Array | null = null;
  let messagesReceived = 0;
  let testRunning = false;

  // Write data to the host
  function writeToHost(data: Uint8Array): void {
    if (!port) {
      console.error("Message port not initialized");
      return;
    }

    // Send the message to the host
    port.postMessage({ type: "toHost", data }, [data.buffer]);
  }

  // Start the reader thread
  function startReaderThread(): void {
    // This would be a WebAssembly process in the real implementation
    // For now, we'll simulate it with a worker thread
    readFromHost();
  }

  // Read data from the host using Atomics.wait
  function readFromHost(): void {
    if (!sharedBuffer || !int32Array || !sharedArray) {
      console.error("Shared buffer not initialized");
      return;
    }

    const readLoop = async () => {
      while (true) {
        try {
          // Wait for data to be available (byte at index 0 == 1)
          const waitResult = Atomics.wait(int32Array!, 0, 0, MAX_WAIT_TIME);

          // If the wait timed out, continue waiting
          if (waitResult === "timed-out") {
            continue;
          }

          // Read the message length (4 bytes) at byte offset 4
          const dataView = new DataView(sharedBuffer!);
          const messageLength = dataView.getUint32(4, true); // true for little-endian

          if (messageLength > CLIENT_MTU) {
            console.error(`Message too large: ${messageLength} bytes`);
            // Set the flag byte back to 0
            Atomics.store(int32Array!, 0, 0);
            continue;
          }

          // Read the message data - use a more efficient approach with a view instead of copying
          // This avoids memory allocation and copying overhead
          const messageView = sharedArray!.subarray(CLIENT_HEADER_SIZE, CLIENT_HEADER_SIZE + messageLength);
          
          // Set the flag byte back to 0 (no data available)
          Atomics.store(int32Array!, 0, 0);

          // Send an acknowledgment to the host immediately
          port!.postMessage({ type: "ack", ack: true });

          // Increment message counter
          messagesReceived++;

          // Notify main thread about received message for statistics
          // Use a more aggressive batching approach to reduce main thread overhead
          if (messagesReceived % 100 === 0) {
            self.postMessage({
              type: "messageReceived",
              count: 100
            });
          }

          // Only log detailed message info for the first few messages during a test
          // to avoid overwhelming the UI
          if (
            !testRunning ||
            messagesReceived <= 5 ||
            messagesReceived % 100 === 0
          ) {
            self.postMessage({
              message: `Received ${messageLength} bytes`,
            });
          }

          // During throughput tests, we don't echo back to avoid affecting measurements
          if (!testRunning) {
            // Echo the message back to the host
            const echoMessage = new Uint8Array(message.length + 6); // Add space for "Echo: "
            const echoPrefix = new TextEncoder().encode("Echo: ");
            echoMessage.set(echoPrefix, 0);
            echoMessage.set(message, echoPrefix.length);
            writeToHost(echoMessage);
          }

          // No processing delay during throughput tests
          if (!testRunning) {
            // Simulate some processing time
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        } catch (error) {
          console.error("Error in read loop:", error);
          // Continue the loop even if there's an error
        }
      }
    };

    readLoop();
  }

  // Handle messages from the host
  function handleHostMessage(event: MessageEvent): void {
    const { type, buffer, testMode } = event.data;

    if (type === "sharedBuffer" && buffer instanceof SharedArrayBuffer) {
      // Store the shared buffer
      sharedBuffer = buffer;
      sharedArray = new Uint8Array(sharedBuffer);
      int32Array = new Int32Array(sharedBuffer);

      // Notify the main thread that the shared buffer has been received
      self.postMessage({
        message: "Shared buffer received, starting reader thread",
      });

      // Start the reader thread
      startReaderThread();
    } else if (type === "startTest") {
      // Enter test mode
      testRunning = true;
      messagesReceived = 0;
      self.postMessage({
        message: "Client entered test mode",
      });
    } else if (type === "stopTest") {
      // Exit test mode
      testRunning = false;
      self.postMessage({
        message: `Client exited test mode, received ${messagesReceived} messages`,
      });
    }
  }

  // Initialize the worker
  self.addEventListener("message", (event) => {
    const { type, port: messagePort, data } = event.data;

    if (type === "init" && messagePort) {
      // Store the message port
      port = messagePort;

      // Listen for messages from the host worker
      port.addEventListener("message", handleHostMessage);
      port.start();

      // Notify the main thread that initialization is complete
      self.postMessage({
        message: "Client worker initialized, waiting for shared buffer",
      });
    } else if (type === "sendToHost" && data instanceof Uint8Array) {
      // Send the message to the host
      writeToHost(data);
    } else if (type === "startTest") {
      // Forward to host message handler with the test parameters
      handleHostMessage({
        data: {
          type: "startTest",
          testMode: true,
        },
      } as MessageEvent);
    } else if (type === "stopTest") {
      // Forward to host message handler
      handleHostMessage({ data: { type: "stopTest" } } as MessageEvent);
    }
  });

  // Return the public API
  return {
    writeToHost,
  };
}

// Initialize the client worker
initClientWorker();
