import { z } from "zod";
import { CIVIL_STATUSES, EMPLOYMENT_TYPES } from "./types";

const digits = (s: string) => s.replace(/\D/g, "");
const optionalPattern = (n: number[], label: string) =>
  z
    .string()
    .trim()
    .refine((s) => !s || n.includes(digits(s).length), `${label} should have ${n.join(" or ")} digits`);

export const governmentSchema = z.object({
  sss: optionalPattern([10], "SSS number"),
  philhealth: optionalPattern([12], "PhilHealth number"),
  pagibig: optionalPattern([12], "Pag-IBIG MID"),
  tin: optionalPattern([9, 12], "TIN"),
});

const today = () => new Date().toISOString().slice(0, 10);

// Rules from the New Employees Template (BRD v1.1, 11.2.1); the database enforces the same ones.
const NAME = /^[\p{L} .'-]+$/u;
const name = (label: string) => z.string().trim().max(50, `${label} can be at most 50 characters`).refine((s) => !s || NAME.test(s), `${label} can only have letters`);
const yearsAgo = (n: number) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
};
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export const personalSchema = z.object({
  firstName: name("First name").refine((s) => s.length > 0, "First name is required"),
  middleName: name("Middle name"),
  lastName: name("Last name").refine((s) => s.length > 0, "Last name is required"),
  suffix: z.string().trim(),
  birthDate: z
    .string()
    .min(1, "Birth date is required")
    .refine((s) => s <= today(), "Birth date can't be in the future")
    .refine((s) => s <= yearsAgo(18), "Employee must be at least 18 years old"),
  sex: z.enum(["Male", "Female", ""]).refine((s) => s.length > 0, "Choose the sex"),
  civilStatus: z.union([z.enum(CIVIL_STATUSES), z.literal("")]).refine((s) => s.length > 0, "Choose the civil status"),
  nationality: z.string().trim(),
});

const phone = z
  .string()
  .trim()
  .refine((s) => !s || /^(\+?63|0)?9\d{9}$/.test(s.replace(/[\s-]/g, "")), "Use a PH mobile number, e.g. 0917 123 4567");

const required = (label: string) => z.string().trim().min(1, `${label} is required`);
const requiredPhone = (label: string) => phone.refine((s) => s.length > 0, `${label} is required`);

/** A new hire must have full contact details; existing records may still have gaps. */
/** Every contact detail is required, both when hiring and when editing later. */
export const contactSchema = z.object({
  workEmail: z.string().trim().min(1, "Work email is required").max(100, "Email can be at most 100 characters").email("Enter a valid email"),
  personalEmail: z.string().trim().min(1, "Personal email is required").email("Enter a valid email"),
  mobile: requiredPhone("Mobile number"),
  address: required("Home address"),
  city: required("City / municipality"),
  province: required("Province"),
  emergencyName: required("Emergency contact"),
  emergencyRelationship: required("Relationship"),
  emergencyPhone: requiredPhone("Emergency phone"),
});
export const newHireContactSchema = contactSchema;

/** At least one government number, so payroll and remittances can start. */
export const newHireGovernmentSchema = governmentSchema.superRefine((g, ctx) => {
  if (!g.sss && !g.philhealth && !g.pagibig && !g.tin) ctx.addIssue({ code: "custom", path: ["sss"], message: "Enter at least one: SSS, PhilHealth, Pag-IBIG or TIN" });
});

export const CLUSTERS = ["RPM", "VCM", "ADS"] as const;

export const newHireJobSchema = z.object({
  cluster: z.string().refine((s) => (CLUSTERS as readonly string[]).includes(s), "Choose RPM, VCM or ADS"),
  positionId: z.string().min(1, "Choose a position"),
  teamId: z.string(),
  supervisorId: z.string(),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  dateHired: z.string().min(1, "Date hired is required").refine((s) => s <= daysFromNow(30), "Date hired can't be more than 30 days ahead"),
  monthlySalary: z.number({ error: "Enter the monthly salary" }).positive("Enter the monthly salary"),
  workSchedule: z.string().trim().min(1, "Choose the work schedule"),
  /** The Timekeeping shift behind the schedule, so attendance uses it from day one. */
  shiftId: z.string(),
});

export const newEmployeeSchema = z.object({
  personal: personalSchema,
  contact: newHireContactSchema,
  government: newHireGovernmentSchema,
  job: newHireJobSchema,
});


export type NewEmployeeValues = z.output<typeof newEmployeeSchema>;
export type PersonalValues = z.infer<typeof personalSchema>;
export type ContactValues = z.infer<typeof contactSchema>;
export type GovernmentValues = z.infer<typeof governmentSchema>;

/** First zod issue as a plain message, for API-side validation errors. */
export function firstIssue(result: { success: false; error: z.ZodError }) {
  return result.error.issues[0]?.message ?? "Check the form";
}
