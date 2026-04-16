export type UserRole = "pending" | "teacher" | "parent" | "admin";

export type AttendanceStatus = "present" | "late" | "absent";

export type FeeStatus = "paid" | "pending" | "overdue" | "partial";

export interface AuthUser {
  id: number;
  organizationId: number;
  role: UserRole;
  name: string;
  email: string;
}

export interface StudentSummary {
  strongPoints: string[];
  weakPoints: string[];
}

export interface TeacherStudentCard extends StudentSummary {
  id: number;
  fullName: string;
  currentSurah: string;
  currentAyah: string;
  monthlyFee: number;
  attendanceRate: number;
  latestAttendance: AttendanceStatus | null;
  latestFeeStatus: FeeStatus | null;
  latestProgress: {
    lessonDate: string;
    sabak: string;
    sabki: string;
    manzil: string;
    homework: string;
    note: string;
  } | null;
  recentNotes: string[];
}

export interface TeacherDashboardData {
  organizationName: string;
  currency: string;
  students: TeacherStudentCard[];
}

export interface ParentStudentView extends StudentSummary {
  id: number;
  fullName: string;
  currentSurah: string;
  currentAyah: string;
  monthlyFee: number;
  attendanceHistory: Array<{
    lessonDate: string;
    status: AttendanceStatus;
  }>;
  progressEntries: Array<{
    lessonDate: string;
    sabak: string;
    sabki: string;
    manzil: string;
    homework: string;
    strengths: string;
    weaknesses: string;
    note: string;
  }>;
  fees: Array<{
    feeMonth: string;
    amountDue: number;
    status: FeeStatus;
    paidOn: string | null;
    note: string;
  }>;
}

export interface ParentDashboardData {
  organizationName: string;
  currency: string;
  students: ParentStudentView[];
}

export interface AdminUserRow {
  id: number;
  name: string;
  email: string;
  role: UserRole;
}

export interface AdminStudentRow {
  id: number;
  fullName: string;
  currentSurah: string;
  currentAyah: string;
  monthlyFee: number;
  teacherName: string;
  guardianName: string;
}

export interface AdminDashboardData {
  organizationName: string;
  currency: string;
  users: AdminUserRow[];
  pendingUsers: AdminUserRow[];
  teachers: AdminUserRow[];
  guardians: AdminUserRow[];
  students: AdminStudentRow[];
}
