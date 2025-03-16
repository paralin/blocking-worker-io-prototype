// Main entry point for the worker I/O prototype

// Types for statistics
interface MessageStats {
  messagesSent: number;
  messagesReceived: number;
  bytesTransferred: number;
  startTime: number;
  endTime: number;
  messageSize: number;
  queueDepth: number;
}

// Global state
let testRunning = false;
let testStats: MessageStats = {
  messagesSent: 0,
  messagesReceived: 0,
  bytesTransferred: 0,
  startTime: 0,
  endTime: 0,
  messageSize: 1024,
  queueDepth: 0,
};

// Function to log messages to the UI
function logMessage(message: string): void {
  const logElement = document.getElementById("log");
  if (logElement) {
    const messageElement = document.createElement("div");
    messageElement.textContent = `${new Date().toISOString().split("T")[1].split(".")[0]} - ${message}`;
    logElement.appendChild(messageElement);

    // Limit log to 100 entries to prevent memory issues
    while (logElement.childElementCount > 100) {
      logElement.removeChild(logElement.firstChild!);
    }

    logElement.scrollTop = logElement.scrollHeight;
  }
  console.log(message);
}

// Function to update statistics display
function updateStats(): void {
  const statsElement = document.getElementById("stats");
  if (!statsElement) return;

  const duration = (testStats.endTime || Date.now()) - testStats.startTime;
  const durationSec = duration / 1000;
  const messagesPerSecond =
    durationSec > 0 ? testStats.messagesReceived / durationSec : 0;
  const bytesPerSecond =
    durationSec > 0 ? testStats.bytesTransferred / durationSec : 0;
  const mbPerSecond = bytesPerSecond / (1024 * 1024);

  statsElement.innerHTML = `
    <div>Test running: ${testRunning ? "Yes" : "No"}</div>
    <div>Messages sent: ${testStats.messagesSent}</div>
    <div>Messages received: ${testStats.messagesReceived}</div>
    <div>Queue depth: ${testStats.queueDepth}</div>
    <div>Message size: ${testStats.messageSize} bytes</div>
    <div>Total bytes: ${(testStats.bytesTransferred / 1024).toFixed(2)} KB</div>
    <div>Duration: ${durationSec.toFixed(2)} seconds</div>
    <div>Throughput: ${messagesPerSecond.toFixed(2)} msgs/sec</div>
    <div>Bandwidth: ${mbPerSecond.toFixed(2)} MB/sec</div>
  `;
}

// Create a MessageChannel for communication between the workers
const channel = new MessageChannel();
const port1 = channel.port1;
const port2 = channel.port2;

// Create the host worker
const hostWorker = new Worker("./dist/worker-host.js", { type: "module" });

// Create the client worker
const clientWorker = new Worker("./dist/worker-client.js", { type: "module" });

// Initialize the host worker with port1
hostWorker.postMessage({ type: "init", port: port1 }, [port1]);

// Initialize the client worker with port2
clientWorker.postMessage({ type: "init", port: port2 }, [port2]);

// Listen for messages from the host worker
hostWorker.addEventListener("message", (event) => {
  const data = event.data;

  if (data.type === "stats") {
    // Update queue depth stat
    testStats.queueDepth = data.queueDepth || 0;
    updateStats();
    return;
  }

  if (data.type === "messageSent") {
    testStats.messagesSent++;
    testStats.bytesTransferred += data.size || 0;
    updateStats();
    return;
  }

  logMessage(`Host worker: ${data.message}`);
});

// Listen for messages from the client worker
clientWorker.addEventListener("message", (event) => {
  const data = event.data;

  if (data.type === "messageReceived") {
    testStats.messagesReceived++;
    updateStats();
    return;
  }

  logMessage(`Client worker: ${data.message}`);
});

// Function to start the throughput test
function startTest(): void {
  if (testRunning) return;

  // Reset stats
  testStats = {
    messagesSent: 0,
    messagesReceived: 0,
    bytesTransferred: 0,
    startTime: Date.now(),
    endTime: 0,
    messageSize: parseInt(
      (document.getElementById("messageSize") as HTMLInputElement).value,
      10,
    ),
    queueDepth: 0,
  };

  testRunning = true;
  updateStats();

  const messagesPerSecond = parseInt(
    (document.getElementById("messagesPerSecond") as HTMLInputElement).value,
    10,
  );
  const testDuration = parseInt(
    (document.getElementById("testDuration") as HTMLInputElement).value,
    10,
  );

  // Start the test
  hostWorker.postMessage({
    type: "startTest",
    messageSize: testStats.messageSize,
    messagesPerSecond,
    testDuration,
  });

  logMessage(
    `Starting throughput test: ${messagesPerSecond} msgs/sec, ${testStats.messageSize} bytes per message, ${testDuration} seconds`,
  );

  // Set a timer to end the test
  setTimeout(() => {
    stopTest();
  }, testDuration * 1000);
}

// Function to stop the throughput test
function stopTest(): void {
  if (!testRunning) return;

  testRunning = false;
  testStats.endTime = Date.now();
  updateStats();

  hostWorker.postMessage({ type: "stopTest" });
  logMessage("Throughput test completed");
}

// Set up UI event handlers when the page is loaded
window.addEventListener("load", () => {
  logMessage("Worker I/O Prototype initialized");

  // Set up the start button
  const startButton = document.getElementById("startTest");
  if (startButton) {
    startButton.addEventListener("click", startTest);
  }

  // Set up the stop button
  const stopButton = document.getElementById("stopTest");
  if (stopButton) {
    stopButton.addEventListener("click", stopTest);
  }

  // Update stats periodically
  setInterval(updateStats, 500);
});
