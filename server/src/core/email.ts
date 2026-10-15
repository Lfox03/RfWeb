// E-mail address validation — deliberately simple check (not the full
// RFC 5322): shared between the API (validate.ts) and the CSV import.

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const EMAIL_MAX_LENGTH = 254;

export function isEmail(value: string): boolean {
    return EMAIL_PATTERN.test(value);
}
