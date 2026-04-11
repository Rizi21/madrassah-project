import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const userSchema = z.object({
  name: z.string().min(2),
  email: z.string().email(),
  password: z.string().min(8),
});

const tenantConfigSchema = z.object({
  schemaVersion: z.literal(1),
  tenantId: z.string().regex(/^[a-z0-9-]+$/),
  displayName: z.string().min(2),
  country: z.string().min(2),
  timezone: z.string().min(2),
  currency: z.string().length(3),
  logoPath: z.string().min(1).optional(),
  contactNumbers: z.array(z.string().min(3)).default([]),
  terminology: z
    .object({
      teacher: z.string().min(2).default("Teacher"),
      parent: z.string().min(2).default("Parent"),
      student: z.string().min(2).default("Student"),
      progress: z.string().min(2).default("Progress"),
    })
    .default({
      teacher: "Teacher",
      parent: "Parent",
      student: "Student",
      progress: "Progress",
    }),
  features: z
    .object({
      fees: z.boolean().default(true),
      parentPortal: z.boolean().default(true),
      homework: z.boolean().default(true),
      quranBookmarks: z.boolean().default(true),
      teacherNotes: z.boolean().default(true),
    })
    .default({
      fees: true,
      parentPortal: true,
      homework: true,
      quranBookmarks: true,
      teacherNotes: true,
    }),
  attendanceStatuses: z.array(z.string().min(2)).default(["present", "late", "absent"]),
  feeDefaults: z
    .object({
      monthlyAmount: z.number().min(0).default(0),
      dueDayOfMonth: z.number().int().min(1).max(31).default(1),
    })
    .default({
      monthlyAmount: 0,
      dueDayOfMonth: 1,
    }),
  demoUsers: z.object({
    teacher: userSchema,
    parent: userSchema,
  }),
  seedStudents: z.array(
    z.object({
      firstName: z.string().min(1),
      lastName: z.string().min(1),
      currentSurah: z.string().min(2),
      currentAyah: z.string().min(2),
      monthlyFee: z.number().min(0).optional(),
    }),
  ),
  customFields: z
    .object({
      student: z
        .array(
          z.object({
            key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
            label: z.string().min(2),
            type: z.enum(["text", "phone", "number", "date", "boolean"]),
          }),
        )
        .default([]),
    })
    .default({
      student: [],
    }),
});

export type TenantConfig = z.infer<typeof tenantConfigSchema>;

export function loadTenantConfig(): TenantConfig {
  const configPath = process.env.TENANT_CONFIG_PATH || "config/tenants/makki-masjid.json";
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);
  const parsedJson = JSON.parse(fs.readFileSync(absoluteConfigPath, "utf8")) as unknown;
  return tenantConfigSchema.parse(parsedJson);
}
