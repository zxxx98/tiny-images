// 生成 web/src/version.ts：版本号 = package.json 的 major.minor + git 提交数作为 patch，
// 每次提交自动 +1。git 不可用时回退为 "<version>-dev"。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

function git(args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const count = Number(git(["rev-list", "--count", "HEAD"])) || 0;
const hash = git(["rev-parse", "--short", "HEAD"]);
const [major, minor] = pkg.version.split(".");
const version = count > 0 ? `v${major}.${minor}.${count}` : `${pkg.version}-dev`;

const content = `// 由 scripts/version.mjs 自动生成，请勿手动编辑。
export const APP_VERSION = ${JSON.stringify(version)};
export const GIT_HASH = ${JSON.stringify(hash || "unknown")};
export const BUILD_NUMBER = ${count};
`;

const target = join(root, "web", "src", "version.ts");
if (!existsSync(target) || readFileSync(target, "utf8") !== content) {
  writeFileSync(target, content);
}
