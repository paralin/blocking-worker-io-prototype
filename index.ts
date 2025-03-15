// Main entry point for the worker I/O prototype

// Function to log messages to the UI
function logMessage(message: string): void {
  const logElement = document.getElementById("log");
  if (logElement) {
    const messageElement = document.createElement("div");
    messageElement.textContent = `${new Date().toISOString().split("T")[1].split(".")[0]} - ${message}`;
    logElement.appendChild(messageElement);
    logElement.scrollTop = logElement.scrollHeight;
  }
  console.log(message);
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
  logMessage(`Host worker: ${event.data.message}`);
});

// Listen for messages from the client worker
clientWorker.addEventListener("message", (event) => {
  logMessage(`Client worker: ${event.data.message}`);
});

// Log when the page is loaded
window.addEventListener("load", () => {
  logMessage("Worker I/O Prototype initialized");
});
