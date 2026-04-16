import assert from "node:assert/strict";
import request from "supertest";

import { createApp } from "./app.js";

async function run() {
  const app = createApp();
  const adminAgent = request.agent(app);
  const teacherAgent = request.agent(app);
  const parentAgent = request.agent(app);

  const homepage = await teacherAgent.get("/");
  assert.equal(homepage.status, 200);
  assert.match(homepage.text, /Makki Masjid/);

  const adminLogin = await adminAgent
    .post("/login")
    .type("form")
    .send({ email: "admin@makki-masjid.test", password: "Password123!" });
  assert.equal(adminLogin.status, 302);
  assert.equal(adminLogin.headers.location.startsWith("/admin/dashboard"), true);

  const adminDashboard = await adminAgent.get("/admin/dashboard");
  assert.equal(adminDashboard.status, 200);
  assert.match(adminDashboard.text, /Masjid Admin/);
  assert.match(adminDashboard.text, /Ustadh Soban/);

  const uniqueSuffix = Date.now();
  const teacherIdMatch = adminDashboard.text.match(/<option value="(\d+)">Ustadh Soban<\/option>/);
  assert.ok(teacherIdMatch);

  const createClass = await adminAgent
    .post("/admin/classes")
    .type("form")
    .send({
      name: `Smoke Class ${uniqueSuffix}`,
      description: "Smoke test class group",
      teacherUserId: teacherIdMatch[1],
    });
  assert.equal(createClass.status, 302);
  assert.equal(createClass.headers.location, "/admin/dashboard?notice=Class%20created.");

  const adminWithClass = await adminAgent.get("/admin/dashboard");
  const classIdMatch = adminWithClass.text.match(
    new RegExp(`<option value="(\\d+)">Smoke Class ${uniqueSuffix} · Ustadh Soban</option>`),
  );
  const studentIdMatch = adminWithClass.text.match(/<option value="(\d+)">Ibrahim Khan<\/option>/);
  assert.ok(classIdMatch);
  assert.ok(studentIdMatch);

  const assignStudent = await adminAgent
    .post(`/admin/classes/${classIdMatch[1]}/students`)
    .type("form")
    .send({ studentId: studentIdMatch[1] });
  assert.equal(assignStudent.status, 302);
  assert.equal(assignStudent.headers.location, "/admin/dashboard?notice=Student%20assigned%20to%20class.");

  const updatedClassName = `Smoke Class Updated ${uniqueSuffix}`;
  const updateClass = await adminAgent
    .post(`/admin/classes/${classIdMatch[1]}`)
    .type("form")
    .send({
      name: updatedClassName,
      description: "Smoke test class group updated",
      teacherUserId: teacherIdMatch[1],
    });
  assert.equal(updateClass.status, 302);
  assert.equal(updateClass.headers.location, "/admin/dashboard?notice=Class%20details%20updated.");

  const updateStudent = await adminAgent
    .post(`/admin/students/${studentIdMatch[1]}`)
    .type("form")
    .send({
      firstName: "Ibrahim",
      lastName: "Khan",
      teacherUserId: teacherIdMatch[1],
      currentSurah: "Surah Al-Mulk",
      currentAyah: "Ayah 12",
      monthlyFee: 40,
    });
  assert.equal(updateStudent.status, 302);
  assert.equal(updateStudent.headers.location, "/admin/dashboard?notice=Student%20details%20updated.");

  const adminAfterEdits = await adminAgent.get("/admin/dashboard");
  assert.match(adminAfterEdits.text, new RegExp(updatedClassName));
  assert.match(adminAfterEdits.text, /Ayah 12/);

  const pendingEmail = `pending-${uniqueSuffix}@makki-masjid.test`;
  const additionalGuardianEmail = `guardian-${uniqueSuffix}@makki-masjid.test`;
  const createGuardian = await adminAgent
    .post("/admin/users")
    .type("form")
    .send({
      name: `Smoke Test Guardian ${uniqueSuffix}`,
      email: additionalGuardianEmail,
      role: "parent",
      password: "Password123!",
    });
  assert.equal(createGuardian.status, 302);
  assert.equal(createGuardian.headers.location, "/admin/dashboard?notice=User%20created.");

  const adminWithGuardian = await adminAgent.get("/admin/dashboard");
  const guardianIdMatch = adminWithGuardian.text.match(
    new RegExp(`<option value="(\\d+)">Smoke Test Guardian ${uniqueSuffix}</option>`),
  );
  assert.ok(guardianIdMatch);

  const linkGuardian = await adminAgent
    .post(`/admin/students/${studentIdMatch[1]}/guardians`)
    .type("form")
    .send({
      guardianUserId: guardianIdMatch[1],
      relationship: "mother",
    });
  assert.equal(linkGuardian.status, 302);
  assert.equal(linkGuardian.headers.location, "/admin/dashboard?notice=Guardian%20linked%20to%20student.");

  const additionalGuardianAgent = request.agent(app);
  const additionalGuardianLogin = await additionalGuardianAgent
    .post("/login")
    .type("form")
    .send({ email: additionalGuardianEmail, password: "Password123!" });
  assert.equal(additionalGuardianLogin.status, 302);
  assert.equal(additionalGuardianLogin.headers.location.startsWith("/parent/dashboard"), true);

  const additionalGuardianDashboard = await additionalGuardianAgent.get("/parent/dashboard");
  assert.equal(additionalGuardianDashboard.status, 200);
  assert.match(additionalGuardianDashboard.text, /Ibrahim Khan/);

  const removeGuardian = await adminAgent
    .post(`/admin/students/${studentIdMatch[1]}/guardians/${guardianIdMatch[1]}/remove`)
    .type("form")
    .send({});
  assert.equal(removeGuardian.status, 302);
  assert.equal(removeGuardian.headers.location, "/admin/dashboard?notice=Guardian%20link%20removed.");

  const additionalGuardianAfterRemoval = await additionalGuardianAgent.get("/parent/dashboard");
  assert.equal(additionalGuardianAfterRemoval.status, 200);
  assert.doesNotMatch(additionalGuardianAfterRemoval.text, /Ibrahim Khan/);

  const updatedGuardianEmail = `guardian-updated-${uniqueSuffix}@makki-masjid.test`;
  const updateGuardianUser = await adminAgent
    .post(`/admin/users/${guardianIdMatch[1]}`)
    .type("form")
    .send({
      name: `Smoke Test Guardian Updated ${uniqueSuffix}`,
      email: updatedGuardianEmail,
      role: "parent",
    });
  assert.equal(updateGuardianUser.status, 302);
  assert.equal(updateGuardianUser.headers.location, "/admin/dashboard?notice=User%20details%20updated.");

  const deactivateGuardian = await adminAgent
    .post(`/admin/users/${guardianIdMatch[1]}/active`)
    .type("form")
    .send({ active: "0" });
  assert.equal(deactivateGuardian.status, 302);
  assert.equal(deactivateGuardian.headers.location, "/admin/dashboard?notice=User%20deactivated.");

  const inactiveGuardianLogin = await request(app)
    .post("/login")
    .type("form")
    .send({ email: updatedGuardianEmail, password: "Password123!" });
  assert.equal(inactiveGuardianLogin.status, 302);
  assert.equal(inactiveGuardianLogin.headers.location.startsWith("/?error=Invalid"), true);

  const reactivateGuardian = await adminAgent
    .post(`/admin/users/${guardianIdMatch[1]}/active`)
    .type("form")
    .send({ active: "1" });
  assert.equal(reactivateGuardian.status, 302);
  assert.equal(reactivateGuardian.headers.location, "/admin/dashboard?notice=User%20reactivated.");

  const reactivatedGuardianLogin = await request(app)
    .post("/login")
    .type("form")
    .send({ email: updatedGuardianEmail, password: "Password123!" });
  assert.equal(reactivatedGuardianLogin.status, 302);
  assert.equal(reactivatedGuardianLogin.headers.location.startsWith("/parent/dashboard"), true);

  const deleteGuardianUser = await adminAgent
    .post(`/admin/users/${guardianIdMatch[1]}/delete`)
    .type("form")
    .send({});
  assert.equal(deleteGuardianUser.status, 302);
  assert.equal(deleteGuardianUser.headers.location, "/admin/dashboard?notice=User%20deleted.");

  const deletedGuardianLogin = await request(app)
    .post("/login")
    .type("form")
    .send({ email: updatedGuardianEmail, password: "Password123!" });
  assert.equal(deletedGuardianLogin.status, 302);
  assert.equal(deletedGuardianLogin.headers.location.startsWith("/?error=Invalid"), true);

  const signup = await request(app)
    .post("/signup")
    .type("form")
    .send({
      accountType: "user",
      name: "Pending Smoke User",
      email: pendingEmail,
      masjidCode: "MAKKI-MCR",
      password: "OldPassword123!",
      confirmPassword: "OldPassword123!",
    });
  assert.equal(signup.status, 302);
  assert.equal(signup.headers.location.startsWith("/pending"), true);

  const pendingLogin = await request(app)
    .post("/login")
    .type("form")
    .send({ email: pendingEmail, password: "OldPassword123!" });
  assert.equal(pendingLogin.status, 302);
  assert.equal(pendingLogin.headers.location.startsWith("/?error=Invalid"), true);

  const approvePending = await adminAgent
    .post(`/admin/users/${encodeURIComponent(String(uniqueSuffix))}/approve`)
    .type("form")
    .send({ role: "parent" });
  assert.equal(approvePending.status, 302);
  assert.equal(approvePending.headers.location.startsWith("/admin/dashboard?error="), true);

  const refreshedAdminDashboard = await adminAgent.get("/admin/dashboard");
  const pendingMatch = refreshedAdminDashboard.text.match(
    new RegExp(`/admin/users/(\\d+)/approve[\\s\\S]*?${pendingEmail}`),
  );
  const fallbackMatch = refreshedAdminDashboard.text.match(
    new RegExp(`${pendingEmail}[\\s\\S]*?/admin/users/(\\d+)/approve`),
  );
  const pendingUserId = pendingMatch?.[1] ?? fallbackMatch?.[1];
  assert.ok(pendingUserId);

  const approveUser = await adminAgent
    .post(`/admin/users/${pendingUserId}/approve`)
    .type("form")
    .send({ role: "parent" });
  assert.equal(approveUser.status, 302);
  assert.equal(approveUser.headers.location, "/admin/dashboard?notice=User%20approved.");

  const approvedAgent = request.agent(app);
  const approvedLogin = await approvedAgent
    .post("/login")
    .type("form")
    .send({ email: pendingEmail, password: "OldPassword123!" });
  assert.equal(approvedLogin.status, 302);
  assert.equal(approvedLogin.headers.location.startsWith("/parent/dashboard"), true);

  const forgotPassword = await request(app)
    .post("/forgot-password")
    .type("form")
    .send({ email: pendingEmail });
  assert.equal(forgotPassword.status, 200);
  const resetLinkMatch = forgotPassword.text.match(/\/reset-password\?token=([a-f0-9-]+)/);
  assert.ok(resetLinkMatch);

  const resetPassword = await request(app)
    .post("/reset-password")
    .type("form")
    .send({
      token: resetLinkMatch[1],
      password: "NewPassword123!",
      confirmPassword: "NewPassword123!",
    });
  assert.equal(resetPassword.status, 302);
  assert.equal(resetPassword.headers.location, "/?notice=Password%20reset.%20You%20can%20now%20log%20in.");

  const resetLogin = await request(app)
    .post("/login")
    .type("form")
    .send({ email: pendingEmail, password: "NewPassword123!" });
  assert.equal(resetLogin.status, 302);
  assert.equal(resetLogin.headers.location.startsWith("/parent/dashboard"), true);

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
  assert.match(teacherDashboard.text, new RegExp(updatedClassName));

  const removeClassAssignment = await adminAgent
    .post(`/admin/classes/${classIdMatch[1]}/students/${studentIdMatch[1]}/remove`)
    .type("form")
    .send({});
  assert.equal(removeClassAssignment.status, 302);
  assert.equal(removeClassAssignment.headers.location, "/admin/dashboard?notice=Class%20assignment%20removed.");

  const deleteClass = await adminAgent
    .post(`/admin/classes/${classIdMatch[1]}/delete`)
    .type("form")
    .send({});
  assert.equal(deleteClass.status, 302);
  assert.equal(deleteClass.headers.location, "/admin/dashboard?notice=Class%20deleted.");

  const adminAfterClassDelete = await adminAgent.get("/admin/dashboard");
  assert.doesNotMatch(adminAfterClassDelete.text, new RegExp(updatedClassName));

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
