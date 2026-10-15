import type {
  AdminOverviewStats,
  Announcement,
  AttendancePoint,
  CertificateRequest,
  ComplianceItem,
  CompanyAsset,
  DtrLogEntry,
  Employee,
  EmployeeBenefit,
  EmployeeCase,
  JobRequisition,
  LeaveBalance,
  LeaveRequest,
  OffboardingCase,
  OfficeHeadcount,
  OnboardingStage,
  Payslip,
  PayrollCostSegment,
  PayrollRunStep,
  AuditLogEntry,
  AttendanceRequest,
  AdminProfile,
  PartnerProfile,
  PayrollEntry,
  PersonnelDocument,
  PersonnelDocumentType,
  PersonnelProfile,
  ProfessionalLicense,
  TeamRosterMember,
  TrainingRecord,
  WorkforceAlert,
} from "./types";

// The employee demo login (ceb.msma): Chris S. David, a new hire in Audit & Assurance.
export let currentEmployee: Employee = {
  id: "MSMA-00846",
  name: "Chris S. David",
  initials: "CD",
  position: "Junior Associate",
  department: "Audit & Assurance",
  office: "Cebu HQ",
  cluster: "RPM",
  status: "Active",
  email: "ceb.msma@gmail.com",
  phone: "09223344556",
  faceEnrolled: false,
};

export function setCurrentEmployee(next: Employee) {
  currentEmployee = next;
}

export const employeeDtrSummary = {
  onTimeRatePercent: 0,
  lateCount: 0,
  absentCount: 0,
};

export const employeeThirteenthMonth = {
  accrued: 0,
  asOfLabel: "",
};

export const leaveBalances: LeaveBalance[] = [];

export let payslips: Payslip[] = [];

export function setPayslips(next: Payslip[]) {
  payslips = next;
}

export let announcements: Announcement[] = [];

export function setAnnouncements(next: Announcement[]) {
  announcements = next;
}

export let leaveRequests: LeaveRequest[] = [];

export function setLeaveRequests(next: LeaveRequest[]) {
  leaveRequests = next;
}

export const onLeaveToday: { name: string; initials: string; reason: string }[] = [];

export const attendanceTrend: AttendancePoint[] = [];

export const adminOverviewStats: AdminOverviewStats = {
  totalHeadcount: 0,
  newHiresThisMonth: 0,
  attritionRateYtd: 0,
  separationsYtd: 0,
  openPositions: { total: 0, byDepartment: [] },
  onLeaveToday: 0,
  payrollRunTotal: 0,
  payrollCutoffLabel: "",
};

export const payrollRunSteps: PayrollRunStep[] = [];

export const headcountByOffice: OfficeHeadcount[] = [];

export const payrollCostBreakdown: PayrollCostSegment[] = [];

export let complianceCalendar: ComplianceItem[] = [];

export function setComplianceCalendar(next: ComplianceItem[]) {
  complianceCalendar = next;
}

export let employeeDirectory: Employee[] = [];

export function setEmployeeDirectory(next: Employee[]) {
  employeeDirectory = next;
}

export const onboardingPipeline: OnboardingStage[] = [];

export const workforceAlerts: WorkforceAlert[] = [];

export let employeeBenefits: EmployeeBenefit[] = [];

export function setEmployeeBenefits(next: EmployeeBenefit[]) {
  employeeBenefits = next;
}

export const teamRoster: TeamRosterMember[] = [];

export const jobRequisitions: JobRequisition[] = [];

export const managerTeamStats = {
  teamHeadcount: 0,
  onLeaveToday: 0,
  attendanceRate: 0,
};

export let performanceReviewStatuses: Record<string, "Submitted" | "Pending"> = {};

export function setPerformanceReviewStatuses(next: Record<string, "Submitted" | "Pending">) {
  performanceReviewStatuses = next;
}

const defaultManagerProfile: PartnerProfile = {
  name: "Rafael Ortiz",
  initials: "RO",
  title: "Associate Director",
  email: "rafael.ortiz@msma.ph",
  phone: "+63 917 555 0142",
  office: "Cebu HQ",
  emergencyContact: "",
  about: "",
};

const MANAGER_PROFILE_KEY = "msma-hris-partner-profile";

// The Partner's own profile is the one record in this prototype that
// survives a reload, so the info they enter in Settings sticks.
function loadManagerProfile(): PartnerProfile {
  try {
    const stored = localStorage.getItem(MANAGER_PROFILE_KEY);
    if (stored) return { ...defaultManagerProfile, ...(JSON.parse(stored) as Partial<PartnerProfile>) };
  } catch {
    // Storage blocked or corrupt — fall back to the seed profile.
  }
  return defaultManagerProfile;
}

export let currentManager: PartnerProfile = loadManagerProfile();

export function setCurrentManager(next: PartnerProfile) {
  currentManager = next;
  try {
    localStorage.setItem(MANAGER_PROFILE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: the change still applies for this session.
  }
}

export let attendanceRequests: AttendanceRequest[] = [];

export function setAttendanceRequests(next: AttendanceRequest[]) {
  attendanceRequests = next;
}

export const payrollCutoff = {
  label: "Sept 16–30, 2026",
  payDate: "Sept 30, 2026",
  // Must match the employee-side payslip for the same cutoff so releasing
  // payroll here flips that payslip to Paid.
  payslipId: "PS-2609B",
};

export let payrollEntries: PayrollEntry[] = [];

export function setPayrollEntries(next: PayrollEntry[]) {
  payrollEntries = next;
}

export const myDtrLog: DtrLogEntry[] = [];

// Saved to localStorage so requests survive a refresh and a sign-out (HR handles them later).
const CERTIFICATES_KEY = "heyhr-certificate-requests-v1";

function loadCertificateRequests(): CertificateRequest[] {
  try {
    const raw = localStorage.getItem(CERTIFICATES_KEY);
    if (raw) return JSON.parse(raw) as CertificateRequest[];
  } catch {
    // Blocked or corrupt storage: start empty.
  }
  return [];
}

export let certificateRequests: CertificateRequest[] = loadCertificateRequests();

export function setCertificateRequests(next: CertificateRequest[]) {
  certificateRequests = next;
  try {
    localStorage.setItem(CERTIFICATES_KEY, JSON.stringify(next));
  } catch {
    // Storage full or blocked: kept for this visit.
  }
}

const defaultAdminProfile: AdminProfile = {
  name: "Dinah Marquez",
  initials: "DM",
  title: "HR & People Operations Head",
  email: "dinah.marquez@msma.ph",
  phone: "+63 917 555 0118",
  office: "Cebu HQ",
  emergencyContact: "",
  about: "",
};

const ADMIN_PROFILE_KEY = "msma-hris-admin-profile";

// Like the Partner's, HR's own profile survives a reload so Settings edits stick.
function loadAdminProfile(): AdminProfile {
  try {
    const stored = localStorage.getItem(ADMIN_PROFILE_KEY);
    if (stored) return { ...defaultAdminProfile, ...(JSON.parse(stored) as Partial<AdminProfile>) };
  } catch {
    // Storage blocked or corrupt — fall back to the seed profile.
  }
  return defaultAdminProfile;
}

export let currentAdmin: AdminProfile = loadAdminProfile();

export function setCurrentAdmin(next: AdminProfile) {
  currentAdmin = next;
  try {
    localStorage.setItem(ADMIN_PROFILE_KEY, JSON.stringify(next));
  } catch {
    // Non-fatal: the change still applies for this session.
  }
}

export let offboardingCases: OffboardingCase[] = [];

export function setOffboardingCases(next: OffboardingCase[]) {
  offboardingCases = next;
}

export let companyAssets: CompanyAsset[] = [];

export function setCompanyAssets(next: CompanyAsset[]) {
  companyAssets = next;
}

export let trainingRecords: TrainingRecord[] = [];

export function setTrainingRecords(next: TrainingRecord[]) {
  trainingRecords = next;
}

export let employeeCases: EmployeeCase[] = [];

export function setEmployeeCases(next: EmployeeCase[]) {
  employeeCases = next;
}

export let professionalLicenses: ProfessionalLicense[] = [];

export function setProfessionalLicenses(next: ProfessionalLicense[]) {
  professionalLicenses = next;
}

// --- 201 File: personal profile + pre-employment/identity documents ---
// Full detail here is HR/manager-only; the employee-facing API layer
// projects these down to a status-only checklist before returning them.

export let personnelProfiles: PersonnelProfile[] = [];

export function setPersonnelProfiles(next: PersonnelProfile[]) {
  personnelProfiles = next;
}

const PERSONNEL_DOCUMENT_TYPES: PersonnelDocumentType[] = [
  "Application Form / Resume",
  "Birth Certificate (PSA)",
  "Marriage Certificate (PSA)",
  "Child's Birth Certificate",
  "Valid Government ID",
  "Diploma / Transcript of Records",
  "Professional License",
  "Certificate of Employment (Previous)",
  "NBI Clearance",
  "Police/Barangay Clearance",
  "Pre-Employment Medical Result",
];

export interface NewHireGovernmentId {
  idType: string;
  idNumber?: string;
  idExpiry?: string;
  fileName?: string;
}

/** A fresh 201 checklist for someone just added through the directory:
 * everything Missing (situational documents Not applicable) except the
 * government ID, when HR scanned one while adding them. */
export function buildNewHireDocuments(employeeId: string, governmentId?: NewHireGovernmentId): PersonnelDocument[] {
  const situational: PersonnelDocumentType[] = [
    "Marriage Certificate (PSA)",
    "Child's Birth Certificate",
    "Professional License",
  ];
  const today = new Date().toISOString().slice(0, 10);
  return PERSONNEL_DOCUMENT_TYPES.map((type, i) => {
    const doc: PersonnelDocument = {
      id: `doc-${employeeId}-${i + 1}`,
      employeeId,
      type,
      status: situational.includes(type) ? "Not applicable" : "Missing",
    };
    if (type === "Valid Government ID" && governmentId) {
      return { ...doc, status: "Submitted", uploadedOn: today, ...governmentId };
    }
    return doc;
  });
}

export let personnelDocuments: PersonnelDocument[] = [];

export function setPersonnelDocuments(next: PersonnelDocument[]) {
  personnelDocuments = next;
}

export let auditLogEntries: AuditLogEntry[] = [];

export function setAuditLogEntries(next: AuditLogEntry[]) {
  auditLogEntries = next;
}
