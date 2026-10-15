import { SESSION_STATUS_LABEL } from "../../lib/format";
import type { SessionStatus } from "../../types/domain";

// Session status badge. Always carries the French label (never color-only).
export function StatusBadge({ status }: { status: SessionStatus }) {
    return <span className={`badge badge--${status}`}>{SESSION_STATUS_LABEL[status]}</span>;
}
