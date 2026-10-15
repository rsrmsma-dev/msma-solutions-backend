// The wording of each certificate HR issues, and the copy filed when it's issued. Kept here (not
// in the print templates) so issuing can save the exact text: HR's copy and the employee's
// download are the same document, even if the employee's record changes later.

import { escapeHtml } from "./printDocument";
import type { CertificateRequest, Employee } from "./types";

/** The certificate's statement, made from the employee's record (every value escaped). */
export function certificateStatement(employee: Employee, type: string) {
  return type === "Certificate of Employment"
    ? `This is to certify that <strong>${escapeHtml(employee.name)}</strong> (Employee ID ${escapeHtml(employee.id)}) is an employee of MSMA Group in ${escapeHtml(employee.status).toLowerCase()} status, holding the position of <strong>${escapeHtml(employee.position)}</strong> under the ${escapeHtml(employee.department)} department, ${escapeHtml(employee.cluster)}, ${escapeHtml(employee.office)} office.`
    : type === "Certificate of Tax Withheld (2316)"
      ? `This certifies that BIR Form 2316 for <strong>${escapeHtml(employee.name)}</strong> (Employee ID ${escapeHtml(employee.id)}) has been prepared and released by MSMA Group for the applicable taxable year.`
      : `This is to certify that <strong>${escapeHtml(employee.name)}</strong> (Employee ID ${escapeHtml(employee.id)}) is employed with MSMA Group as <strong>${escapeHtml(employee.position)}</strong>, ${escapeHtml(employee.department)} department.`;
}

const PREFIX: Record<string, string> = { "Certificate of Employment": "COE", "Certificate of Tax Withheld (2316)": "BIR2316", "Employment Verification Letter": "EVL" };

/** The next certificate number for this type and year, e.g. COE-2026-0003. */
export function nextCertificateNumber(type: string, all: CertificateRequest[]) {
  const prefix = `${PREFIX[type] ?? "CERT"}-${new Date().getFullYear()}-`;
  const used = all
    .map((r) => r.issued?.number)
    .filter((n): n is string => !!n?.startsWith(prefix))
    .map((n) => Number(n.slice(prefix.length)) || 0);
  return `${prefix}${String(Math.max(0, ...used) + 1).padStart(4, "0")}`;
}

/** The copy filed with the request when HR issues it. */
export function fileCertificate(employee: Employee, request: CertificateRequest, all: CertificateRequest[], actor: string): NonNullable<CertificateRequest["issued"]> {
  return {
    number: nextCertificateNumber(request.type, all),
    statement: certificateStatement(employee, request.type),
    purpose: request.purpose,
    issuedAt: new Date().toISOString(),
    issuedBy: actor,
  };
}
