// Student CSV import — api:verify section 16
// Moved verbatim from verifyApi.ts — shared state flows through ctx (see ../context.ts).

import { ok } from "../helpers";
import type { ApiResponse } from "../helpers";
import type { VerifyContext } from "../context";

export async function run(ctx: VerifyContext): Promise<void> {
    const { alan, base, teacher } = ctx;
    let res: ApiResponse;

    console.log("── 16. Student CSV import ──");
    // Raw POST as text/csv (the file is sent as is, parsed server-side).
    const importCsv = async (body: string): Promise<ApiResponse> => {
        const r = await fetch(`${base}/api/students/import`, {
            method: "POST",
            headers: { "content-type": "text/csv", cookie: teacher.cookie! },
            body,
        });
        let parsed: any = null;
        const t = await r.text();
        if (t) {
            try {
                parsed = JSON.parse(t);
            } catch {
                /* empty response */
            }
        }
        return { status: r.status, body: parsed };
    };

    res = await importCsv("");
    ok("import CSV sans contenu → 400 VALIDATION_ERROR", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");
    res = await importCsv("prénom,mail\nMarie,marie@ex.io");
    ok("import CSV sans colonne « nom » → 400", res.status === 400 && res.body.error.code === "VALIDATION_ERROR");

    // Active card held by another student ("card already assigned" case).
    await teacher.call("POST", `/api/students/${alan.id}/card`, { uid: "8000009" });

    res = await importCsv(
        "prénom,nom,groupe,email,id\n" +
            "Marie,Curie,G-IMP,marie@ex.io,8000001\n" +
            "Jean,,G1-bis,,\n" +
            "Georges,Dumont,,,8000009\n" +
            ",Dupont,,bad@\n" +
            "Zoe,Zolette,,,\n",
    );
    ok(
        "import CSV valide → 200 (2 importés, 3 ignorés, groupe G-IMP créé)",
        res.status === 200 &&
            res.body.data.imported === 2 &&
            res.body.data.skipped === 3 &&
            (res.body.data.groups_created as string[]).includes("G-IMP"),
    );
    ok(
        "import CSV : erreurs explicites (nom manquant, carte déjà attribuée)",
        (res.body.data.errors as any[]).some((e) => /Prénom et nom/.test(e.message)) &&
            (res.body.data.errors as any[]).some((e) => /déjà attribuée/.test(e.message)),
    );

    res = await teacher.call("GET", "/api/groups");
    const gImp = (res.body.data as any[]).find((g) => g.name === "G-IMP");
    ok("import CSV : le groupe inexistant a été créé", gImp !== undefined);
    res = await teacher.call("GET", "/api/students");
    const marie = (res.body.data as any[]).find((s) => s.first_name === "Marie" && s.last_name === "Curie");
    ok(
        "import CSV : étudiante créée avec groupe et e-mail",
        marie !== undefined && marie.group_id === gImp.id && marie.email === "marie@ex.io",
    );
    res = await teacher.call("GET", "/api/students/by-card/8000001");
    ok("import CSV : la carte « id » est attribuée à l'étudiante importée", res.status === 200 && res.body.data.id === marie.id);

    res = await importCsv("prénom,nom,id\nMauvais,Uid,ABC12X\n");
    ok(
        "import CSV : UID de carte non décimal → ligne ignorée",
        res.status === 200 &&
            res.body.data.imported === 0 &&
            res.body.data.skipped === 1 &&
            /UID/.test((res.body.data.errors as any[])[0].message),
    );

    // UTF-8 BOM + semicolon separator (French Excel export) + header case.
    res = await importCsv("\uFEFFPrénom;Nom;Groupe;Email;Id\nYves;Martin;G-IMP2;;8000002\n");
    ok(
        "import CSV : BOM + « ; » + en-tête en majuscules acceptés",
        res.status === 200 &&
            res.body.data.imported === 1 &&
            (res.body.data.groups_created as string[]).includes("G-IMP2"),
    );

    res = await importCsv("prénom,nom,id\nMarie,Curie,8000001\n");
    ok(
        "re-import de la même carte : ligne ignorée (déjà attribuée)",
        res.status === 200 && res.body.data.imported === 0 && res.body.data.skipped === 1,
    );
    const importAnon = await fetch(`${base}/api/students/import`, { method: "POST", headers: { "content-type": "text/csv" }, body: "prénom,nom\nA,B" });
    ok("import CSV sans session → 401", importAnon.status === 401);
}
