import { expect, it } from "vitest";
import { parseLibrary } from "@/lib/vault-library";
it("parses phones and past backups and rejects malformed data", () => {
  const ok = parseLibrary({ type: "library", profile: "Vinay", yourProfiles: ["Vinay"], otherProfiles: ["Asha"], owned: true, phones: [{ phone: "Pixel", revoked: false, backups: [{ name: "Full_Bckup_231125", kind: "Full", date: "2025-11-23", complete: true, files: 1, bytes: 9 }, { bad: 1 }] }] });
  expect(ok?.phones[0]?.backups).toHaveLength(1);
  expect(ok?.otherProfiles).toEqual(["Asha"]);
  expect(parseLibrary({ type: "library", yourProfiles: "x" })).toBeNull();
  expect(parseLibrary(null)).toBeNull();
});
