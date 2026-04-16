import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import { z } from "zod";

import {
  addProgressEntry,
  assignGuardianToStudent,
  approvePendingUser,
  assignStudentToClass,
  createClassGroup,
  deleteClassGroup,
  deleteOrganizationUser,
  createPasswordResetToken,
  createOrganizationUser,
  createSession,
  createStudent,
  destroySession,
  getAdminDashboardData,
  getParentDashboardData,
  getTeacherDashboardData,
  getUserForSession,
  initializeDatabase,
  recordAttendance,
  registerAdminWithSetupCode,
  registerWithMasjidCode,
  removeGuardianFromStudent,
  removeStudentFromClass,
  resetPasswordWithToken,
  setOrganizationUserActive,
  updateClassGroup,
  updateOrganizationUser,
  updateStudent,
  upsertFee,
  validateUserCredentials,
} from "./database.js";
import { loadTenantConfig } from "./tenant-config.js";
import type { AttendanceStatus, AuthUser, FeeStatus, UserRole } from "./types.js";

declare global {
  namespace Express {
    interface Request {
      user: AuthUser | null;
      sessionId?: string;
    }
  }
}

export function createApp() {
  const app = express();
  const cookieSecret = process.env.COOKIE_SECRET || "local-madrassah-secret";
  const tenantConfig = loadTenantConfig();
  const currencySymbols: Record<string, string> = {
    GBP: "£",
    USD: "$",
    EUR: "€",
  };
  const currencySymbol = currencySymbols[tenantConfig.currency] ?? `${tenantConfig.currency} `;

  initializeDatabase(tenantConfig);

  app.set("views", path.resolve(process.cwd(), "views"));
  app.set("view engine", "ejs");

  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser(cookieSecret));
  app.use("/public", express.static(path.resolve(process.cwd(), "public")));

  app.use((req: Request, res: Response, next: NextFunction) => {
    const sessionId = req.signedCookies.sessionId as string | undefined;
    req.sessionId = sessionId;
    req.user = getUserForSession(sessionId);
    res.locals.user = req.user;
    res.locals.tenant = tenantConfig;
    res.locals.currencySymbol = currencySymbol;
    res.locals.notice = typeof req.query.notice === "string" ? req.query.notice : null;
    res.locals.error = typeof req.query.error === "string" ? req.query.error : null;
    next();
  });

  function redirectForRole(role: UserRole): string {
    if (role === "pending") {
      return "/pending";
    }

    if (role === "admin") {
      return "/admin/dashboard";
    }

    if (role === "teacher") {
      return "/teacher/dashboard";
    }

    if (role === "parent") {
      return "/parent/dashboard";
    }

    return "/";
  }

  function requireRole(role: UserRole) {
    return (req: Request, res: Response, next: NextFunction) => {
      if (!req.user) {
        return res.redirect("/?error=Please log in to continue.");
      }

      if (req.user.role !== role) {
        return res.redirect(`${redirectForRole(req.user.role)}?error=You do not have access to that page.`);
      }

      return next();
    };
  }

  app.get("/", (req: Request, res: Response) => {
    if (req.user) {
      return res.redirect(redirectForRole(req.user.role));
    }

    return res.render("login", {
      pageTitle: tenantConfig.displayName,
    });
  });

  app.post("/login", (req: Request, res: Response) => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(8),
    });

    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.redirect("/?error=Enter a valid email and password.");
    }

    const user = validateUserCredentials(result.data.email, result.data.password);

    if (!user) {
      return res.redirect("/?error=Invalid login details.");
    }

    const sessionId = createSession(user.id);
    res.cookie("sessionId", sessionId, {
      signed: true,
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 24 * 7,
    });

    return res.redirect(`${redirectForRole(user.role)}?notice=Welcome back, ${encodeURIComponent(user.name)}.`);
  });

  app.get("/signup", (req: Request, res: Response) => {
    if (req.user) {
      return res.redirect(redirectForRole(req.user.role));
    }

    return res.render("signup", {
      pageTitle: "Sign up",
    });
  });

  app.post("/signup", (req: Request, res: Response) => {
    const schema = z
      .object({
        accountType: z.enum(["user", "admin"]),
        name: z.string().min(2),
        email: z.string().email(),
        password: z.string().min(8),
        confirmPassword: z.string().min(8),
        masjidCode: z.string().optional(),
        adminSignupCode: z.string().optional(),
      })
      .refine((data) => data.password === data.confirmPassword, {
        message: "Passwords do not match.",
        path: ["confirmPassword"],
      });

    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.redirect("/signup?error=Signup details were invalid.");
    }

    try {
      if (result.data.accountType === "admin") {
        registerAdminWithSetupCode({
          name: result.data.name,
          email: result.data.email,
          password: result.data.password,
          adminSignupCode: result.data.adminSignupCode ?? "",
        });

        return res.redirect("/?notice=Admin account created. You can now log in.");
      }

      registerWithMasjidCode({
        name: result.data.name,
        email: result.data.email,
        password: result.data.password,
        masjidCode: result.data.masjidCode ?? "",
      });
    } catch (error) {
      return res.redirect(`/signup?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/pending?notice=Signup received. A masjid admin must approve your account.");
  });

  app.get("/pending", (_req: Request, res: Response) => {
    return res.render("pending", {
      pageTitle: "Awaiting approval",
    });
  });

  app.get("/forgot-password", (req: Request, res: Response) => {
    if (req.user) {
      return res.redirect(redirectForRole(req.user.role));
    }

    return res.render("forgot-password", {
      pageTitle: "Forgot password",
      resetLink: null,
    });
  });

  app.post("/forgot-password", (req: Request, res: Response) => {
    const schema = z.object({
      email: z.string().email(),
    });

    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.redirect("/forgot-password?error=Enter a valid email address.");
    }

    const token = createPasswordResetToken(result.data.email);
    const resetLink = token ? `/reset-password?token=${encodeURIComponent(token)}` : null;

    return res.render("forgot-password", {
      pageTitle: "Forgot password",
      resetLink,
      notice: "If the email exists, a reset link has been generated.",
      error: null,
    });
  });

  app.get("/reset-password", (req: Request, res: Response) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";

    return res.render("reset-password", {
      pageTitle: "Reset password",
      token,
    });
  });

  app.post("/reset-password", (req: Request, res: Response) => {
    const schema = z
      .object({
        token: z.string().min(10),
        password: z.string().min(8),
        confirmPassword: z.string().min(8),
      })
      .refine((data) => data.password === data.confirmPassword, {
        message: "Passwords do not match.",
        path: ["confirmPassword"],
      });

    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.redirect(`/reset-password?token=${encodeURIComponent(String(req.body.token ?? ""))}&error=Password details were invalid.`);
    }

    try {
      resetPasswordWithToken(result.data.token, result.data.password);
    } catch (error) {
      return res.redirect(`/reset-password?token=${encodeURIComponent(result.data.token)}&error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/?notice=Password reset. You can now log in.");
  });

  app.post("/logout", (req: Request, res: Response) => {
    if (req.sessionId) {
      destroySession(req.sessionId);
    }

    res.clearCookie("sessionId");
    return res.redirect("/?notice=You have been logged out.");
  });

  app.get("/admin/dashboard", requireRole("admin"), (req: Request, res: Response) => {
    const dashboard = getAdminDashboardData(req.user!.organizationId);

    return res.render("admin-dashboard", {
      pageTitle: "Admin Dashboard",
      dashboard,
    });
  });

  app.post("/admin/users", requireRole("admin"), (req: Request, res: Response) => {
    const schema = z.object({
      name: z.string().min(2),
      email: z.string().email(),
      role: z.enum(["admin", "teacher", "parent"]),
      password: z.string().min(8),
    });

    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.redirect("/admin/dashboard?error=User details were invalid.");
    }

    try {
      createOrganizationUser({
        organizationId: req.user!.organizationId,
        role: result.data.role as UserRole,
        name: result.data.name,
        email: result.data.email,
        password: result.data.password,
      });
    } catch (error) {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/admin/dashboard?notice=User created.");
  });

  app.post("/admin/users/:userId/approve", requireRole("admin"), (req: Request, res: Response) => {
    const schema = z.object({
      userId: z.coerce.number().int().positive(),
      role: z.enum(["admin", "teacher", "parent"]),
    });

    const result = schema.safeParse({
      userId: req.params.userId,
      role: req.body.role,
    });

    if (!result.success) {
      return res.redirect("/admin/dashboard?error=Approval details were invalid.");
    }

    try {
      approvePendingUser({
        organizationId: req.user!.organizationId,
        userId: result.data.userId,
        role: result.data.role as Exclude<UserRole, "pending">,
      });
    } catch (error) {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/admin/dashboard?notice=User approved.");
  });

  app.post("/admin/users/:userId", requireRole("admin"), (req: Request, res: Response) => {
    const schema = z.object({
      userId: z.coerce.number().int().positive(),
      name: z.string().min(2),
      email: z.string().email(),
      role: z.enum(["admin", "teacher", "parent"]),
    });

    const result = schema.safeParse({
      userId: req.params.userId,
      ...req.body,
    });

    if (!result.success) {
      return res.redirect("/admin/dashboard?error=User update details were invalid.");
    }

    try {
      updateOrganizationUser({
        organizationId: req.user!.organizationId,
        currentAdminId: req.user!.id,
        userId: result.data.userId,
        name: result.data.name,
        email: result.data.email,
        role: result.data.role as Exclude<UserRole, "pending">,
      });
    } catch (error) {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/admin/dashboard?notice=User details updated.");
  });

  app.post("/admin/users/:userId/active", requireRole("admin"), (req: Request, res: Response) => {
    const schema = z.object({
      userId: z.coerce.number().int().positive(),
      active: z.enum(["0", "1"]),
    });

    const result = schema.safeParse({
      userId: req.params.userId,
      active: req.body.active,
    });

    if (!result.success) {
      return res.redirect("/admin/dashboard?error=User status details were invalid.");
    }

    try {
      setOrganizationUserActive({
        organizationId: req.user!.organizationId,
        currentAdminId: req.user!.id,
        userId: result.data.userId,
        active: result.data.active === "1",
      });
    } catch (error) {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect(`/admin/dashboard?notice=User ${result.data.active === "1" ? "reactivated" : "deactivated"}.`);
  });

  app.post("/admin/users/:userId/delete", requireRole("admin"), (req: Request, res: Response) => {
    const schema = z.object({
      userId: z.coerce.number().int().positive(),
    });

    const result = schema.safeParse({
      userId: req.params.userId,
    });

    if (!result.success) {
      return res.redirect("/admin/dashboard?error=User deletion details were invalid.");
    }

    try {
      deleteOrganizationUser({
        organizationId: req.user!.organizationId,
        currentAdminId: req.user!.id,
        userId: result.data.userId,
      });
    } catch (error) {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/admin/dashboard?notice=User deleted.");
  });

  app.post("/admin/students", requireRole("admin"), (req: Request, res: Response) => {
    const schema = z.object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      guardianUserId: z.coerce.number().int().positive(),
      teacherUserId: z.coerce.number().int().positive(),
      currentSurah: z.string().min(2),
      currentAyah: z.string().min(2),
      monthlyFee: z.coerce.number().min(0),
    });

    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.redirect("/admin/dashboard?error=Student details were invalid.");
    }

    try {
      createStudent({
        organizationId: req.user!.organizationId,
        ...result.data,
      });
    } catch (error) {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/admin/dashboard?notice=Student created.");
  });

  app.post("/admin/students/:studentId", requireRole("admin"), (req: Request, res: Response) => {
    const schema = z.object({
      studentId: z.coerce.number().int().positive(),
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      teacherUserId: z.coerce.number().int().positive(),
      currentSurah: z.string().min(2),
      currentAyah: z.string().min(2),
      monthlyFee: z.coerce.number().min(0),
    });

    const result = schema.safeParse({
      studentId: req.params.studentId,
      ...req.body,
    });

    if (!result.success) {
      return res.redirect("/admin/dashboard?error=Student update details were invalid.");
    }

    try {
      updateStudent({
        organizationId: req.user!.organizationId,
        ...result.data,
      });
    } catch (error) {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/admin/dashboard?notice=Student details updated.");
  });

  app.post("/admin/students/:studentId/guardians", requireRole("admin"), (req: Request, res: Response) => {
    const schema = z.object({
      studentId: z.coerce.number().int().positive(),
      guardianUserId: z.coerce.number().int().positive(),
      relationship: z.string().min(2).max(40).default("guardian"),
    });

    const result = schema.safeParse({
      studentId: req.params.studentId,
      guardianUserId: req.body.guardianUserId,
      relationship: req.body.relationship || "guardian",
    });

    if (!result.success) {
      return res.redirect("/admin/dashboard?error=Guardian link details were invalid.");
    }

    try {
      assignGuardianToStudent({
        organizationId: req.user!.organizationId,
        studentId: result.data.studentId,
        guardianUserId: result.data.guardianUserId,
        relationship: result.data.relationship,
      });
    } catch (error) {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/admin/dashboard?notice=Guardian linked to student.");
  });

  app.post(
    "/admin/students/:studentId/guardians/:guardianUserId/remove",
    requireRole("admin"),
    (req: Request, res: Response) => {
      const schema = z.object({
        studentId: z.coerce.number().int().positive(),
        guardianUserId: z.coerce.number().int().positive(),
      });

      const result = schema.safeParse({
        studentId: req.params.studentId,
        guardianUserId: req.params.guardianUserId,
      });

      if (!result.success) {
        return res.redirect("/admin/dashboard?error=Guardian removal details were invalid.");
      }

      try {
        removeGuardianFromStudent({
          organizationId: req.user!.organizationId,
          studentId: result.data.studentId,
          guardianUserId: result.data.guardianUserId,
        });
      } catch (error) {
        return res.redirect(`/admin/dashboard?error=${encodeURIComponent((error as Error).message)}`);
      }

      return res.redirect("/admin/dashboard?notice=Guardian link removed.");
    },
  );

  app.post("/admin/classes", requireRole("admin"), (req: Request, res: Response) => {
    const schema = z.object({
      name: z.string().min(2),
      description: z.string().optional(),
      teacherUserId: z.coerce.number().int().positive(),
    });

    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.redirect("/admin/dashboard?error=Class details were invalid.");
    }

    try {
      createClassGroup({
        organizationId: req.user!.organizationId,
        teacherUserId: result.data.teacherUserId,
        name: result.data.name,
        description: result.data.description ?? "",
      });
    } catch (error) {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/admin/dashboard?notice=Class created.");
  });

  app.post("/admin/classes/:classGroupId", requireRole("admin"), (req: Request, res: Response) => {
    const schema = z.object({
      classGroupId: z.coerce.number().int().positive(),
      name: z.string().min(2),
      description: z.string().optional(),
      teacherUserId: z.coerce.number().int().positive(),
    });

    const result = schema.safeParse({
      classGroupId: req.params.classGroupId,
      ...req.body,
    });

    if (!result.success) {
      return res.redirect("/admin/dashboard?error=Class update details were invalid.");
    }

    try {
      updateClassGroup({
        organizationId: req.user!.organizationId,
        classGroupId: result.data.classGroupId,
        teacherUserId: result.data.teacherUserId,
        name: result.data.name,
        description: result.data.description ?? "",
      });
    } catch (error) {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/admin/dashboard?notice=Class details updated.");
  });

  app.post("/admin/classes/:classGroupId/delete", requireRole("admin"), (req: Request, res: Response) => {
    const schema = z.object({
      classGroupId: z.coerce.number().int().positive(),
    });

    const result = schema.safeParse({
      classGroupId: req.params.classGroupId,
    });

    if (!result.success) {
      return res.redirect("/admin/dashboard?error=Class deletion details were invalid.");
    }

    try {
      deleteClassGroup({
        organizationId: req.user!.organizationId,
        classGroupId: result.data.classGroupId,
      });
    } catch (error) {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/admin/dashboard?notice=Class deleted.");
  });

  app.post("/admin/classes/:classGroupId/students", requireRole("admin"), (req: Request, res: Response) => {
    const schema = z.object({
      classGroupId: z.coerce.number().int().positive(),
      studentId: z.coerce.number().int().positive(),
    });

    const result = schema.safeParse({
      classGroupId: req.params.classGroupId,
      studentId: req.body.studentId,
    });

    if (!result.success) {
      return res.redirect("/admin/dashboard?error=Class assignment was invalid.");
    }

    try {
      assignStudentToClass({
        organizationId: req.user!.organizationId,
        classGroupId: result.data.classGroupId,
        studentId: result.data.studentId,
      });
    } catch (error) {
      return res.redirect(`/admin/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/admin/dashboard?notice=Student assigned to class.");
  });

  app.post(
    "/admin/classes/:classGroupId/students/:studentId/remove",
    requireRole("admin"),
    (req: Request, res: Response) => {
      const schema = z.object({
        classGroupId: z.coerce.number().int().positive(),
        studentId: z.coerce.number().int().positive(),
      });

      const result = schema.safeParse({
        classGroupId: req.params.classGroupId,
        studentId: req.params.studentId,
      });

      if (!result.success) {
        return res.redirect("/admin/dashboard?error=Class assignment removal details were invalid.");
      }

      try {
        removeStudentFromClass({
          organizationId: req.user!.organizationId,
          classGroupId: result.data.classGroupId,
          studentId: result.data.studentId,
        });
      } catch (error) {
        return res.redirect(`/admin/dashboard?error=${encodeURIComponent((error as Error).message)}`);
      }

      return res.redirect("/admin/dashboard?notice=Class assignment removed.");
    },
  );

  app.get("/teacher/dashboard", requireRole("teacher"), (req: Request, res: Response) => {
    const dashboard = getTeacherDashboardData(req.user!.id, req.user!.organizationId);

    return res.render("teacher-dashboard", {
      pageTitle: "Teacher Dashboard",
      dashboard,
      today: new Date().toISOString().slice(0, 10),
      currentMonth: new Date().toISOString().slice(0, 7),
    });
  });

  app.post("/teacher/attendance", requireRole("teacher"), (req: Request, res: Response) => {
    const schema = z.object({
      studentId: z.coerce.number().int().positive(),
      lessonDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      status: z.enum(["present", "late", "absent"]),
    });

    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.redirect("/teacher/dashboard?error=Attendance entry was invalid.");
    }

    try {
      recordAttendance(
        req.user!.id,
        result.data.studentId,
        result.data.lessonDate,
        result.data.status as AttendanceStatus,
      );
    } catch (error) {
      return res.redirect(`/teacher/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/teacher/dashboard?notice=Attendance saved.");
  });

  app.post("/teacher/progress", requireRole("teacher"), (req: Request, res: Response) => {
    const schema = z.object({
      studentId: z.coerce.number().int().positive(),
      lessonDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      sabak: z.string().min(2),
      sabki: z.string().min(2),
      manzil: z.string().min(2),
      homework: z.string().min(2),
      strengths: z.string().min(2),
      weaknesses: z.string().min(2),
      note: z.string().min(4),
    });

    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.redirect("/teacher/dashboard?error=Progress update was invalid.");
    }

    try {
      addProgressEntry({
        teacherId: req.user!.id,
        ...result.data,
      });
    } catch (error) {
      return res.redirect(`/teacher/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/teacher/dashboard?notice=Progress note added.");
  });

  app.post("/teacher/fees", requireRole("teacher"), (req: Request, res: Response) => {
    const schema = z.object({
      studentId: z.coerce.number().int().positive(),
      feeMonth: z.string().regex(/^\d{4}-\d{2}$/),
      amountDue: z.coerce.number().min(0),
      status: z.enum(["paid", "pending", "overdue", "partial"]),
      paidOn: z.string().optional(),
      note: z.string().min(2),
    });

    const result = schema.safeParse(req.body);

    if (!result.success) {
      return res.redirect("/teacher/dashboard?error=Fee update was invalid.");
    }

    try {
      upsertFee({
        teacherId: req.user!.id,
        studentId: result.data.studentId,
        feeMonth: result.data.feeMonth,
        amountDue: result.data.amountDue,
        status: result.data.status as FeeStatus,
        paidOn: result.data.paidOn ? result.data.paidOn : null,
        note: result.data.note,
      });
    } catch (error) {
      return res.redirect(`/teacher/dashboard?error=${encodeURIComponent((error as Error).message)}`);
    }

    return res.redirect("/teacher/dashboard?notice=Fee status updated.");
  });

  app.get("/parent/dashboard", requireRole("parent"), (req: Request, res: Response) => {
    const dashboard = getParentDashboardData(req.user!.id, req.user!.organizationId);

    return res.render("parent-dashboard", {
      pageTitle: "Parent Dashboard",
      dashboard,
    });
  });

  app.use((_: Request, res: Response) => {
    return res.status(404).render("not-found", {
      pageTitle: "Page not found",
    });
  });

  return app;
}
