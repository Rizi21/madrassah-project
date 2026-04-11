import path from "node:path";
import express, { type Request, type Response, type NextFunction } from "express";
import cookieParser from "cookie-parser";
import { z } from "zod";

import {
  addProgressEntry,
  createSession,
  destroySession,
  getParentDashboardData,
  getTeacherDashboardData,
  getUserForSession,
  initializeDatabase,
  recordAttendance,
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

  app.post("/logout", (req: Request, res: Response) => {
    if (req.sessionId) {
      destroySession(req.sessionId);
    }

    res.clearCookie("sessionId");
    return res.redirect("/?notice=You have been logged out.");
  });

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
