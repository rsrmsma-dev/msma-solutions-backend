// Core HR / 201 Files — the HR-owned employee master record and the
// organization it sits in. Mock data for now; every type is shaped like the
// API payload it will eventually come from.

import type { PersonnelDocumentStatus, PersonnelDocumentType } from "../types";

// ---- Organization ----

export type UnitType = "company" | "branch" | "department" | "team";

export interface OrgUnit {
  id: string;
  type: UnitType;
  name: string;
  /** Short code shown in tables and IDs, e.g. "CEB", "TAX". */
  code: string;
  parentId: string | null;
  headEmployeeId?: string;
  /** Branches only. */
  address?: string;
  active: boolean;
}

// ---- Positions ----

export const JOB_LEVELS = ["Rank and file", "Supervisor", "Manager", "Executive"] as const;
export type JobLevel = (typeof JOB_LEVELS)[number];

/** BRD v1.1 New Employees Template: PROBATIONARY, REGULAR, FIXED_TERM. */
export const EMPLOYMENT_TYPES = ["Probationary", "Regular", "Fixed-term"] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

export interface Position {
  id: string;
  title: string;
  code: string;
  departmentId: string;
  level: JobLevel;
  /** The type new hires into this position usually start on. */
  employmentType: EmploymentType;
  /** Budgeted headcount. */
  slots: number;
  reportsToPositionId?: string;
  description?: string;
  active: boolean;
}

// ---- Employee master record ----

export const EMPLOYMENT_STATUSES = ["Active", "On leave", "Suspended", "Separated"] as const;
export type EmploymentStatus = (typeof EMPLOYMENT_STATUSES)[number];

export const CIVIL_STATUSES = ["Single", "Married", "Widowed", "Separated"] as const;
export type CivilStatus = (typeof CIVIL_STATUSES)[number];

export interface PersonalInfo {
  firstName: string;
  middleName: string;
  lastName: string;
  suffix: string;
  birthDate: string;
  sex: "Male" | "Female" | "";
  civilStatus: CivilStatus | "";
  nationality: string;
}

export interface ContactInfo {
  workEmail: string;
  personalEmail: string;
  mobile: string;
  address: string;
  city: string;
  province: string;
  emergencyName: string;
  emergencyRelationship: string;
  emergencyPhone: string;
}

export interface GovernmentNumbers {
  sss: string;
  philhealth: string;
  pagibig: string;
  tin: string;
}

export interface JobInfo {
  positionId: string;
  /** A team, or the department itself when they aren't in a team. */
  unitId: string;
  supervisorId?: string;
  employmentType: EmploymentType;
  status: EmploymentStatus;
  dateHired: string;
  regularizationDate?: string;
  separationDate?: string;
  monthlySalary: number;
  workSchedule: string;
}

export interface CoreEmployee {
  id: string;
  personal: PersonalInfo;
  contact: ContactInfo;
  government: GovernmentNumbers;
  job: JobInfo;
  createdAt: string;
  /** Face template enrolled, so they can clock in from home with a face scan. */
  faceEnrolled?: boolean;
}

// ---- Documents ----

export type DocumentType = PersonnelDocumentType;
export type DocumentStatus = PersonnelDocumentStatus;

export interface EmployeeDocument {
  id: string;
  employeeId: string;
  type: DocumentType;
  status: DocumentStatus;
  fileName?: string;
  uploadedAt?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  /** IDs and licenses. */
  referenceNo?: string;
  /** For government IDs: UMID, Passport… */
  idType?: string;
  expiresOn?: string;
  note?: string;
}

// ---- Employment history ----

export const CHANGE_KINDS = [
  "Promotion",
  "Transfer",
  "Salary adjustment",
  "Regularization",
  "Supervisor change",
  "Status change",
  "Separation",
] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export type EventKind = "Hired" | ChangeKind;

export interface FieldChange {
  label: string;
  from?: string;
  to: string;
}

export interface JobEvent {
  id: string;
  employeeId: string;
  kind: EventKind;
  effectiveDate: string;
  changes: FieldChange[];
  remarks?: string;
  recordedBy: string;
  recordedAt: string;
}

// ---- Audit trail ----

export interface AuditEntry {
  id: string;
  employeeId: string;
  actor: string;
  action: "Created" | "Edited" | "Viewed" | "Uploaded" | "Verified" | "Recorded";
  section: string;
  summary: string;
  at: string;
}
