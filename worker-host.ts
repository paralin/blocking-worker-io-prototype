// Worker Host - responsible for communication with the client worker

// Constants
const MTU = 2048; // Maximum transmission unit per message
const HEADER_SIZE = 16; // 4 bytes for flag, 4 bytes for batch size, 4 bytes for message count, 4 bytes reserved
const MAX_BATCH_SIZE = 10; // Maximum number of messages in a batch
const MAX_BATCH_BYTES = MTU * MAX_BATCH_SIZE; // Maximum bytes in a batch
const BUFFER_SIZE = Math.ceil((MAX_BATCH_BYTES + HEADER_SIZE) / 4) * 4; // Buffer size adjusted to be a multiple of 4

// Types
type MessageCallback = (data: Uint8Array) => void;

// State
let port: MessagePort | null = null;
let sharedBuffer: SharedArrayBuffer | null = null;
let sharedArray: Uint8Array | null = null;
let messageQueue: Uint8Array[] = [];
let messageCallback: MessageCallback | null = null;
let testRunning = false;
let testMessageSize = 1024;
let maxBatchSize = 0;
let totalBatchCount = 0;
let totalBatchMessages = 0;
const MAX_QUEUE_SIZE = 200; // Maximum number of messages in the queue for backpressure

// Create a test message of specified size
function createTestMessage(size: number): Uint8Array {
  const message = new Uint8Array(size);
  // Fill with random data
  for (let i = 0; i < size; i++) {
    message[i] = Math.floor(Math.random() * 256);
  }
  return message;
}

// Write a batch of messages to the shared buffer
function writeBatchToSharedBuffer(messages: Uint8Array[]): void {
  if (!sharedArray || !sharedBuffer) {
    console.error("Shared array not initialized");
    return;
  }

  if (messages.length === 0) return;

  // Calculate total batch size
  let totalSize = 0;
  for (const msg of messages) {
    totalSize += msg.length;
  }

  if (totalSize > MAX_BATCH_BYTES) {
    console.error(
      `Batch too large: ${totalSize} bytes exceeds maximum of ${MAX_BATCH_BYTES}`,
    );
    return;
  }

  const dataView = new DataView(sharedBuffer);

  // Write batch metadata
  dataView.setUint32(4, totalSize, true); // Total batch size in bytes
  dataView.setUint32(8, messages.length, true); // Number of messages in batch

  // Write each message with its length prefix
  let offset = HEADER_SIZE;
  for (const msg of messages) {
    // Write message length
    dataView.setUint32(offset, msg.length, true);
    offset += 4;

    // Write message data
    sharedArray.set(msg, offset);
    offset += msg.length;
  }

  // Notify the client that data is available
  const int32View = new Int32Array(sharedBuffer);
  Atomics.store(int32View, 0, 1);
  Atomics.notify(int32View, 0, 1);

  // Update batch statistics
  totalBatchCount++;
  totalBatchMessages += messages.length;
  maxBatchSize = Math.max(maxBatchSize, messages.length);

  // Report messages sent to main thread for statistics
  self.postMessage({
    type: "messageSent",
    size: totalSize,
    count: messages.length,
    avgBatchSize: totalBatchMessages / totalBatchCount,
    maxBatchSize: maxBatchSize,
  });
}

// Write data to the client
function writeToClient(data: Uint8Array): void {
  if (!sharedArray) {
    console.error("Shared array not initialized");
    return;
  }

  // Apply backpressure if queue is too large
  if (messageQueue.length >= MAX_QUEUE_SIZE) {
    // Drop the message or wait - for now we'll just return
    return;
  }

  // Queue the message
  messageQueue.push(data);

  // Report queue depth to main thread
  reportQueueStats();

  // Try to process the queue immediately
  processQueue();
}

// Process the message queue
function processQueue(): void {
  if (messageQueue.length === 0) return;

  // Check if the buffer is available for writing
  const int32View = new Int32Array(sharedBuffer!);
  const isAvailable = Atomics.load(int32View, 0) === 0;

  if (isAvailable) {
    // Take up to MAX_BATCH_SIZE messages from the queue
    // Always try to fill the batch to MAX_BATCH_SIZE when queue has enough messages
    const batchSize = Math.min(MAX_BATCH_SIZE, messageQueue.length);
    const batch = messageQueue.splice(0, batchSize);

    // Send the batch
    writeBatchToSharedBuffer(batch);

    // Report updated queue stats
    reportQueueStats();

    // Note: We don't schedule another processQueue here
    // The client's "ack" message will trigger the next batch processing
  }
}

// Report queue statistics to the main thread
function reportQueueStats(): void {
  self.postMessage({
    type: "stats",
    queueDepth: messageQueue.length,
  });
}

// Handle messages from the client
function handleClientMessage(event: MessageEvent): void {
  const { type, data, messages, ack } = event.data;

  if (type === "toHost" && data instanceof Uint8Array) {
    // If a message callback is registered, call it
    if (messageCallback) {
      messageCallback(data);
    }
  } else if (type === "toHostBatch" && Array.isArray(messages)) {
    // Process batch of messages from client
    const totalBytes = messages.reduce((sum, msg) => sum + msg.length, 0);

    self.postMessage({
      message: `Received batch of ${messages.length} messages, total ${totalBytes} bytes from client`,
    });

    // If a message callback is registered, call it for each message
    if (messageCallback) {
      for (const msg of messages) {
        messageCallback(msg);
      }
    }
  } else if (type === "ack" && ack === true) {
    // Client acknowledged receiving the message, process the queue immediately
    // This is critical for maintaining high throughput with full batches
    processQueue();
  }
}

// Start the throughput test
function startThroughputTest(messageSize: number): void {
  if (testRunning) return;

  testRunning = true;
  testMessageSize = messageSize;

  // Reset batch statistics
  maxBatchSize = 0;
  totalBatchCount = 0;
  totalBatchMessages = 0;

  // Pre-generate a test message to avoid overhead during the test
  const testMessage = createTestMessage(testMessageSize);

  // Function to send messages as fast as possible
  const sendMessages = () => {
    if (!testRunning) return;

    // Fill the queue to MAX_QUEUE_SIZE to ensure we have enough messages
    // for full batches
    while (messageQueue.length < MAX_QUEUE_SIZE && testRunning) {
      writeToClient(testMessage);
    }

    // Schedule next fill check
    setTimeout(sendMessages, 10);
  };

  // Start sending messages
  sendMessages();

  // Kick off the first batch processing
  processQueue();

  // Report queue stats periodically
  setInterval(reportQueueStats, 100);
}

// Stop the throughput test
function stopThroughputTest(): void {
  testRunning = false;

  // Log final statistics
  self.postMessage({
    type: "testComplete",
    message: `Host test complete: Sent ${totalBatchMessages} messages in ${totalBatchCount} batches, avg batch size: ${(totalBatchMessages / totalBatchCount).toFixed(2)}, max batch size: ${maxBatchSize}`,
    stats: {
      messagesSent: totalBatchMessages,
      batchesSent: totalBatchCount,
      avgBatchSize: totalBatchMessages / totalBatchCount,
      maxBatchSize: maxBatchSize
    }
  });

  // Clear the message queue
  messageQueue = [];
  reportQueueStats();
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
    port.addEventListener("message", handleClientMessage);
    port.start();

    // Send the shared buffer to the client worker
    port.postMessage({ type: "sharedBuffer", buffer: sharedBuffer });

    // Notify the main thread that initialization is complete
    self.postMessage({ message: "Host worker initialized" });
  } else if (type === "sendToClient" && data instanceof Uint8Array) {
    // Queue the message to be sent to the client
    writeToClient(data);
  } else if (type === "startTest") {
    // Start the throughput test
    const messageSize = event.data.messageSize || 1024;
    const testDuration = event.data.testDuration || 10;

    startThroughputTest(messageSize);

    // Auto-stop the test after the specified duration
    setTimeout(() => {
      stopThroughputTest();
    }, testDuration * 1000);

    self.postMessage({
      message: `Starting throughput test: ${messagesPerSecond} msgs/sec, ${messageSize} bytes per message, ${testDuration} seconds`,
    });
  } else if (type === "stopTest") {
    // Stop the throughput test
    stopThroughputTest();
    self.postMessage({ message: "Throughput test stopped" });
  }
});

// Export functions for use in the worker scope
Object.assign(self, { onMessage });
