import assert from "node:assert/strict";
import test from "node:test";
import { permissionPolicyAnswer } from "../src/lib/permissions";

/*
 * A read-only seat answers a search with "once" and no card, so the judge has
 * to see a flag the way the program will see it. A POSIX shell takes a
 * backslash off whatever it escapes and takes quotes off, so `\-delete`,
 * `'-delete'` and `-de''lete` all reach find as `-delete`. The judge kept the
 * backslash and tested find's flags on the raw token: each of these was
 * answered "once" and, run under bash, deleted, wrote or ran something.
 */
const answer = (detail: string) => permissionPolicyAnswer({ mode: "ask", sandbox: "read-only", tool: "Bash", detail });

test("a flag behind a backslash or in quotes is the flag it becomes", () => {
  for (const detail of [
    "find /tmp/x \\-delete",
    "find /tmp/x '-delete'",
    'find /tmp/x "-delete"',
    "find /tmp/x -de''lete",
    "find /tmp/x \\-exec touch marker \\;",
    "sort \\-o out.txt in.txt",
    "sort '-o' out.txt in.txt",
    "awk \\-f evil.awk in.txt",
    "rg \\--pre pre.sh pattern dir",
    "rg '--pre' pre.sh pattern dir",
    "git fetch \\--upload-pack=evil.sh origin",
    "git \\-c core.pager=evil log",
    "git log \\--output=out.txt",
    "sed \\-i s/a/b/ file.txt",
  ]) {
    assert.equal(answer(detail), "deny", detail);
  }
});

test("a program name behind a backslash is the program it runs", () => {
  assert.equal(answer("r\\m -rf /tmp/x"), "deny");
  // Read literally, as a Windows shell would, `c\at` is no program on the read
  // list, so it is not a search under both readings and gets no free pass.
  assert.notEqual(answer("c\\at file.txt"), "once");
});

test("a Windows path to a writing program is still a write", () => {
  assert.equal(answer("C:\\Windows\\System32\\cmd.exe /c del x"), "deny");
});

test("ordinary sed reads pass: a range to the last line, a stray semicolon, regex ranges", () => {
  for (const detail of ["sed -n '1,$p' file.txt", "sed -n 'p;' file.txt", "sed -n '/start/,/end/p' file.txt", "sed -n '1,20p' file.txt"]) {
    assert.equal(answer(detail), "once", detail);
  }
  // A write command at the end of a range is still a write.
  assert.equal(answer("sed -n '1,$w out.txt' file.txt"), "deny");
});

test("ordinary awk reads pass: comparisons, a logical or, and a word inside a string", () => {
  for (const detail of [
    "awk '$1 > 10' file.txt",
    "awk 'NR==1 || NR==2' file.txt",
    "awk '{print \"execution\"}' file.txt",
    "awk '{print $1}' file.txt",
    "awk -F , '{print $2}' file.csv",
  ]) {
    assert.equal(answer(detail), "once", detail);
  }
});

test("awk still refuses every way out of its program", () => {
  for (const detail of [
    "awk '{print > \"out\"}' file.txt",
    "awk '{print $1 > 2}' file.txt",
    "awk '{printf \"%s\", $1 > \"f\"}' file.txt",
    "awk '{print | \"sh\"}' file.txt",
    "awk '{print \"a\" | \"sh\"}' file.txt",
    "awk '$1 ||| 2' file.txt",
    "awk 'BEGIN{system(\"touch x\")}'",
    "awk '\"\\\"\" system(\"x\")'",
    "awk 'BEGIN{while((\"ls\" | getline x) > 0) print x}'",
    // An indirect call reaches system through a name built out of strings, so
    // emptying the strings must not open it: any `@` is refused.
    "awk 'BEGIN{f=\"sys\" \"tem\"; @f(\"touch x\")}'",
    "awk '{print \"unclosed}' file.txt",
  ]) {
    assert.notEqual(answer(detail), "once", detail);
  }
});

test("the plain reads the seat exists for still pass", () => {
  for (const detail of ["find . -name '*.ts'", "rg -n pattern src", "sort in.txt", "git log --oneline -5", 'grep "a\\|b" test | head -40', "pwd"]) {
    assert.equal(answer(detail), "once", detail);
  }
});
