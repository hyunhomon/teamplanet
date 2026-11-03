import { z } from "zod";
import { consentTokenSchema, courseIdSchema, dateTimeSchema } from "./api";
export const inquirySettingsInputSchema = z.strictObject({ days: z.number().int().positive().safe() });
export const inquirySettingsSchema = z.strictObject({ courseId: courseIdSchema, days: z.number().int().positive().nullable(),
  lastCleanupAt: dateTimeSchema.nullable(), cleanupError: z.literal("INQUIRY_CLEANUP_FAILED").nullable() });
export const inquiryIdentitySchema = z.strictObject({ token: consentTokenSchema });
export const inquirySubmitSchema = z.strictObject({ token: consentTokenSchema, ticket: consentTokenSchema, body: z.string().trim().min(1).max(4000) });
export const inquiryAnswerSchema = z.strictObject({ answer: z.string().trim().min(1).max(4000) });
export const inquiryActionSchema = z.strictObject({ kind: z.enum(["withdrawal", "correction"]) });
export const inquirySchema = z.strictObject({ id: z.string().regex(/^inquiry_[0-9a-f-]{36}$/), body: z.string(), answer: z.string().nullable(),
  receivedAt: dateTimeSchema, days: z.number().int().positive(), expiresAt: dateTimeSchema, answeredAt: dateTimeSchema.nullable() });
export type Inquiry = z.infer<typeof inquirySchema>;
export const inquiryListSchema = z.strictObject({ inquiries: z.array(inquirySchema) });
export const inquiryStudentViewSchema = z.strictObject({ professorEmail: z.email(), days: z.number().int().positive().nullable(),
  proposedExpiresAt: dateTimeSchema.nullable(), ticket: consentTokenSchema.nullable(), ticketExpiresAt: dateTimeSchema.nullable(), inquiries: z.array(inquirySchema) });
export type InquiryStudentView = z.infer<typeof inquiryStudentViewSchema>;
