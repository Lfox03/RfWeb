// Account management (Phase 5) — api:verify section 13
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { Client, ok, REMOTE_HEADERS } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { admin, anon, base, userRepository } = ctx;
    let res: ApiResponse;

    console.log("── 13. Account management (Phase 5) ──");
    res = await new Client(base, REMOTE_HEADERS).call("GET", "/api/users");
    ok("GET /api/users sans session (distant) → 401", res.status === 401 && res.body.error.code === "NOT_AUTHENTICATED");

    const boss = new Client(base);
    res = await boss.call("POST", "/api/auth/login", { username: "prof2", password: "prof2-pass-123" });
    ok("nouveau login teacher (prof2) → 200", res.status === 200);
    res = await boss.call("GET", "/api/users");
    ok("teacher GET /api/users → 403 FORBIDDEN", res.status === 403 && res.body.error.code === "FORBIDDEN");
    const prof2row = userRepository.findByUsername("prof2")!;
    res = await boss.call("PATCH", `/api/users/${prof2row.id}`, { role: "admin" });
    ok("teacher PATCH rôle → 403", res.status === 403 && res.body.error.code === "FORBIDDEN");
    res = await boss.call("PATCH", `/api/users/${prof2row.id}`, { password: "quelque-chose-123" });
    ok("teacher PATCH mot de passe → 403", res.status === 403);

    res = await admin.call("POST", "/api/users", { username: "boss1", password: "boss1-pass-123", role: "admin" });
    ok("admin crée un admin → 201 (rôle admin)", res.status === 201 && res.body.data.role === "admin");
    const boss1 = userRepository.findByUsername("boss1")!;
    ok(
        "mot de passe stocké en hash scrypt, jamais en clair",
        boss1.password_hash.startsWith("scrypt$") && !boss1.password_hash.includes("boss1-pass-123"),
    );
    res = await admin.call("GET", "/api/users");
    const userRows = res.body.data as any[];
    ok(
        "liste : jamais de password_hash, métadonnées présentes",
        res.status === 200 &&
            userRows.every((u) => u.password_hash === undefined && typeof u.created_at === "string" && typeof u.updated_at === "string"),
    );
    res = await admin.call("POST", "/api/users", { username: "extra", password: "12345678", role: "teacher", extra: 1 });
    ok("champ inconnu dans le corps → 400", res.status === 400);
    res = await admin.call("PATCH", "/api/users/999999", { role: "teacher" });
    ok("PATCH utilisateur inconnu → 404", res.status === 404 && res.body.error.code === "NOT_FOUND");
    res = await admin.call("PATCH", `/api/users/${boss1.id}`, { role: "root" });
    ok("rôle invalide → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
    res = await admin.call("PATCH", `/api/users/${boss1.id}`, { password: "court" });
    ok("mot de passe de réinitialisation trop court → 400", res.status === 400);

    res = await admin.call("PATCH", `/api/users/${boss1.id}`, { role: "teacher" });
    ok("admin change le rôle admin→teacher → 200", res.status === 200 && res.body.data.role === "teacher");
    res = await admin.call("PATCH", `/api/users/${boss1.id}`, { role: "admin" });
    ok("admin re-promeut teacher→admin → 200", res.status === 200 && res.body.data.role === "admin");

    // Anti self-lockout: an admin cannot demote themselves.
    const rootRow = userRepository.findByUsername("root")!;
    res = await admin.call("PATCH", `/api/users/${rootRow.id}`, { role: "teacher" });
    ok("auto-rétrogradation refusée → 409 SELF_ROLE_CHANGE", res.status === 409 && res.body.error.code === "SELF_ROLE_CHANGE");
    res = await admin.call("PATCH", `/api/users/${rootRow.id}`, { role: "admin" });
    ok("PATCH même rôle sur soi (aucun effet) → 200", res.status === 200);

    // Role changes apply immediately to ongoing sessions
    // (the user is reloaded on every request).
    const boss1c = new Client(base);
    res = await boss1c.call("POST", "/api/auth/login", { username: "boss1", password: "boss1-pass-123" });
    ok("nouveau login admin (boss1) → 200", res.status === 200);
    res = await boss1c.call("GET", "/api/users");
    ok("boss1 admin : GET /api/users → 200", res.status === 200);
    await admin.call("PATCH", `/api/users/${boss1.id}`, { role: "teacher" });
    res = await boss1c.call("GET", "/api/users");
    ok("admin rétrogradé : cookie actif perd les droits admin immédiatement", res.status === 403);

    // Reset by an admin = the target's sessions are invalidated.
    res = await admin.call("PATCH", `/api/users/${boss1.id}`, { password: "boss1-nouveau-123" });
    ok("admin réinitialise le mot de passe d'un autre → 200", res.status === 200);
    res = await boss1c.call("GET", "/api/auth/me");
    ok("session en cours de la cible invalidée → 401", res.status === 401);
    res = await boss1c.call("POST", "/api/auth/login", { username: "boss1", password: "boss1-pass-123" });
    ok("ancien mot de passe refusé après réinitialisation", res.status === 401);
    res = await boss1c.call("POST", "/api/auth/login", { username: "boss1", password: "boss1-nouveau-123" });
    ok("nouveau mot de passe accepté après réinitialisation", res.status === 200);

    // An admin resetting their own password keeps their own session.
    res = await admin.call("PATCH", `/api/users/${rootRow.id}`, { password: "root-pass-456" });
    ok("admin réinitialise son propre mot de passe → 200", res.status === 200);
    res = await admin.call("GET", "/api/auth/me");
    ok("session de l'admin préservée après sa propre réinitialisation", res.status === 200);
    res = await admin.call("PATCH", `/api/users/${rootRow.id}`, { password: "root-pass-123" });
    ok("mot de passe racine restauré (état de la suite)", res.status === 200);
    res = await anon.call("POST", "/api/auth/login", { username: "root", password: "root-pass-123" });
    ok("mot de passe racine d'origine de nouveau valide", res.status === 200);
}
