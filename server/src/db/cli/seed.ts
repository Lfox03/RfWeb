// CLI: development dataset (idempotent, never at startup).
// Usage: npm run db:seed

import { openDatabase } from "../database";
import { seedDatabase } from "../seed";

void (async () => {
    const db = openDatabase();
    try {
        const summary = await seedDatabase(db);
        const empty =
            summary.groupsCreated.length === 0 &&
            summary.studentsCreated.length === 0 &&
            summary.usersCreated.length === 0 &&
            summary.usersRehashed.length === 0;

        if (empty) {
            console.log("[DB:SEED] Data already present — nothing created.");
        } else {
            if (summary.groupsCreated.length) console.log("[DB:SEED] Groups created:", summary.groupsCreated.join(", "));
            if (summary.studentsCreated.length) console.log("[DB:SEED] Students created:", summary.studentsCreated.join(" ; "));
            if (summary.usersCreated.length) console.log("[DB:SEED] Users created:", summary.usersCreated.join(" ; "));
            if (summary.usersRehashed.length) console.log("[DB:SEED] Hash updated:", summary.usersRehashed.join(" ; "));
            console.log("[DB:SEED] Admin account: password = SEED_ADMIN_PASSWORD (default: development password).");
        }
    } finally {
        db.close();
    }
})();
