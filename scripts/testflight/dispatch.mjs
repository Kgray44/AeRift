import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// A single workflow commit runs the exact candidate from protected main.
// Publish is explicit and creates a new, source-bound transport branch.
export function validateInputs({ candidate, mode, version, build }) {
  if (!/^[0-9a-f]{40}(?![\s\S])/.test(candidate ?? "")) throw new Error("AERIFT_CANDIDATE_INVALID");
  if (!["unsigned", "signed", "upload", "observe"].includes(mode)) throw new Error("AERIFT_MODE_INVALID");
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?![\s\S])/.test(version ?? "")) throw new Error("AERIFT_VERSION_INVALID");
  if (!/^[1-9][0-9]{0,3}(\.[0-9]{1,2}){0,2}(?![\s\S])/.test(build ?? "")) throw new Error("AERIFT_BUILD_INVALID");
  return { candidate, mode, version, build };
}

export function renderWorkflow(template, input) {
  const values = validateInputs(input);
  const replacements = {
    __CANDIDATE_SHA__: values.candidate,
    __VERSION__: values.version,
    __BUILD__: values.build,
    __MODE__: values.mode,
    __UPLOAD__: String(values.mode !== "unsigned"),
    __UNSIGNED__: String(values.mode === "unsigned"),
  };
  let result = template;
  for (const [key, value] of Object.entries(replacements)) result = result.replaceAll(key, value);
  if (/__[A-Z_]+__/.test(result)) throw new Error("AERIFT_TEMPLATE_UNRESOLVED");
  return result;
}

export function dispatch(input, { root = process.cwd(), publish = false } = {}) {
  const values = validateInputs(input);
  const git = (args, env = process.env) =>
    execFileSync("git", args, { cwd: root, env, encoding: "utf8", windowsHide: true }).trim();
  git(["cat-file", "-e", `${values.candidate}^{commit}`]);
  if (publish) {
    const remote = git(["remote", "get-url", "--push", "origin"]);
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:)Kgray44\/AeRift(?:\.git)?$/i.test(remote))
      throw new Error("AERIFT_DESTINATION_INVALID");
    git(["fetch", "origin", "refs/heads/main:refs/remotes/origin/main"]);
    git(["merge-base", "--is-ancestor", values.candidate, "refs/remotes/origin/main"]);
  }
  const template = git(["show", `${values.candidate}:.agents/aerift-testflight-hosted.yml`]);
  const workflow = renderWorkflow(template, values);
  const outputRoot = path.join(root, "artifacts", "aerift-testflight");
  mkdirSync(outputRoot, { recursive: true });
  const destination = mkdtempSync(path.join(outputRoot, `${values.mode}-${values.candidate.slice(0, 12)}-`));
  const workflowPath = path.join(destination, "workflow.yml");
  writeFileSync(workflowPath, workflow);
  const receipt = {
    schemaVersion: 1,
    ...values,
    teamId: "X2JZ9N65V2",
    bundleId: "com.kgamazing44.aerift",
    publish,
    physicalInstallationProven: false,
  };
  if (publish) {
    const index = path.join(destination, "owned-index");
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
      git(["read-tree", values.candidate], env);
      const blob = git(["hash-object", "-w", workflowPath], env);
      git(["update-index", "--add", "--cacheinfo", `100644,${blob},.github/workflows/aerift-testflight.yml`], env);
      const tree = git(["write-tree"], env);
      const transport = git(
        [
          "commit-tree",
          tree,
          "-p",
          values.candidate,
          "-m",
          `Run isolated NCL-01 ${values.mode} for ${values.candidate}`,
        ],
        env,
      );
      if (git(["diff", "--name-only", values.candidate, transport], env) !== ".github/workflows/aerift-testflight.yml")
        throw new Error("AERIFT_TRANSPORT_SCOPE_INVALID");
      const branch = `codex/aerift-testflight-${values.mode}-${values.candidate.slice(0, 12)}-${Date.now()}`;
      git(["push", "origin", `${transport}:refs/heads/${branch}`], env);
      Object.assign(receipt, { transportSha: transport, transportTree: tree, branch, cleanup: "PENDING" });
    } finally {
      rmSync(index, { force: true });
    }
  }
  writeFileSync(path.join(destination, "dispatch.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return { ...receipt, receiptPath: path.join(destination, "dispatch.json") };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    const [candidate, mode, version, build, flag] = process.argv.slice(2);
    if (flag && flag !== "--publish") throw new Error("AERIFT_OPTION_INVALID");
    console.log(
      JSON.stringify(dispatch({ candidate, mode, version, build }, { publish: flag === "--publish" }), null, 2),
    );
  } catch (error) {
    console.error(
      error instanceof Error && /^AERIFT_[A-Z_]+$/.test(error.message) ? error.message : "AERIFT_DISPATCH_FAILED",
    );
    process.exitCode = 1;
  }
}
