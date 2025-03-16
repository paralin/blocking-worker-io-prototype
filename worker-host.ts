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
  let testRunning = false;
  let testInterval: number | null = null;
  let testMessageSize = 1024;
  let testMessageRate = 100; // messages per second

  // Create a test message of specified size
  function createTestMessage(size: number): Uint8Array {
    const message = new Uint8Array(size);
    // Fill with random data
    for (let i = 0; i < size; i++) {
      message[i] = Math.floor(Math.random() * 256);
    }
    return message;
  }

  // Write data to the shared buffer
  function writeToSharedBuffer(data: Uint8Array): void {
    if (!sharedArray || !sharedBuffer) {
      console.error("Shared array not initialized");
      return;
    }

    if (data.length > HOST_MTU) {
      console.error(
        `Message too large: ${data.length} bytes exceeds MTU of ${HOST_MTU}`,
      );
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
      // Report queue depth to main thread
      reportQueueStats();
      return;
    }

    // Write to the shared buffer
    writeToSharedBuffer(data);

    // Report message sent to main thread for statistics
    self.postMessage({
      type: "messageSent",
      size: data.length,
    });
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
    const { type, data, ack } = event.data;

    if (type === "toHost" && data instanceof Uint8Array) {
      // Forward received message to the main thread (only log first 50 bytes to avoid UI clutter)
      self.postMessage({
        message: `Received ${data.length} bytes`,
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

          // Report message sent to main thread for statistics
          self.postMessage({
            type: "messageSent",
            size: nextMessage.length,
          });
        }

        // Report updated queue stats
        reportQueueStats();
      }
    }
  }

  // Start the throughput test
  function startThroughputTest(
    messageSize: number,
    messagesPerSecond: number,
  ): void {
    if (testRunning) return;

    testRunning = true;
    testMessageSize = messageSize;
    testMessageRate = messagesPerSecond;

    // Clear any existing interval
    if (testInterval !== null) {
      clearInterval(testInterval);
    }

    // Calculate interval between messages
    const intervalMs = 1000 / testMessageRate;

    // Start sending messages at the specified rate
    testInterval = setInterval(() => {
      if (!testRunning) {
        clearInterval(testInterval!);
        testInterval = null;
        return;
      }

      // Create and send a test message
      const testMessage = createTestMessage(testMessageSize);
      writeToClient(testMessage);
    }, intervalMs);

    // Report queue stats periodically
    setInterval(reportQueueStats, 500);
  }

  // Stop the throughput test
  function stopThroughputTest(): void {
    testRunning = false;
    if (testInterval !== null) {
      clearInterval(testInterval);
      testInterval = null;
    }

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
      port!.addEventListener("message", handleClientMessage);
      port!.start();

      // Send the shared buffer to the client worker
      port!.postMessage({ type: "sharedBuffer", buffer: sharedBuffer });

      // Notify the main thread that initialization is complete
      self.postMessage({ message: "Host worker initialized" });
    } else if (type === "sendToClient" && data instanceof Uint8Array) {
      // Queue the message to be sent to the client
      writeToClient(data);
    } else if (type === "startTest") {
      // Start the throughput test
      const messageSize = event.data.messageSize || 1024;
      const messagesPerSecond = event.data.messagesPerSecond || 100;
      const testDuration = event.data.testDuration || 10;

      startThroughputTest(messageSize, messagesPerSecond);

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

  // Return the public API
  return {
    writeToClient,
    onMessage,
  };
}

// Export functions for use in the worker scope
Object.assign(self, { onMessage: initHostWorker().onMessage });
