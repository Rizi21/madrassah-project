import assert from "node:assert/strict";
import request from "supertest";

import { createApp } from "./app.js";

async function run() {
  const app = createApp();
  const teacherAgent = request.agent(app);
  const parentAgent = request.agent(app);

  const homepage = await teacherAgent.get("/");
  assert.equal(homepage.status, 200);
  assert.match(homepage.text, /Makki Masjid Madrassah/);

  const teacherLogin = await teacherAgent
    .post("/login")
    .type("form")
    .send({ email: "soban@makki-masjid.test", password: "Password123!" });
  assert.equal(teacherLogin.status, 302);
  assert.equal(teacherLogin.headers.location.startsWith("/teacher/dashboard"), true);

  const teacherDashboard = await teacherAgent.get("/teacher/dashboard");
  assert.equal(teacherDashboard.status, 200);
  assert.match(teacherDashboard.text, /Ustadh Portal/);
  assert.match(teacherDashboard.text, /Ibrahim Khan/);

  const parentLogin = await parentAgent
    .post("/login")
    .type("form")
    .send({ email: "parent@makki-masjid.test", password: "Password123!" });
  assert.equal(parentLogin.status, 302);
  assert.equal(parentLogin.headers.location.startsWith("/parent/dashboard"), true);

  const parentDashboard = await parentAgent.get("/parent/dashboard");
  assert.equal(parentDashboard.status, 200);
  assert.match(parentDashboard.text, /Guardian Portal/);
  assert.match(parentDashboard.text, /Recent attendance/);

  console.log("Smoke test passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
