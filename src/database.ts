import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";

import type {
  AdminDashboardData,
  AdminClassGroupRow,
  AdminUserRow,
  AttendanceStatus,
  AuthUser,
  FeeStatus,
  ParentDashboardData,
  ParentStudentView,
  StudentSummary,
  TeacherDashboardData,
  TeacherStudentCard,
  UserRole,
} from "./types.js";
import type { TenantConfig } from "./tenant-config.js";

const dataDir = path.resolve(process.cwd(), "data");
const databasePath = path.join(dataDir, "madrassah.db");

fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(databasePath);
db.pragma("journal_mode = WAL");

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function monthStamp(date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

function shiftDate(days: number): string {
  const target = new Date();
  target.setDate(target.getDate() + days);
  return target.toISOString().slice(0, 10);
}

function splitInsightText(input: string | null): string[] {
  if (!input) {
    return [];
  }

  return input
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function summarizeInsights(strengths: string[], weaknesses: string[]): StudentSummary {
  const collectTop = (items: string[]) =>
    Object.entries(
      items.reduce<Record<string, number>>((accumulator, current) => {
        const key = current.toLowerCase();
        accumulator[key] = (accumulator[key] || 0) + 1;
        return accumulator;
      }, {}),
    )
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([value]) => value.replace(/\b\w/g, (character) => character.toUpperCase()));

  return {
    strongPoints: collectTop(strengths),
    weakPoints: collectTop(weaknesses),
  };
}

function ensureColumn(tableName: string, columnName: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;

  if (!columns.some((column) => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

export function initializeDatabase(tenantConfig: TenantConfig): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS organizations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_key TEXT,
      masjid_code TEXT,
      admin_signup_code TEXT,
      name TEXT NOT NULL,
      country TEXT NOT NULL,
      timezone TEXT NOT NULL,
      currency TEXT NOT NULL,
      logo_path TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );

    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL,
      guardian_user_id INTEGER NOT NULL,
      teacher_user_id INTEGER NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      current_surah TEXT NOT NULL,
      current_ayah TEXT NOT NULL,
      monthly_fee REAL NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organizations(id),
      FOREIGN KEY (guardian_user_id) REFERENCES users(id),
      FOREIGN KEY (teacher_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS student_guardians (
      student_id INTEGER NOT NULL,
      guardian_user_id INTEGER NOT NULL,
      relationship TEXT NOT NULL DEFAULT 'guardian',
      is_primary INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (student_id, guardian_user_id),
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (guardian_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      lesson_date TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(student_id, lesson_date),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS progress_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      teacher_id INTEGER NOT NULL,
      lesson_date TEXT NOT NULL,
      sabak TEXT NOT NULL,
      sabki TEXT NOT NULL,
      manzil TEXT NOT NULL,
      homework TEXT NOT NULL,
      strengths TEXT NOT NULL,
      weaknesses TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (student_id) REFERENCES students(id),
      FOREIGN KEY (teacher_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS fees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      student_id INTEGER NOT NULL,
      fee_month TEXT NOT NULL,
      amount_due REAL NOT NULL,
      status TEXT NOT NULL,
      paid_on TEXT,
      note TEXT NOT NULL DEFAULT '',
      UNIQUE(student_id, fee_month),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS class_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      organization_id INTEGER NOT NULL,
      teacher_user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (organization_id) REFERENCES organizations(id),
      FOREIGN KEY (teacher_user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS class_students (
      class_group_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (class_group_id, student_id),
      FOREIGN KEY (class_group_id) REFERENCES class_groups(id),
      FOREIGN KEY (student_id) REFERENCES students(id)
    );

    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
  `);

  ensureColumn("organizations", "tenant_key", "TEXT");
  ensureColumn("organizations", "masjid_code", "TEXT");
  ensureColumn("organizations", "admin_signup_code", "TEXT");
  ensureColumn("organizations", "logo_path", "TEXT");
  ensureColumn("users", "active", "INTEGER NOT NULL DEFAULT 1");

  seedDemoData(tenantConfig);
  backfillStudentGuardians();
}

function seedDemoData(tenantConfig: TenantConfig): void {
  const insertOrganization = db.prepare(`
    INSERT INTO organizations (tenant_key, masjid_code, admin_signup_code, name, country, timezone, currency, logo_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateOrganization = db.prepare(`
    UPDATE organizations
    SET tenant_key = ?, masjid_code = ?, admin_signup_code = ?, name = ?, country = ?, timezone = ?, currency = ?, logo_path = ?
    WHERE id = ?
  `);
  const insertUser = db.prepare(`
    INSERT INTO users (organization_id, role, name, email, password_hash)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateUser = db.prepare(`
    UPDATE users
    SET organization_id = ?, role = ?, name = ?, password_hash = ?
    WHERE id = ?
  `);
  const insertStudent = db.prepare(`
    INSERT INTO students (
      organization_id, guardian_user_id, teacher_user_id,
      first_name, last_name, current_surah, current_ayah, monthly_fee
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAttendance = db.prepare(`
    INSERT INTO attendance (student_id, lesson_date, status)
    VALUES (?, ?, ?)
  `);
  const insertProgress = db.prepare(`
    INSERT INTO progress_entries (
      student_id, teacher_id, lesson_date, sabak, sabki, manzil,
      homework, strengths, weaknesses, note
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertFee = db.prepare(`
    INSERT INTO fees (student_id, fee_month, amount_due, status, paid_on, note)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertStudentGuardian = db.prepare(`
    INSERT OR IGNORE INTO student_guardians (student_id, guardian_user_id, relationship, is_primary)
    VALUES (?, ?, ?, ?)
  `);
  const insertClassGroup = db.prepare(`
    INSERT INTO class_groups (organization_id, teacher_user_id, name, description)
    VALUES (?, ?, ?, ?)
  `);
  const insertClassStudent = db.prepare(`
    INSERT OR IGNORE INTO class_students (class_group_id, student_id)
    VALUES (?, ?)
  `);

  const configuredAdminPassword = bcrypt.hashSync(tenantConfig.demoUsers.admin.password, 10);
  const configuredTeacherPassword = bcrypt.hashSync(tenantConfig.demoUsers.teacher.password, 10);
  const configuredParentPassword = bcrypt.hashSync(tenantConfig.demoUsers.parent.password, 10);

  const existingOrganization = db
    .prepare("SELECT id FROM organizations WHERE tenant_key = ? OR name = ? LIMIT 1")
    .get(tenantConfig.tenantId, tenantConfig.displayName) as { id: number } | undefined;

  const organizationId = existingOrganization
    ? existingOrganization.id
    : Number(
        insertOrganization.run(
          tenantConfig.tenantId,
          tenantConfig.masjidCode,
          tenantConfig.adminSignupCode,
          tenantConfig.displayName,
          tenantConfig.country,
          tenantConfig.timezone,
          tenantConfig.currency,
          tenantConfig.logoPath ?? null,
        ).lastInsertRowid,
      );

  updateOrganization.run(
    tenantConfig.tenantId,
    tenantConfig.masjidCode,
    tenantConfig.adminSignupCode,
    tenantConfig.displayName,
    tenantConfig.country,
    tenantConfig.timezone,
    tenantConfig.currency,
    tenantConfig.logoPath ?? null,
    organizationId,
  );

  function upsertDemoUser(role: UserRole, name: string, email: string, password: string): number {
    const existingUser = db
      .prepare("SELECT id FROM users WHERE lower(email) = lower(?) LIMIT 1")
      .get(email) as { id: number } | undefined;

    if (existingUser) {
      updateUser.run(organizationId, role, name, password, existingUser.id);
      return existingUser.id;
    }

    return Number(insertUser.run(organizationId, role, name, email, password).lastInsertRowid);
  }

  upsertDemoUser(
    "admin",
    tenantConfig.demoUsers.admin.name,
    tenantConfig.demoUsers.admin.email,
    configuredAdminPassword,
  );
  const teacherId = upsertDemoUser(
    "teacher",
    tenantConfig.demoUsers.teacher.name,
    tenantConfig.demoUsers.teacher.email,
    configuredTeacherPassword,
  );
  const parentId = upsertDemoUser(
    "parent",
    tenantConfig.demoUsers.parent.name,
    tenantConfig.demoUsers.parent.email,
    configuredParentPassword,
  );

  const existingTenantStudents = db
    .prepare("SELECT COUNT(*) AS count FROM students WHERE organization_id = ?")
    .get(organizationId) as { count: number };

  if (existingTenantStudents.count > 0) {
    return;
  }

  const seededStudentIds = tenantConfig.seedStudents.map((student) =>
    Number(
      insertStudent.run(
        organizationId,
        parentId,
        teacherId,
        student.firstName,
        student.lastName,
        student.currentSurah,
        student.currentAyah,
        student.monthlyFee ?? tenantConfig.feeDefaults.monthlyAmount,
      ).lastInsertRowid,
    ),
  );

  const [firstStudentId, secondStudentId] = seededStudentIds;

  if (!firstStudentId || !secondStudentId) {
    return;
  }

  insertStudentGuardian.run(firstStudentId, parentId, "guardian", 1);
  insertStudentGuardian.run(secondStudentId, parentId, "guardian", 1);

  const classGroupId = Number(
    insertClassGroup.run(
      organizationId,
      teacherId,
      "Weekday Hifz Group",
      "Default seeded group for weekday Qur'an progress tracking.",
    ).lastInsertRowid,
  );

  insertClassStudent.run(classGroupId, firstStudentId);
  insertClassStudent.run(classGroupId, secondStudentId);

  [
    [firstStudentId, shiftDate(-4), "present"],
    [firstStudentId, shiftDate(-3), "present"],
    [firstStudentId, shiftDate(-2), "late"],
    [secondStudentId, shiftDate(-4), "present"],
    [secondStudentId, shiftDate(-3), "absent"],
    [secondStudentId, shiftDate(-2), "present"],
  ].forEach(([studentId, lessonDate, status]) => {
    insertAttendance.run(studentId, lessonDate, status);
  });

  [
    [
      firstStudentId,
      teacherId,
      shiftDate(-3),
      "Al-Mulk 1-7",
      "Yaseen 1-10",
      "Juz 29 review",
      "Revise Al-Mulk 1-12 and prepare Al-Mulk 13-18",
      "Fluent recitation, strong tajweed",
      "Needs confidence when starting new ayat",
      `${tenantConfig.seedStudents[0]?.firstName ?? "Student"} is consistent and responds well to correction.`,
    ],
    [
      firstStudentId,
      teacherId,
      shiftDate(-1),
      "Al-Mulk 8-12",
      "Yaseen 1-15",
      "Juz 29 review",
      "Repeat Al-Mulk 8-15 twice daily",
      "Good makharij, confident memorisation",
      "Needs slower pace on long ayat",
      "Good lesson. Continue controlled pace.",
    ],
    [
      secondStudentId,
      teacherId,
      shiftDate(-3),
      "Ya-Sin 12-18",
      "Juz 22 review",
      "Short surah revision",
      "Revise Ya-Sin 12-18 and prepare 19-24",
      "Quick recall, engaged in class",
      "Homework follow-through, attendance consistency",
      `${tenantConfig.seedStudents[1]?.firstName ?? "Student"} knows the lesson but missed revision targets.`,
    ],
    [
      secondStudentId,
      teacherId,
      shiftDate(-1),
      "Ya-Sin 19-24",
      "Juz 22 review",
      "Short surah revision",
      "Repeat Ya-Sin 19-24 with guardian supervision",
      "Strong memory after repetition",
      "Needs focus at the start of class, homework consistency",
      "Improved after settling in. Guardian support will help.",
    ],
  ].forEach((entry) => {
    insertProgress.run(...entry);
  });

  [
    [
      firstStudentId,
      monthStamp(new Date()),
      tenantConfig.seedStudents[0]?.monthlyFee ?? tenantConfig.feeDefaults.monthlyAmount,
      "paid",
      today(),
      "Paid in full for this month.",
    ],
    [
      secondStudentId,
      monthStamp(new Date()),
      tenantConfig.seedStudents[1]?.monthlyFee ?? tenantConfig.feeDefaults.monthlyAmount,
      "pending",
      null,
      "Awaiting transfer from guardian.",
    ],
  ].forEach((entry) => {
    insertFee.run(...entry);
  });

}

function backfillStudentGuardians(): void {
  db.prepare(`
    INSERT OR IGNORE INTO student_guardians (student_id, guardian_user_id, relationship, is_primary)
    SELECT id, guardian_user_id, 'guardian', 1
    FROM students
  `).run();
}

export function validateUserCredentials(email: string, password: string): AuthUser | null {
  const row = db
    .prepare(`
      SELECT id, organization_id AS organizationId, role, name, email, password_hash AS passwordHash
      FROM users
      WHERE lower(email) = lower(?) AND active = 1
    `)
    .get(email) as
    | {
        id: number;
        organizationId: number;
        role: AuthUser["role"];
        name: string;
        email: string;
        passwordHash: string;
      }
    | undefined;

  if (!row || !bcrypt.compareSync(password, row.passwordHash)) {
    return null;
  }

  if (row.role === "pending") {
    return null;
  }

  return {
    id: row.id,
    organizationId: row.organizationId,
    role: row.role,
    name: row.name,
    email: row.email,
  };
}

export function createSession(userId: number): string {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString();

  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(sessionId, userId, expiresAt);

  return sessionId;
}

export function destroySession(sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function createPasswordResetToken(email: string): string | null {
  const user = db
    .prepare("SELECT id FROM users WHERE lower(email) = lower(?) LIMIT 1")
    .get(email) as { id: number } | undefined;

  if (!user) {
    return null;
  }

  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 1000 * 60 * 30).toISOString();

  db.prepare(`
    INSERT INTO password_reset_tokens (token, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(token, user.id, expiresAt);

  return token;
}

export function resetPasswordWithToken(token: string, password: string): void {
  const row = db
    .prepare(`
      SELECT token, user_id AS userId
      FROM password_reset_tokens
      WHERE token = ? AND used_at IS NULL AND expires_at >= ?
      LIMIT 1
    `)
    .get(token, new Date().toISOString()) as { token: string; userId: number } | undefined;

  if (!row) {
    throw new Error("Password reset link is invalid or expired.");
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const transaction = db.transaction(() => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, row.userId);
    db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE token = ?").run(
      new Date().toISOString(),
      row.token,
    );
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(row.userId);
  });

  transaction();
}

export function getUserForSession(sessionId: string | undefined): AuthUser | null {
  if (!sessionId) {
    return null;
  }

  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date().toISOString());

  const row = db
    .prepare(`
      SELECT u.id, u.organization_id AS organizationId, u.role, u.name, u.email
      FROM sessions s
      INNER JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.expires_at >= ? AND u.active = 1
    `)
    .get(sessionId, new Date().toISOString()) as AuthUser | undefined;

  return row ?? null;
}

function getOrganizationDetails(organizationId: number): { name: string; currency: string } {
  const row = db
    .prepare("SELECT name, currency FROM organizations WHERE id = ?")
    .get(organizationId) as { name: string; currency: string };

  return row;
}

function getOrganizationByMasjidCode(masjidCode: string): { id: number } | null {
  const row = db
    .prepare(`
      SELECT id
      FROM organizations
      WHERE upper(masjid_code) = upper(?)
      LIMIT 1
    `)
    .get(masjidCode.trim()) as { id: number } | undefined;

  return row ?? null;
}

function getOrganizationByAdminSignupCode(adminSignupCode: string): { id: number } | null {
  const row = db
    .prepare(`
      SELECT id
      FROM organizations
      WHERE admin_signup_code = ?
      LIMIT 1
    `)
    .get(adminSignupCode.trim()) as { id: number } | undefined;

  return row ?? null;
}

export function registerWithMasjidCode(input: {
  name: string;
  email: string;
  password: string;
  masjidCode: string;
}): void {
  const organization = getOrganizationByMasjidCode(input.masjidCode);

  if (!organization) {
    throw new Error("Masjid code was not recognised.");
  }

  createOrganizationUser({
    organizationId: organization.id,
    role: "pending",
    name: input.name,
    email: input.email,
    password: input.password,
  });
}

export function registerAdminWithSetupCode(input: {
  name: string;
  email: string;
  password: string;
  adminSignupCode: string;
}): void {
  const organization = getOrganizationByAdminSignupCode(input.adminSignupCode);

  if (!organization) {
    throw new Error("Admin setup code was not recognised.");
  }

  createOrganizationUser({
    organizationId: organization.id,
    role: "admin",
    name: input.name,
    email: input.email,
    password: input.password,
  });
}

function userBelongsToOrganization(userId: number, organizationId: number, role?: UserRole): boolean {
  const row = db
    .prepare(`
      SELECT id
      FROM users
      WHERE id = ? AND organization_id = ? AND active = 1 AND (? IS NULL OR role = ?)
    `)
    .get(userId, organizationId, role ?? null, role ?? null) as { id: number } | undefined;

  return Boolean(row);
}

function getLatestAttendance(studentId: number): AttendanceStatus | null {
  const row = db
    .prepare(`
      SELECT status
      FROM attendance
      WHERE student_id = ?
      ORDER BY lesson_date DESC
      LIMIT 1
    `)
    .get(studentId) as { status: AttendanceStatus } | undefined;

  return row?.status ?? null;
}

function getAttendanceRate(studentId: number): number {
  const rows = db
    .prepare(`
      SELECT status
      FROM attendance
      WHERE student_id = ?
      ORDER BY lesson_date DESC
      LIMIT 20
    `)
    .all(studentId) as Array<{ status: AttendanceStatus }>;

  if (rows.length === 0) {
    return 0;
  }

  const points = rows.reduce((total, row) => {
    if (row.status === "present") {
      return total + 1;
    }

    if (row.status === "late") {
      return total + 0.5;
    }

    return total;
  }, 0);

  return Math.round((points / rows.length) * 100);
}

function getLatestFee(studentId: number): FeeStatus | null {
  const row = db
    .prepare(`
      SELECT status
      FROM fees
      WHERE student_id = ?
      ORDER BY fee_month DESC
      LIMIT 1
    `)
    .get(studentId) as { status: FeeStatus } | undefined;

  return row?.status ?? null;
}

function getRecentProgressRows(studentId: number) {
  return db
    .prepare(`
      SELECT lesson_date AS lessonDate, sabak, sabki, manzil, homework, strengths, weaknesses, note
      FROM progress_entries
      WHERE student_id = ?
      ORDER BY lesson_date DESC, id DESC
      LIMIT 5
    `)
    .all(studentId) as Array<{
    lessonDate: string;
    sabak: string;
    sabki: string;
    manzil: string;
    homework: string;
    strengths: string;
    weaknesses: string;
    note: string;
  }>;
}

function getStudentSummary(studentId: number): StudentSummary {
  const rows = getRecentProgressRows(studentId);
  const strengths = rows.flatMap((row) => splitInsightText(row.strengths));
  const weaknesses = rows.flatMap((row) => splitInsightText(row.weaknesses));
  return summarizeInsights(strengths, weaknesses);
}

function getStudentClassNames(studentId: number): string[] {
  return getStudentClassAssignments(studentId).map((classGroup) => classGroup.name);
}

function getStudentClassAssignments(studentId: number): Array<{ id: number; name: string }> {
  const rows = db
    .prepare(`
      SELECT cg.id, cg.name
      FROM class_students cs
      INNER JOIN class_groups cg ON cg.id = cs.class_group_id
      WHERE cs.student_id = ?
      ORDER BY cg.name
    `)
    .all(studentId) as Array<{ id: number; name: string }>;

  return rows;
}

function getStudentGuardianNames(studentId: number): string[] {
  return getStudentGuardianLinks(studentId).map((guardian) => guardian.name);
}

function getStudentGuardianLinks(
  studentId: number,
): Array<{ id: number; name: string; relationship: string; isPrimary: boolean }> {
  const rows = db
    .prepare(`
      SELECT
        u.id,
        u.name,
        sg.relationship,
        sg.is_primary AS isPrimary
      FROM student_guardians sg
      INNER JOIN users u ON u.id = sg.guardian_user_id
      WHERE sg.student_id = ?
      ORDER BY sg.is_primary DESC, u.name
    `)
    .all(studentId) as Array<{ id: number; name: string; relationship: string; isPrimary: number }>;

  return rows.map((row) => ({
    ...row,
    isPrimary: row.isPrimary === 1,
  }));
}

export function getTeacherDashboardData(teacherId: number, organizationId: number): TeacherDashboardData {
  const organization = getOrganizationDetails(organizationId);
  const classGroups = db
    .prepare(`
      SELECT
        cg.id,
        cg.name,
        cg.description,
        COUNT(cs.student_id) AS studentCount
      FROM class_groups cg
      LEFT JOIN class_students cs ON cs.class_group_id = cg.id
      WHERE cg.organization_id = ? AND cg.teacher_user_id = ?
      GROUP BY cg.id
      ORDER BY cg.name
    `)
    .all(organizationId, teacherId) as TeacherDashboardData["classGroups"];

  const studentRows = db
    .prepare(`
      SELECT DISTINCT
        s.id,
        s.first_name AS firstName,
        s.last_name AS lastName,
        s.current_surah AS currentSurah,
        s.current_ayah AS currentAyah,
        s.monthly_fee AS monthlyFee
      FROM students s
      LEFT JOIN class_students cs ON cs.student_id = s.id
      LEFT JOIN class_groups cg ON cg.id = cs.class_group_id
      WHERE s.organization_id = ?
        AND (s.teacher_user_id = ? OR cg.teacher_user_id = ?)
      ORDER BY s.first_name, s.last_name
    `)
    .all(organizationId, teacherId, teacherId) as Array<{
    id: number;
    firstName: string;
    lastName: string;
    currentSurah: string;
    currentAyah: string;
    monthlyFee: number;
  }>;

  const students: TeacherStudentCard[] = studentRows.map((student) => {
    const progressRows = getRecentProgressRows(student.id);
    const summary = getStudentSummary(student.id);
    const latestProgress = progressRows[0]
      ? {
          lessonDate: progressRows[0].lessonDate,
          sabak: progressRows[0].sabak,
          sabki: progressRows[0].sabki,
          manzil: progressRows[0].manzil,
          homework: progressRows[0].homework,
          note: progressRows[0].note,
        }
      : null;

    return {
      id: student.id,
      fullName: `${student.firstName} ${student.lastName}`,
      classNames: getStudentClassNames(student.id),
      currentSurah: student.currentSurah,
      currentAyah: student.currentAyah,
      monthlyFee: student.monthlyFee,
      attendanceRate: getAttendanceRate(student.id),
      latestAttendance: getLatestAttendance(student.id),
      latestFeeStatus: getLatestFee(student.id),
      latestProgress,
      recentNotes: progressRows.map((row) => row.note),
      strongPoints: summary.strongPoints,
      weakPoints: summary.weakPoints,
    };
  });

  return {
    organizationName: organization.name,
    currency: organization.currency,
    classGroups,
    students,
  };
}

export function getParentDashboardData(parentId: number, organizationId: number): ParentDashboardData {
  const organization = getOrganizationDetails(organizationId);
  const studentRows = db
    .prepare(`
      SELECT
        s.id,
        s.first_name AS firstName,
        s.last_name AS lastName,
        s.current_surah AS currentSurah,
        s.current_ayah AS currentAyah,
        s.monthly_fee AS monthlyFee
      FROM students s
      INNER JOIN student_guardians sg ON sg.student_id = s.id
      WHERE sg.guardian_user_id = ? AND s.organization_id = ?
      ORDER BY s.first_name, s.last_name
    `)
    .all(parentId, organizationId) as Array<{
    id: number;
    firstName: string;
    lastName: string;
    currentSurah: string;
    currentAyah: string;
    monthlyFee: number;
  }>;

  const students: ParentStudentView[] = studentRows.map((student) => {
    const attendanceHistory = db
      .prepare(`
        SELECT lesson_date AS lessonDate, status
        FROM attendance
        WHERE student_id = ?
        ORDER BY lesson_date DESC
        LIMIT 8
      `)
      .all(student.id) as ParentStudentView["attendanceHistory"];

    const progressEntries = getRecentProgressRows(student.id);
    const fees = db
      .prepare(`
        SELECT fee_month AS feeMonth, amount_due AS amountDue, status, paid_on AS paidOn, note
        FROM fees
        WHERE student_id = ?
        ORDER BY fee_month DESC
        LIMIT 6
      `)
      .all(student.id) as ParentStudentView["fees"];

    return {
      id: student.id,
      fullName: `${student.firstName} ${student.lastName}`,
      currentSurah: student.currentSurah,
      currentAyah: student.currentAyah,
      monthlyFee: student.monthlyFee,
      attendanceHistory,
      progressEntries,
      fees,
      ...getStudentSummary(student.id),
    };
  });

  return {
    organizationName: organization.name,
    currency: organization.currency,
    students,
  };
}

function getUserDependencyCount(userId: number): number {
  const teacherStudentCount = db
    .prepare("SELECT COUNT(*) AS count FROM students WHERE teacher_user_id = ?")
    .get(userId) as { count: number };
  const primaryGuardianStudentCount = db
    .prepare("SELECT COUNT(*) AS count FROM students WHERE guardian_user_id = ?")
    .get(userId) as { count: number };
  const guardianLinkCount = db
    .prepare("SELECT COUNT(*) AS count FROM student_guardians WHERE guardian_user_id = ?")
    .get(userId) as { count: number };
  const classGroupCount = db
    .prepare("SELECT COUNT(*) AS count FROM class_groups WHERE teacher_user_id = ?")
    .get(userId) as { count: number };
  const progressEntryCount = db
    .prepare("SELECT COUNT(*) AS count FROM progress_entries WHERE teacher_id = ?")
    .get(userId) as { count: number };

  return (
    teacherStudentCount.count +
    primaryGuardianStudentCount.count +
    guardianLinkCount.count +
    classGroupCount.count +
    progressEntryCount.count
  );
}

export function getAdminDashboardData(organizationId: number): AdminDashboardData {
  const organization = getOrganizationDetails(organizationId);
  const userRows = db
    .prepare(`
      SELECT id, name, email, role, active
      FROM users
      WHERE organization_id = ?
      ORDER BY
        active DESC,
        CASE role
          WHEN 'admin' THEN 1
          WHEN 'teacher' THEN 2
          WHEN 'parent' THEN 3
          ELSE 4
        END,
        name
    `)
    .all(organizationId) as Array<Omit<AdminUserRow, "active" | "dependencyCount"> & { active: number }>;

  const users: AdminUserRow[] = userRows.map((user) => ({
    ...user,
    active: user.active === 1,
    dependencyCount: getUserDependencyCount(user.id),
  }));

  const students = db
    .prepare(`
      SELECT
        s.id,
        s.first_name AS firstName,
        s.last_name AS lastName,
        s.first_name || ' ' || s.last_name AS fullName,
        s.current_surah AS currentSurah,
        s.current_ayah AS currentAyah,
        s.monthly_fee AS monthlyFee,
        s.teacher_user_id AS teacherUserId,
        teacher.name AS teacherName
      FROM students s
      INNER JOIN users teacher ON teacher.id = s.teacher_user_id
      WHERE s.organization_id = ?
      ORDER BY s.first_name, s.last_name
    `)
    .all(organizationId) as AdminDashboardData["students"];

  const classGroups = db
    .prepare(`
      SELECT
        cg.id,
        cg.name,
        cg.description,
        cg.teacher_user_id AS teacherUserId,
        teacher.name AS teacherName,
        COUNT(cs.student_id) AS studentCount
      FROM class_groups cg
      INNER JOIN users teacher ON teacher.id = cg.teacher_user_id
      LEFT JOIN class_students cs ON cs.class_group_id = cg.id
      WHERE cg.organization_id = ?
      GROUP BY cg.id
      ORDER BY cg.name
    `)
    .all(organizationId) as AdminClassGroupRow[];

  const studentsWithClasses = students.map((student) => ({
    ...student,
    classAssignments: getStudentClassAssignments(student.id),
    classNames: getStudentClassNames(student.id),
    guardians: getStudentGuardianLinks(student.id),
    guardianNames: getStudentGuardianNames(student.id),
  }));

  return {
    organizationName: organization.name,
    currency: organization.currency,
    users,
    pendingUsers: users.filter((user) => user.role === "pending"),
    teachers: users.filter((user) => user.role === "teacher" && user.active),
    guardians: users.filter((user) => user.role === "parent" && user.active),
    students: studentsWithClasses,
    classGroups,
  };
}

export function approvePendingUser(input: {
  organizationId: number;
  userId: number;
  role: Exclude<UserRole, "pending">;
}): void {
  const result = db
    .prepare(`
      UPDATE users
      SET role = ?
      WHERE id = ? AND organization_id = ? AND role = 'pending'
    `)
    .run(input.role, input.userId, input.organizationId);

  if (result.changes === 0) {
    throw new Error("Pending user was not found for this masjid.");
  }
}

function getOrganizationUser(
  userId: number,
  organizationId: number,
): { id: number; role: UserRole; active: boolean } | null {
  const row = db
    .prepare(`
      SELECT id, role, active
      FROM users
      WHERE id = ? AND organization_id = ?
      LIMIT 1
    `)
    .get(userId, organizationId) as { id: number; role: UserRole; active: number } | undefined;

  return row ? { id: row.id, role: row.role, active: row.active === 1 } : null;
}

function getActiveAdminCount(organizationId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM users WHERE organization_id = ? AND role = 'admin' AND active = 1")
    .get(organizationId) as { count: number };

  return row.count;
}

function getTeacherAssignmentCount(userId: number): number {
  const studentCount = db
    .prepare("SELECT COUNT(*) AS count FROM students WHERE teacher_user_id = ?")
    .get(userId) as { count: number };
  const classCount = db
    .prepare("SELECT COUNT(*) AS count FROM class_groups WHERE teacher_user_id = ?")
    .get(userId) as { count: number };

  return studentCount.count + classCount.count;
}

function getGuardianAssignmentCount(userId: number): number {
  const primaryStudentCount = db
    .prepare("SELECT COUNT(*) AS count FROM students WHERE guardian_user_id = ?")
    .get(userId) as { count: number };
  const guardianLinkCount = db
    .prepare("SELECT COUNT(*) AS count FROM student_guardians WHERE guardian_user_id = ?")
    .get(userId) as { count: number };

  return primaryStudentCount.count + guardianLinkCount.count;
}

export function createOrganizationUser(input: {
  organizationId: number;
  role: UserRole;
  name: string;
  email: string;
  password: string;
}): void {
  if (!["admin", "teacher", "parent", "pending"].includes(input.role)) {
    throw new Error("Unsupported user role.");
  }

  const passwordHash = bcrypt.hashSync(input.password, 10);

  try {
    db.prepare(`
      INSERT INTO users (organization_id, role, name, email, password_hash)
      VALUES (?, ?, ?, ?, ?)
    `).run(input.organizationId, input.role, input.name, input.email, passwordHash);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      throw new Error("A user with that email already exists.");
    }

    throw error;
  }
}

export function updateOrganizationUser(input: {
  organizationId: number;
  currentAdminId: number;
  userId: number;
  role: Exclude<UserRole, "pending">;
  name: string;
  email: string;
}): void {
  const existingUser = getOrganizationUser(input.userId, input.organizationId);

  if (!existingUser || existingUser.role === "pending") {
    throw new Error("User was not found for this masjid.");
  }

  if (existingUser.id === input.currentAdminId && input.role !== "admin") {
    throw new Error("You cannot remove your own admin role.");
  }

  if (existingUser.role === "admin" && input.role !== "admin" && existingUser.active) {
    if (getActiveAdminCount(input.organizationId) <= 1) {
      throw new Error("At least one active admin is required.");
    }
  }

  if (existingUser.role === "teacher" && input.role !== "teacher" && getTeacherAssignmentCount(input.userId) > 0) {
    throw new Error("Reassign this teacher's students and classes before changing their role.");
  }

  if (existingUser.role === "parent" && input.role !== "parent" && getGuardianAssignmentCount(input.userId) > 0) {
    throw new Error("Remove this guardian from linked students before changing their role.");
  }

  try {
    const result = db
      .prepare(`
        UPDATE users
        SET name = ?, email = ?, role = ?
        WHERE id = ? AND organization_id = ?
      `)
      .run(input.name, input.email, input.role, input.userId, input.organizationId);

    if (result.changes === 0) {
      throw new Error("User was not found for this masjid.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      throw new Error("A user with that email already exists.");
    }

    throw error;
  }
}

export function setOrganizationUserActive(input: {
  organizationId: number;
  currentAdminId: number;
  userId: number;
  active: boolean;
}): void {
  const existingUser = getOrganizationUser(input.userId, input.organizationId);

  if (!existingUser || existingUser.role === "pending") {
    throw new Error("User was not found for this masjid.");
  }

  if (!input.active && existingUser.id === input.currentAdminId) {
    throw new Error("You cannot deactivate your own account.");
  }

  if (!input.active && existingUser.role === "admin" && existingUser.active) {
    if (getActiveAdminCount(input.organizationId) <= 1) {
      throw new Error("At least one active admin is required.");
    }
  }

  const transaction = db.transaction(() => {
    const result = db
      .prepare("UPDATE users SET active = ? WHERE id = ? AND organization_id = ?")
      .run(input.active ? 1 : 0, input.userId, input.organizationId);

    if (result.changes === 0) {
      throw new Error("User was not found for this masjid.");
    }

    if (!input.active) {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(input.userId);
    }
  });

  transaction();
}

export function deleteOrganizationUser(input: {
  organizationId: number;
  currentAdminId: number;
  userId: number;
}): void {
  const existingUser = getOrganizationUser(input.userId, input.organizationId);

  if (!existingUser || existingUser.role === "pending") {
    throw new Error("User was not found for this masjid.");
  }

  if (existingUser.id === input.currentAdminId) {
    throw new Error("You cannot delete your own account.");
  }

  if (existingUser.role === "admin" && existingUser.active && getActiveAdminCount(input.organizationId) <= 1) {
    throw new Error("At least one active admin is required.");
  }

  if (getUserDependencyCount(input.userId) > 0) {
    throw new Error("Deactivate this user instead, or remove their student/class links before deleting.");
  }

  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(input.userId);
    db.prepare("DELETE FROM password_reset_tokens WHERE user_id = ?").run(input.userId);
    db.prepare("DELETE FROM users WHERE id = ? AND organization_id = ?").run(input.userId, input.organizationId);
  });

  transaction();
}

export function createStudent(input: {
  organizationId: number;
  guardianUserId: number;
  teacherUserId: number;
  firstName: string;
  lastName: string;
  currentSurah: string;
  currentAyah: string;
  monthlyFee: number;
}): void {
  if (!userBelongsToOrganization(input.guardianUserId, input.organizationId, "parent")) {
    throw new Error("Selected guardian does not belong to this masjid.");
  }

  if (!userBelongsToOrganization(input.teacherUserId, input.organizationId, "teacher")) {
    throw new Error("Selected teacher does not belong to this masjid.");
  }

  const transaction = db.transaction(() => {
    const studentInfo = db.prepare(`
      INSERT INTO students (
        organization_id, guardian_user_id, teacher_user_id,
        first_name, last_name, current_surah, current_ayah, monthly_fee
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.organizationId,
      input.guardianUserId,
      input.teacherUserId,
      input.firstName,
      input.lastName,
      input.currentSurah,
      input.currentAyah,
      input.monthlyFee,
    );

    db.prepare(`
      INSERT OR IGNORE INTO student_guardians (student_id, guardian_user_id, relationship, is_primary)
      VALUES (?, ?, ?, ?)
    `).run(Number(studentInfo.lastInsertRowid), input.guardianUserId, "guardian", 1);
  });

  transaction();
}

function studentBelongsToOrganization(studentId: number, organizationId: number): boolean {
  const row = db
    .prepare(`
      SELECT id
      FROM students
      WHERE id = ? AND organization_id = ?
    `)
    .get(studentId, organizationId) as { id: number } | undefined;

  return Boolean(row);
}

export function updateStudent(input: {
  organizationId: number;
  studentId: number;
  teacherUserId: number;
  firstName: string;
  lastName: string;
  currentSurah: string;
  currentAyah: string;
  monthlyFee: number;
}): void {
  if (!userBelongsToOrganization(input.teacherUserId, input.organizationId, "teacher")) {
    throw new Error("Selected teacher does not belong to this masjid.");
  }

  const result = db
    .prepare(`
      UPDATE students
      SET
        teacher_user_id = ?,
        first_name = ?,
        last_name = ?,
        current_surah = ?,
        current_ayah = ?,
        monthly_fee = ?
      WHERE id = ? AND organization_id = ?
    `)
    .run(
      input.teacherUserId,
      input.firstName,
      input.lastName,
      input.currentSurah,
      input.currentAyah,
      input.monthlyFee,
      input.studentId,
      input.organizationId,
    );

  if (result.changes === 0) {
    throw new Error("Student was not found for this masjid.");
  }
}

export function assignGuardianToStudent(input: {
  organizationId: number;
  studentId: number;
  guardianUserId: number;
  relationship: string;
}): void {
  if (!userBelongsToOrganization(input.guardianUserId, input.organizationId, "parent")) {
    throw new Error("Selected guardian does not belong to this masjid.");
  }

  const student = db
    .prepare(`
      SELECT id
      FROM students
      WHERE id = ? AND organization_id = ?
    `)
    .get(input.studentId, input.organizationId) as { id: number } | undefined;

  if (!student) {
    throw new Error("Student was not found for this masjid.");
  }

  db.prepare(`
    INSERT OR IGNORE INTO student_guardians (student_id, guardian_user_id, relationship, is_primary)
    VALUES (?, ?, ?, ?)
  `).run(input.studentId, input.guardianUserId, input.relationship || "guardian", 0);
}

export function removeGuardianFromStudent(input: {
  organizationId: number;
  studentId: number;
  guardianUserId: number;
}): void {
  const link = db
    .prepare(`
      SELECT sg.guardian_user_id AS guardianUserId, sg.is_primary AS isPrimary
      FROM student_guardians sg
      INNER JOIN students s ON s.id = sg.student_id
      INNER JOIN users u ON u.id = sg.guardian_user_id
      WHERE sg.student_id = ?
        AND sg.guardian_user_id = ?
        AND s.organization_id = ?
        AND u.organization_id = ?
        AND u.role = 'parent'
      LIMIT 1
    `)
    .get(input.studentId, input.guardianUserId, input.organizationId, input.organizationId) as
    | { guardianUserId: number; isPrimary: number }
    | undefined;

  if (!link) {
    throw new Error("Guardian link was not found for this masjid.");
  }

  const guardianCount = db
    .prepare("SELECT COUNT(*) AS count FROM student_guardians WHERE student_id = ?")
    .get(input.studentId) as { count: number };

  if (guardianCount.count <= 1) {
    throw new Error("A student must have at least one linked guardian.");
  }

  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM student_guardians WHERE student_id = ? AND guardian_user_id = ?").run(
      input.studentId,
      input.guardianUserId,
    );

    const remainingPrimary = db
      .prepare(`
        SELECT guardian_user_id AS guardianUserId
        FROM student_guardians
        WHERE student_id = ? AND is_primary = 1
        LIMIT 1
      `)
      .get(input.studentId) as { guardianUserId: number } | undefined;

    const fallbackGuardian = db
      .prepare(`
        SELECT guardian_user_id AS guardianUserId
        FROM student_guardians
        WHERE student_id = ?
        ORDER BY created_at, guardian_user_id
        LIMIT 1
      `)
      .get(input.studentId) as { guardianUserId: number } | undefined;

    const primaryGuardianId = remainingPrimary?.guardianUserId ?? fallbackGuardian?.guardianUserId;

    if (!primaryGuardianId) {
      throw new Error("A student must have at least one linked guardian.");
    }

    db.prepare("UPDATE student_guardians SET is_primary = CASE WHEN guardian_user_id = ? THEN 1 ELSE 0 END WHERE student_id = ?").run(
      primaryGuardianId,
      input.studentId,
    );
    db.prepare("UPDATE students SET guardian_user_id = ? WHERE id = ? AND organization_id = ?").run(
      primaryGuardianId,
      input.studentId,
      input.organizationId,
    );
  });

  transaction();
}

export function createClassGroup(input: {
  organizationId: number;
  teacherUserId: number;
  name: string;
  description: string;
}): void {
  if (!userBelongsToOrganization(input.teacherUserId, input.organizationId, "teacher")) {
    throw new Error("Selected teacher does not belong to this masjid.");
  }

  db.prepare(`
    INSERT INTO class_groups (organization_id, teacher_user_id, name, description)
    VALUES (?, ?, ?, ?)
  `).run(input.organizationId, input.teacherUserId, input.name, input.description);
}

export function updateClassGroup(input: {
  organizationId: number;
  classGroupId: number;
  teacherUserId: number;
  name: string;
  description: string;
}): void {
  if (!userBelongsToOrganization(input.teacherUserId, input.organizationId, "teacher")) {
    throw new Error("Selected teacher does not belong to this masjid.");
  }

  const result = db
    .prepare(`
      UPDATE class_groups
      SET teacher_user_id = ?, name = ?, description = ?
      WHERE id = ? AND organization_id = ?
    `)
    .run(input.teacherUserId, input.name, input.description, input.classGroupId, input.organizationId);

  if (result.changes === 0) {
    throw new Error("Class was not found for this masjid.");
  }
}

export function assignStudentToClass(input: {
  organizationId: number;
  classGroupId: number;
  studentId: number;
}): void {
  const classGroup = db
    .prepare(`
      SELECT id
      FROM class_groups
      WHERE id = ? AND organization_id = ?
    `)
    .get(input.classGroupId, input.organizationId) as { id: number } | undefined;

  if (!classGroup) {
    throw new Error("Class was not found for this masjid.");
  }

  const student = db
    .prepare(`
      SELECT id
      FROM students
      WHERE id = ? AND organization_id = ?
    `)
    .get(input.studentId, input.organizationId) as { id: number } | undefined;

  if (!student) {
    throw new Error("Student was not found for this masjid.");
  }

  db.prepare(`
    INSERT OR IGNORE INTO class_students (class_group_id, student_id)
    VALUES (?, ?)
  `).run(input.classGroupId, input.studentId);
}

export function removeStudentFromClass(input: {
  organizationId: number;
  classGroupId: number;
  studentId: number;
}): void {
  const classGroup = db
    .prepare(`
      SELECT id
      FROM class_groups
      WHERE id = ? AND organization_id = ?
    `)
    .get(input.classGroupId, input.organizationId) as { id: number } | undefined;

  if (!classGroup) {
    throw new Error("Class was not found for this masjid.");
  }

  if (!studentBelongsToOrganization(input.studentId, input.organizationId)) {
    throw new Error("Student was not found for this masjid.");
  }

  const result = db
    .prepare("DELETE FROM class_students WHERE class_group_id = ? AND student_id = ?")
    .run(input.classGroupId, input.studentId);

  if (result.changes === 0) {
    throw new Error("Student was not assigned to that class.");
  }
}

export function deleteClassGroup(input: {
  organizationId: number;
  classGroupId: number;
}): void {
  const classGroup = db
    .prepare(`
      SELECT id
      FROM class_groups
      WHERE id = ? AND organization_id = ?
    `)
    .get(input.classGroupId, input.organizationId) as { id: number } | undefined;

  if (!classGroup) {
    throw new Error("Class was not found for this masjid.");
  }

  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM class_students WHERE class_group_id = ?").run(input.classGroupId);
    db.prepare("DELETE FROM class_groups WHERE id = ? AND organization_id = ?").run(
      input.classGroupId,
      input.organizationId,
    );
  });

  transaction();
}

function studentBelongsToTeacher(studentId: number, teacherId: number): boolean {
  const row = db
    .prepare(`
      SELECT s.id
      FROM students s
      LEFT JOIN class_students cs ON cs.student_id = s.id
      LEFT JOIN class_groups cg ON cg.id = cs.class_group_id
      WHERE s.id = ?
        AND (s.teacher_user_id = ? OR cg.teacher_user_id = ?)
      LIMIT 1
    `)
    .get(studentId, teacherId, teacherId) as { id: number } | undefined;

  return Boolean(row);
}

export function recordAttendance(
  teacherId: number,
  studentId: number,
  lessonDate: string,
  status: AttendanceStatus,
): void {
  if (!studentBelongsToTeacher(studentId, teacherId)) {
    throw new Error("Student is not assigned to this teacher.");
  }

  db.prepare(`
    INSERT INTO attendance (student_id, lesson_date, status)
    VALUES (?, ?, ?)
    ON CONFLICT(student_id, lesson_date)
    DO UPDATE SET status = excluded.status
  `).run(studentId, lessonDate, status);
}

export function addProgressEntry(input: {
  teacherId: number;
  studentId: number;
  lessonDate: string;
  sabak: string;
  sabki: string;
  manzil: string;
  homework: string;
  strengths: string;
  weaknesses: string;
  note: string;
}): void {
  if (!studentBelongsToTeacher(input.studentId, input.teacherId)) {
    throw new Error("Student is not assigned to this teacher.");
  }

  db.prepare(`
    INSERT INTO progress_entries (
      student_id, teacher_id, lesson_date, sabak, sabki, manzil,
      homework, strengths, weaknesses, note
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.studentId,
    input.teacherId,
    input.lessonDate,
    input.sabak,
    input.sabki,
    input.manzil,
    input.homework,
    input.strengths,
    input.weaknesses,
    input.note,
  );
}

export function upsertFee(input: {
  teacherId: number;
  studentId: number;
  feeMonth: string;
  amountDue: number;
  status: FeeStatus;
  paidOn: string | null;
  note: string;
}): void {
  if (!studentBelongsToTeacher(input.studentId, input.teacherId)) {
    throw new Error("Student is not assigned to this teacher.");
  }

  db.prepare(`
    INSERT INTO fees (student_id, fee_month, amount_due, status, paid_on, note)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(student_id, fee_month)
    DO UPDATE SET
      amount_due = excluded.amount_due,
      status = excluded.status,
      paid_on = excluded.paid_on,
      note = excluded.note
  `).run(
    input.studentId,
    input.feeMonth,
    input.amountDue,
    input.status,
    input.paidOn,
    input.note,
  );
}
