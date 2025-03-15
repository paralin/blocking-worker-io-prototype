const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 5173;

const server = http.createServer((req, res) => {
  // Set COOP/COEP headers for cross-origin isolation (required for SharedArrayBuffer)
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");

  // Simple routing
  let filePath = path.join(__dirname, req.url === "/" ? "index.html" : req.url);

  // Handle 404 for non-existent files
  if (!fs.existsSync(filePath)) {
    res.statusCode = 404;
    res.end("File not found");
    return;
  }

  // Set content type based on file extension
  const ext = path.extname(filePath);
  let contentType = "text/html";

  switch (ext) {
    case ".js":
      contentType = "text/javascript";
      break;
    case ".css":
      contentType = "text/css";
      break;
    case ".json":
      contentType = "application/json";
      break;
    case ".wasm":
      contentType = "application/wasm";
      break;
  }

  res.setHeader("Content-Type", contentType);

  // Stream the file
  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  console.log(
    `IMPORTANT: Cross-Origin Isolation headers are enabled for SharedArrayBuffer support`,
  );
});
