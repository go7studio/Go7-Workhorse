import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "win32") process.exit(0);

const source = path.join(root, "electron", "windows-dictation.cs");
const output = path.join(root, "build", "windows-dictation.exe");
const sourceTime = fs.statSync(source).mtimeMs;
if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= sourceTime) process.exit(0);

const windows = process.env.WINDIR || "C:\\Windows";
const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
const csc = path.join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const speech = [
  path.join(programFilesX86, "Reference Assemblies", "Microsoft", "Framework", ".NETFramework", "v4.8", "System.Speech.dll"),
  path.join(windows, "Microsoft.NET", "Framework64", "v4.0.30319", "WPF", "System.Speech.dll"),
  path.join(windows, "Microsoft.NET", "Framework", "v4.0.30319", "WPF", "System.Speech.dll"),
].find((file) => fs.existsSync(file));

if (!fs.existsSync(csc) || !speech) {
  console.error("Windows dictation needs the .NET Framework compiler and System.Speech.dll.");
  process.exit(1);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
execFileSync(
  csc,
  ["/nologo", "/optimize+", "/target:winexe", `/out:${output}`, `/reference:${speech}`, source],
  { stdio: "inherit" },
);
