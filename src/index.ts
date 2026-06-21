import express from "express";

export function createApp() {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "yggdrasil-api" });
  });

  return app;
}

const port = Number(process.env.PORT) || 3000;

if (process.env.NODE_ENV !== "test") {
  const app = createApp();
  app.listen(port, "0.0.0.0", () => {
    console.log(`API listening on :${port}`);
  });
}
