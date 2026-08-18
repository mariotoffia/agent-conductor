// Toggles the proposed-API ("rich") manifest for sideload VSIX builds.
//   node scripts/gen-rich-manifest.mjs            → back up + inject proposals
//   node scripts/gen-rich-manifest.mjs --restore  → restore the stable manifest
import { copyFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const PKG = "package.json";
const BAK = "package.json.stable.bak";

if (process.argv.includes("--restore")) {
  if (existsSync(BAK)) {
    copyFileSync(BAK, PKG);
    unlinkSync(BAK);
    console.log("restored stable manifest");
  }
  process.exit(0);
}

copyFileSync(PKG, BAK);
const pkg = JSON.parse(readFileSync(PKG, "utf8"));
pkg.enabledApiProposals = ["chatSessionsProvider", "chatParticipantAdditions"];
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n");
console.log("rich manifest active (proposed APIs enabled) — restore before committing");
