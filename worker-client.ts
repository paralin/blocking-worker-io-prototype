// Worker Client - responsible for communication with the host worker

// Constants
const MTU = 2048; // Maximum transmission unit per message
const HEADER_SIZE = 16; // 4 bytes for flag, 4 bytes for batch size, 4 bytes for message count, 4 bytes reserved
const MAX_BATCH_SIZE = 10; // Maximum number of messages in a batch
const MAX_BATCH_BYTES = MTU * MAX_BATCH_SIZE; // Maximum bytes in a batch
const MAX_WAIT_TIME = 10000; // 10 seconds timeout for Atomics.wait

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

// Write a batch of messages to the host
function writeBatchToHost(messages: Uint8Array[]): void {
  if (!port) {
    console.error("Message port not initialized");
    return;
  }
  
  if (messages.length === 0) return;
  
  // Create transferable array for each message
  const transferables = messages.map(m => m.buffer);
  
  // Send the batch to the host
  port.postMessage({ type: "toHostBatch", messages }, transferables);
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
        const waitResult = Atomics.wait(int32Array, 0, 0, MAX_WAIT_TIME);

        // If the wait timed out, continue waiting
        if (waitResult === "timed-out") {
          continue;
        }

        // Read batch metadata
        const dataView = new DataView(sharedBuffer!);
        const totalBatchSize = dataView.getUint32(4, true); // Total batch size
        const messageCount = dataView.getUint32(8, true); // Number of messages in batch
        
        if (totalBatchSize > MAX_BATCH_BYTES) {
          console.error(`Batch too large: ${totalBatchSize} bytes exceeds maximum of ${MAX_BATCH_BYTES}`);
          // Set the flag byte back to 0
          Atomics.store(int32Array, 0, 0);
          continue;
        }
        
        // Process all messages in the batch
        let offset = HEADER_SIZE;
        const processedMessages = [];
        
        for (let i = 0; i < messageCount; i++) {
          // Read message length
          const messageLength = dataView.getUint32(offset, true);
          offset += 4;
          
          if (messageLength > MTU) {
            console.error(`Message too large: ${messageLength} bytes exceeds MTU of ${MTU}`);
            continue;
          }
          
          // Create a copy of the message data instead of just a view
          const messageCopy = new Uint8Array(messageLength);
          messageCopy.set(sharedArray!.subarray(offset, offset + messageLength));
          processedMessages.push(messageCopy);
          
          // Move to next message
          offset += messageLength;
          
          // Increment message counter
          messagesReceived++;
        }
        
        // Set the flag byte back to 0 (no data available)
        Atomics.store(int32Array, 0, 0);
        
        // Send an acknowledgment to the host immediately
        port!.postMessage({ type: "ack", ack: true });
        
        // Notify main thread about received messages for statistics
        self.postMessage({
          type: "messageReceived",
          count: messageCount
        });
        
        // Only log detailed message info for the first few messages during a test
        if (!testRunning || messagesReceived <= 5 || messagesReceived % 100 === 0) {
          self.postMessage({
            message: `Received batch of ${messageCount} messages, total ${totalBatchSize} bytes`,
          });
        }

        // During throughput tests, we don't echo back to avoid affecting measurements
        if (!testRunning && processedMessages.length > 0) {
          // Echo the first message back to the host
          const message = processedMessages[0];
          const echoMessage = new Uint8Array(message.length + 6); // Add space for "Echo: "
          const echoPrefix = new TextEncoder().encode("Echo: ");
          echoMessage.set(echoPrefix, 0);
          echoMessage.set(message, echoPrefix.length);
          writeToHost(echoMessage);
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
    readFromHost();
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
