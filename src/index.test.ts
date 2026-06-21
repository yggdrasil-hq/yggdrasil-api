import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "./index.js";

describe("API", () => {
  it("GET /health returns ok", async () => {
    const app = createApp();
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", service: "yggdrasil-api" });
  });
});
