// Minimal dependency-free CSV parser (RFC 4180) — quoted fields,
// doubled quotes, auto-detected delimiter (comma, semicolon or
// tab), UTF-8 BOM and CRLF/LF/CR line endings tolerated.
// Used by the student import.

export interface CsvRecord {
    /** Physical line number (1-based) where the record starts. */
    line: number;
    values: string[];
}

// The delimiter is guessed on the first physical line: the one that
// appears most often there (French Excel exports use ";").
export function detectDelimiter(text: string): string {
    let firstLine = text;
    const breakIdx = text.search(/[\n\r]/);
    if (breakIdx !== -1) firstLine = text.slice(0, breakIdx);
    const candidates = [",", ";", "\t"];
    let best = ",";
    let bestCount = 0;
    for (const candidate of candidates) {
        const count = firstLine.split(candidate).length - 1;
        if (count > bestCount) {
            best = candidate;
            bestCount = count;
        }
    }
    return best;
}

export function parseCsv(text: string): CsvRecord[] {
    const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const delimiter = detectDelimiter(input);
    const records: CsvRecord[] = [];

    let values: string[] = [];
    let field = "";
    let inQuotes = false;
    let line = 1;
    // Starting line of the current record (null = no character seen yet).
    let recordLine: number | null = null;

    const endRecord = (): void => {
        if (recordLine !== null) {
            values.push(field);
            records.push({ line: recordLine, values });
        }
        values = [];
        field = "";
        recordLine = null;
    };

    for (let i = 0; i < input.length; i++) {
        const c = input[i];
        if (inQuotes) {
            if (c === '"') {
                if (input[i + 1] === '"') {
                    field += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                if (c === "\n") line++;
                field += c;
            }
            continue;
        }
        if (c === '"' && field === "") {
            if (recordLine === null) recordLine = line;
            inQuotes = true;
        } else if (c === delimiter) {
            if (recordLine === null) recordLine = line;
            values.push(field);
            field = "";
        } else if (c === "\r") {
            if (input[i + 1] === "\n") i++;
            endRecord();
            line++;
        } else if (c === "\n") {
            endRecord();
            line++;
        } else {
            if (recordLine === null) recordLine = line;
            field += c;
        }
    }
    if (recordLine !== null || field !== "") endRecord();
    return records;
}
