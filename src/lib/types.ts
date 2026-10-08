export type Role = "employee" | "manager" | "admin";

export type Cluster = "RPM" | "VCM" | "ADS";

export interface Employee {
  id: string;
  name: string;
  initials: string;
  position: string;
  department: string;
  office: "Cebu HQ" | "Manila" | "Davao";
  cluster: Cluster;
  status: "Active" | "On leave";
  reportsToId?: string;
  email?: string;
  phone?: string;
  emergencyContact?: string;
  faceEnrolled?: boolean;
}

export interface LeaveBalance {
  type: "Vacation" | "Sick" | "Emergency" | "Bereavement";
  used: number;
  entitlement: number;
}

export interface PayslipLineItem {
  label: string;
  amount: number;
  kind: "earning" | "deduction";
}

export interface Payslip {
  id: string;
  cutoffLabel: string;
  gross: number;
  deductions: number;
  net: number;
  status: "Paid" | "Processing";
  breakdown: PayslipLineItem[];
}

export interface Announcement {
  id: string;
  title: string;
  postedOn: string;
}

export type LeaveType = "Vacation" | "Sick" | "Emergency" | "Bereavement";

export interface LeaveRequest {
  id: string;
  employeeName: string;
  employeeInitials: string;
  employeeRole: string;
  type: LeaveType | "Overtime" | "Certificate of Employment";
  detail: string;
  status: "Pending" | "Approved" | "Declined";
  requestedOn: string;
}

export interface AttendancePoint {
  date: string;
  rate: number;
}

export interface OfficeHeadcount {
  office: "Cebu HQ" | "Manila" | "Davao";
  count: number;
}

export interface PayrollCostSegment {
  label: "Basic pay" | "Statutory" | "Allowances" | "Overtime";
  percent: number;
}

export interface ComplianceItem {
  id: string;
  filing: string;
  agency: "SSS" | "PhilHealth" | "Pag-IBIG" | "BIR";
  due: string;
  status: "Filed" | "Due soon" | "Overdue";
  note?: string;
}

export interface OnboardingStage {
  stage: "Offer accepted" | "Documents submitted" | "Day 1 setup";
  count: number;
}

export interface AdminOverviewStats {
  totalHeadcount: number;
  newHiresThisMonth: number;
  attritionRateYtd: number;
  openPositions: { audit: number; tax: number; legal: number };
  payrollRunTotal: number;
  payrollCutoffLabel: string;
}

export type PayrollRunStepStatus = "done" | "current" | "pending";

export interface PayrollRunStep {
  label: string;
  status: PayrollRunStepStatus;
}

export interface DtrSummary {
  onTimeRatePercent: number;
  lateCount: number;
  absentCount: number;
}

export interface ThirteenthMonthSummary {
  accrued: number;
  asOfLabel: string;
}

export type WorkforceAlertSeverity = "info" | "warn" | "crit";

export type WorkforceAlertCategory = "Punctuality" | "Overtime" | "Attendance" | "Leave pattern";

export interface WorkforceAlert {
  id: string;
  employeeName: string;
  employeeInitials: string;
  category: WorkforceAlertCategory;
  message: string;
  severity: WorkforceAlertSeverity;
  detectedLabel: string;
}

export type BenefitStatus = "Active" | "Pending" | "Not enrolled";

export interface EmployeeBenefit {
  id: string;
  name: string;
  provider: string;
  memberId: string;
  status: BenefitStatus;
}

export interface TeamRosterMember {
  id: string;
  name: string;
  initials: string;
  position: string;
  tenureLabel: string;
  email: string;
  status: "Active" | "On leave";
}

export type RequisitionStage = "Sourcing" | "Interviewing" | "Offer extended";

export interface JobRequisition {
  id: string;
  title: string;
  department: "Audit & Assurance" | "Tax Advisory" | "Corporate Legal" | "Bookkeeping";
  openings: number;
  applicants: number;
  stage: RequisitionStage;
}

export type DtrStatus = "On time" | "Late" | "Absent";
export type WorkLocation = "Onsite" | "Remote";
export type AttendanceMethod = "Fingerprint" | "Face Scan";

export interface DtrLogEntry {
  date: string;
  timeIn: string;
  timeOut: string;
  status: DtrStatus;
  location: WorkLocation;
  method: AttendanceMethod;
}

export type CertificateRequestStatus = "Pending" | "Ready for pickup" | "Released";

export interface CertificateRequest {
  id: string;
  type: string;
  purpose: string;
  status: CertificateRequestStatus;
  requestedOn: string;
}

export type OffboardingStage = "Resignation filed" | "Clearance in progress" | "Final pay released";

export interface OffboardingCase {
  id: string;
  employeeName: string;
  employeeInitials: string;
  department: string;
  lastDay: string;
  stage: OffboardingStage;
}

export type AssetStatus = "Issued" | "Returned" | "Under repair";

export interface CompanyAsset {
  id: string;
  type: string;
  assetTag: string;
  assignedToName: string;
  assignedToInitials: string;
  issuedOn: string;
  status: AssetStatus;
}

export type TrainingStatus = "Not started" | "In progress" | "Completed";

export interface TrainingRecord {
  id: string;
  employeeName: string;
  employeeInitials: string;
  course: string;
  dueDate: string;
  status: TrainingStatus;
}

export type CaseStatus = "Open" | "Under review" | "Resolved";
export type CaseType = "Attendance" | "Conduct" | "Performance" | "Grievance";

export interface EmployeeCase {
  id: string;
  employeeName: string;
  employeeInitials: string;
  type: CaseType;
  filedBy: string;
  status: CaseStatus;
  filedOn: string;
  summary: string;
}

export type CpdStatus = "Compliant" | "In progress" | "Due soon" | "Overdue";

export interface ProfessionalLicense {
  id: string;
  employeeId: string;
  employeeName: string;
  employeeInitials: string;
  licenseType: string;
  licenseNumber: string;
  cpdUnitsEarned: number;
  cpdUnitsRequired: number;
  cycleEndDate: string;
}

// --- 201 File: pre-employment / identity records ---
// Full detail (including the structured fields below) is HR- and
// manager-visible only. Employees see a submission checklist of these same
// document types, without the sensitive fields or the file itself.

export type PersonnelDocumentType =
  | "Application Form / Resume"
  | "Birth Certificate (PSA)"
  | "Marriage Certificate (PSA)"
  | "Child's Birth Certificate"
  | "Valid Government ID"
  | "Diploma / Transcript of Records"
  | "Professional License"
  | "Certificate of Employment (Previous)"
  | "NBI Clearance"
  | "Police/Barangay Clearance"
  | "Pre-Employment Medical Result";

export type PersonnelDocumentStatus = "Missing" | "Submitted" | "Verified" | "Not applicable";

export interface PersonnelDocument {
  id: string;
  employeeId: string;
  type: PersonnelDocumentType;
  status: PersonnelDocumentStatus;
  fileName?: string;
  uploadedOn?: string;
  // Populated only for the document types where it applies.
  idType?: string;
  idNumber?: string;
  idExpiry?: string;
  licenseNumber?: string;
  licenseExpiry?: string;
}

/** The employee-safe projection of a PersonnelDocument — status only, no
 * sensitive fields and no file — used by the employee's own checklist view. */
export interface PersonnelDocumentChecklistItem {
  id: string;
  type: PersonnelDocumentType;
  status: PersonnelDocumentStatus;
  uploadedOn?: string;
  /** The ID or license on file has expired or expires soon. No numbers, just the warning. */
  expiry?: { status: "Due soon" | "Overdue"; note: string };
}

export type CivilStatus = "Single" | "Married" | "Widowed" | "Separated";

export interface Dependent {
  id: string;
  name: string;
  relationship: "Spouse" | "Child";
  birthDate?: string;
}

export interface PersonnelProfile {
  employeeId: string;
  photoDataUrl?: string;
  birthDate?: string;
  civilStatus?: CivilStatus;
  dependents: Dependent[];
}

// --- Audit log for restricted personnel data ---
// Every view, edit, verify, or removal touching a 201 File's sensitive
// fields is recorded here — who did it, to whose record, and when.

export type AuditAction = "Viewed" | "Edited" | "Verified" | "Removed";

export interface AuditLogEntry {
  id: string;
  employeeId: string;
  actorName: string;
  actorRole: "manager" | "admin";
  action: AuditAction;
  target: string;
  detail?: string;
  timestamp: string;
}

// --- Partner-side attendance approvals ---
// DTR exceptions an employee files against their own time record (a missed
// scan, a late arrival with a valid reason, an unscheduled WFH day). Nothing
// here touches the DTR until the Partner approves it.

export type AttendanceRequestKind = "Missed clock-out" | "Missed clock-in" | "Late justification" | "Remote work" | "Time correction";
export type AttendanceRequestStatus = "Pending" | "Approved" | "Declined";

export interface AttendanceRequest {
  id: string;
  employeeName: string;
  employeeInitials: string;
  employeeRole: string;
  kind: AttendanceRequestKind;
  date: string;
  recordedTime: string;
  requestedTime: string;
  reason: string;
  status: AttendanceRequestStatus;
  filedOn: string;
}

// --- Partner profile (Settings) ---

export interface PartnerProfile {
  name: string;
  initials: string;
  title: string;
  email: string;
  phone: string;
  office: Employee["office"];
  emergencyContact: string;
  about: string;
}

// HR's own profile (Settings) has the same shape as the Partner's.
export type AdminProfile = PartnerProfile;

// --- Company payroll register ---
// One entry per employee for the open cutoff. Pay figures are inputs; the
// computed lines (statutory, tax, net) come from lib/payroll.ts.

export type PayrollEntryStatus = "Draft" | "Approved" | "Released";

export interface PayrollEntry {
  employeeId: string;
  monthlyBasic: number;
  allowance: number;
  overtimeHours: number;
  otherDeductions: number;
  status: PayrollEntryStatus;
}
